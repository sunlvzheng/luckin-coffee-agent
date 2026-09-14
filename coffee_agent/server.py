"""薄桥接服务：把浏览器和本机 luckin CLI / 大模型接起来。

这里**没有业务逻辑** —— Agent 循环、工具定义、提示词全在 `docs/core/` 里，
浏览器加载的就是同一份心核。服务端只负责三件浏览器做不到的事：

    POST /api/invoke   执行一条白名单命令（真实调用 luckin.exe）
    POST /api/llm      转发 OpenAI 兼容请求（模型 Key 留在服务端，浏览器拿不到）
    POST /api/qr       生成支付二维码（segno）
    GET  /api/status   告诉前端本机能力状态

同时把 docs/ 当作静态站点托管，所以本地版和 GitHub Pages 版是同一个页面。

安全提醒：默认不允许任何跨域请求（同源即可）。要让托管在别处的静态页连过来，
需要在 .env 里显式配置 WEB_ALLOW_ORIGINS，并强烈建议同时设置 WEB_PASSWORD。
"""

from __future__ import annotations

import mimetypes
import os
import platform
import threading
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Coroutine

import httpx
import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .luckin_cli import LuckinCLI, LuckinError
from .settings import (
    DOCS_DIR,
    Settings,
    install_command,
    load_settings,
    luckin_token_present,
    openai_base,
)

# Windows 注册表常把 .js 映射成 text/plain，会导致浏览器拒绝加载 ES Module，这里强制纠正
for _suffix, _mime in (
    (".js", "text/javascript"),
    (".mjs", "text/javascript"),
    (".css", "text/css"),
    (".json", "application/json"),
    (".svg", "image/svg+xml"),
):
    mimetypes.add_type(_mime, _suffix)

# --------------------------------------------------------------------------- #
# 白名单命令 → luckin CLI
# --------------------------------------------------------------------------- #
Command = Callable[[LuckinCLI, dict], Coroutine[Any, Any, Any]]


async def _stores(cli: LuckinCLI, args: dict) -> Any:
    return await cli.stores(float(args["latitude"]), float(args["longitude"]), args.get("keyword"))


async def _search_products(cli: LuckinCLI, args: dict) -> Any:
    return await cli.search_products(args["deptId"], args["query"])


async def _preview_order(cli: LuckinCLI, args: dict) -> Any:
    return await cli.preview_order(args["deptId"], args["items"])


async def _create_order(cli: LuckinCLI, args: dict) -> Any:
    return await cli.create_order(
        args["deptId"],
        args["items"],
        float(args["latitude"]),
        float(args["longitude"]),
        args.get("coupons"),
    )


async def _order_detail(cli: LuckinCLI, args: dict) -> Any:
    return await cli.order_detail(args["orderId"])


async def _cancel_order(cli: LuckinCLI, args: dict) -> Any:
    ok, message = await cli.cancel_order(args["orderId"])
    return {"ok": ok, "message": message}


COMMANDS: dict[str, Command] = {
    "stores": _stores,
    "searchProducts": _search_products,
    "previewOrder": _preview_order,
    "createOrder": _create_order,
    "orderDetail": _order_detail,
    "cancelOrder": _cancel_order,
}


class InvokeRequest(BaseModel):
    command: str = Field(min_length=1, max_length=64)
    args: dict = Field(default_factory=dict)


class QrRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2048)


def _qr_svg_data_uri(text: str) -> str | None:
    try:
        import segno  # type: ignore
    except ImportError:
        return None
    try:
        return segno.make(text, error="m").svg_data_uri(scale=4, dark="#111111", light=None)
    except Exception:  # noqa: BLE001 - 生成失败不影响主流程
        return None


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    cli = LuckinCLI(settings.exe, settings.token, settings.timeout)
    http_client: dict[str, httpx.AsyncClient] = {}

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        client = http_client.pop("client", None)
        if client is not None:
            await client.aclose()

    app = FastAPI(title="瑞幸点单 Agent · 桥接服务", version=__version__, lifespan=lifespan)

    # ------------------------------------------------------------------ #
    # CORS：默认关闭，只有 WEB_ALLOW_ORIGINS 命中才放行
    # ------------------------------------------------------------------ #
    def allowed_origin(origin: str | None) -> str:
        if not origin or not settings.allow_origins:
            return ""
        if settings.allow_any_origin:
            return "*"
        return origin if origin in settings.allow_origins else ""

    @app.middleware("http")
    async def cors_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
        origin = allowed_origin(request.headers.get("origin"))
        # 浏览器预检不会带自定义头（如 X-Password），必须在这里直接放行
        if request.method == "OPTIONS" and origin:
            return Response(
                status_code=204,
                headers={
                    "Access-Control-Allow-Origin": origin,
                    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                    "Access-Control-Allow-Headers": "content-type,x-password",
                    "Access-Control-Max-Age": "600",
                    "Vary": "Origin",
                },
            )
        response = await call_next(request)
        if origin:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
        # 本机桥是个「随时会更新」的本地应用：静态页面一律先重新校验再使用。
        # 不然改完 app.js 刷新页面还是旧代码，看起来像没生效（本地开发踩过好几次）。
        # StaticFiles 带 ETag / Last-Modified，重新校验基本都命中 304，代价很小。
        if request.method == "GET" and not request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    def auth(x_password: str | None = Header(default=None, alias="X-Password")) -> None:
        if settings.password and (x_password or "") != settings.password:
            raise HTTPException(status_code=401, detail="访问口令错误")

    # ------------------------------------------------------------------ #
    # 能力状态
    # ------------------------------------------------------------------ #
    @app.get("/api/status")
    async def status() -> dict:
        exe = Path(settings.exe)
        exe_ok = exe.exists()
        token_ok = luckin_token_present()
        return {
            "ok": True,
            "version": __version__,
            "platform": platform.system().lower(),
            # —— 前端「三步向导」靠这几个字段自动识别进度 ——
            "exe": str(exe),
            "exeOk": exe_ok,
            "tokenOk": token_ok,
            "ready": exe_ok and token_ok,
            "installCommand": install_command(),
            "loginCommand": "luckin login",
            # —— 模型与跨域状态 ——
            "llmReady": settings.llm_ready,
            "model": settings.model if settings.llm_ready else "",
            "modelSource": settings.model_source,
            "crossOrigin": settings.allow_any_origin or settings.allow_origins,
            "allowOrigins": settings.allow_origins,
            "password": bool(settings.password),
        }

    # ------------------------------------------------------------------ #
    # CLI 桥
    # ------------------------------------------------------------------ #
    @app.post("/api/invoke", dependencies=[Depends(auth)])
    async def invoke(req: InvokeRequest) -> dict:
        command = COMMANDS.get(req.command)
        if command is None:
            raise HTTPException(status_code=400, detail=f"不支持的命令：{req.command}")
        try:
            data = await command(cli, req.args)
        except KeyError as exc:
            raise HTTPException(status_code=400, detail=f"缺少参数：{exc}") from exc
        except LuckinError as exc:
            return {"ok": False, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        return {"ok": True, "data": data}

    @app.post("/api/qr", dependencies=[Depends(auth)])
    async def qr(req: QrRequest) -> dict:
        if not settings.qr_enabled:
            return {"ok": True, "svg": None}
        return {"ok": True, "svg": _qr_svg_data_uri(req.text)}

    # ------------------------------------------------------------------ #
    # LLM 代理：Key 不出服务端
    # ------------------------------------------------------------------ #
    @app.post("/api/llm", dependencies=[Depends(auth)])
    async def llm_proxy(request: Request) -> StreamingResponse:
        if not settings.llm_ready:
            raise HTTPException(
                status_code=400,
                detail="服务端未配置模型：请在 .env 里填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL",
            )

        body = await request.json()
        payload = dict(body or {})
        payload["model"] = settings.model  # 模型以服务端配置为准
        payload.pop("api_key", None)

        client = http_client.get("client")
        if client is None:
            client = httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=15.0))
            http_client["client"] = client

        upstream = await client.send(
            client.build_request(
                "POST",
                f"{openai_base(settings.base_url)}/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {settings.api_key}"},
            ),
            stream=True,
        )

        if upstream.status_code >= 400:
            detail = (await upstream.aread()).decode("utf-8", "replace")[:400]
            await upstream.aclose()
            raise HTTPException(status_code=502, detail=f"模型服务返回 {upstream.status_code}：{detail}")

        async def relay() -> AsyncIterator[bytes]:
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            finally:
                await upstream.aclose()

        return StreamingResponse(
            relay(),
            media_type=upstream.headers.get("content-type", "text/event-stream"),
            headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
        )

    # ------------------------------------------------------------------ #
    # 托管静态站点（本地版和 GitHub Pages 版是同一份文件）
    # ------------------------------------------------------------------ #
    if DOCS_DIR.exists():
        app.mount("/", StaticFiles(directory=str(DOCS_DIR), html=True), name="static")

    return app


def _startup_report(settings: Settings) -> str:
    """启动自检：把「还差哪一步」直接说清楚，并返回访问地址。"""
    exe = Path(settings.exe)
    exe_ok = exe.exists()
    token_ok = luckin_token_present()
    url = f"http://{settings.host}:{settings.port}"

    print("=" * 68)
    print("  瑞幸点单 Agent · 桥接服务")
    print("=" * 68)

    print(f"  {'✅' if exe_ok else '❌'} luckin CLI  : {exe}")
    if not exe_ok:
        print("      → 没找到 CLI，先装它（PowerShell 一行，免管理员）：")
        print(f"        {install_command()}")

    print(f"  {'✅' if token_ok else '❌'} 瑞幸登录态  : {'已登录' if token_ok else '未登录'}")
    if exe_ok and not token_ok:
        print("      → 先登录一次（会打开浏览器）：")
        print("        luckin login")

    if settings.llm_ready:
        print(f"  ✅ 服务端模型 : {settings.model}  ({settings.model_source})")
    else:
        print("  ➖ 服务端模型 : 未配置（不影响 —— 网页里选「直连模型」填自己的 Key 即可）")

    print(f"  ➖ 静态页面   : {DOCS_DIR}")
    print(f"  ➖ 访问地址   : {url}")

    if settings.password:
        print("  ✅ 访问口令   : 已开启（WEB_PASSWORD）")
    else:
        print("  ⚠️  访问口令   : 未设置（局域网共享时建议设一个）")

    if settings.cross_origin:
        print(f"  ✅ 允许跨域   : {', '.join(settings.allow_origins)}")
        if settings.allow_any_origin and not settings.password:
            print("      ⚠️ 警告：允许任意来源跨域且未设口令，任何网页都能调用本服务下单！")
    else:
        print("  ⚠️  允许跨域   : 只允许同源（直接访问上面的地址没问题）")
        print("      → 如果网页托管在 GitHub Pages 等别处，要在 .env 里加一行：")
        print("        WEB_ALLOW_ORIGINS=https://你的用户名.github.io")

    print("=" * 68)
    if exe_ok and token_ok:
        print("  一切就绪：在网页「设置 → 数据来源」里选「连接服务」，地址填上面的访问地址。")
    else:
        print("  按上面带 → 的提示补齐即可，补齐后刷新网页会自动识别。")
    print()
    return url


def main() -> None:
    settings = load_settings()
    app = create_app(settings)
    url = _startup_report(settings)

    # 启动后自动打开浏览器，省得用户记地址；用 BRIDGE_NO_BROWSER=1 可关掉
    if os.environ.get("BRIDGE_NO_BROWSER", "") not in {"1", "true", "yes", "on"}:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()

    uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning")


if __name__ == "__main__":
    main()
