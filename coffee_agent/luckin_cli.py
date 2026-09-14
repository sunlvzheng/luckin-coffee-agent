"""luckin.exe 的异步封装。

只调用「非交互 JSON 子命令」，完全不启动 TUI，所以不会出现原 CLI 的刷屏/刷新问题。
所有输出都是形如 {"code":0,"msg":"success","data":...,"success":true} 的 JSON。

已实测可用的子命令（luckin 0.0.1）：
    luckin store <纬度> <经度> [门店名]
    luckin menu  <deptId> [关键词...]
    luckin order preview <deptId> -p productId:skuCode[:amount] ...
    luckin order create  <deptId> --lat <纬度> --lng <经度> -p ... [--coupon <券码>] ...
    luckin order detail  <orderId>
    luckin order cancel  <orderId>
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable


class LuckinError(RuntimeError):
    """CLI 调用失败：进程异常、输出不是 JSON、或业务层 success=false。"""


def _extract_json(text: str) -> Any | None:
    """CLI 偶尔会在 JSON 前后夹带日志行，这里做一次宽松提取。"""
    text = (text or "").strip()
    if not text:
        return None

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        start = text.find("[")
        end = text.rfind("]")
    if start == -1 or end <= start:
        return None

    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None


def _unwrap(payload: Any) -> Any:
    """取出 data 字段；没有 data 就把整个 payload 返回。"""
    if isinstance(payload, dict) and "data" in payload:
        return payload["data"]
    return payload


def _item_spec(item: dict) -> str:
    """转换成 CLI 需要的 productId:skuCode[:amount] 形式。"""
    amount = int(item.get("amount") or 1)
    return f"{item['product_id']}:{item['sku_code']}:{amount}"


class LuckinCLI:
    def __init__(self, exe: str | Path, token: str | None = None, timeout: float = 120.0):
        self.exe = Path(exe)
        self.token = token
        self.timeout = timeout

    # ------------------------------------------------------------------ #
    # 进程调用
    # ------------------------------------------------------------------ #
    async def run(self, *args: str) -> Any:
        """执行一条子命令并返回解析后的完整 payload。"""
        return await asyncio.to_thread(self._run_sync, list(args))

    async def run_text(self, *args: str) -> str:
        """执行并返回原始文本（用于 version 这种非 JSON 输出）。"""
        return await asyncio.to_thread(self._run_sync, list(args), True)

    def _run_sync(self, args: list[str], allow_text: bool = False) -> Any:
        if not self.exe.exists():
            raise LuckinError(f"未找到 luckin CLI：{self.exe}（可在 .env 里用 LUCKIN_EXE 指定）")

        env = os.environ.copy()
        env.setdefault("LANG", "zh_CN.UTF-8")
        if self.token:
            # 覆盖 CLI 自己读的 token
            env["LUCKIN_MCP_ORDER_TOKEN"] = self.token

        kwargs: dict[str, Any] = {}
        if sys.platform == "win32":
            # 不弹出控制台窗口
            kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW

        try:
            proc = subprocess.run(
                [str(self.exe), *args],
                capture_output=True,
                timeout=self.timeout,
                env=env,
                **kwargs,
            )
        except subprocess.TimeoutExpired as exc:
            raise LuckinError(f"调用超时（>{self.timeout:.0f}s）：luckin {' '.join(args)}") from exc
        except OSError as exc:
            raise LuckinError(f"无法启动 luckin CLI：{exc}") from exc

        stdout = proc.stdout.decode("utf-8", "replace")
        stderr = proc.stderr.decode("utf-8", "replace")
        payload = _extract_json(stdout) or _extract_json(stderr)

        if payload is None:
            if allow_text:
                return (stdout or stderr).strip()
            detail = (stdout + "\n" + stderr).strip() or f"退出码 {proc.returncode}"
            raise LuckinError(detail[:600])

        if isinstance(payload, dict) and payload.get("success") is False:
            raise LuckinError(str(payload.get("msg") or payload.get("code") or "调用失败"))

        if proc.returncode != 0 and not isinstance(payload, dict):
            raise LuckinError(f"退出码 {proc.returncode}：{stderr.strip()[:300]}")

        return payload

    async def data(self, *args: str) -> Any:
        """执行并直接返回 data 字段。"""
        return _unwrap(await self.run(*args))

    # ------------------------------------------------------------------ #
    # 业务封装
    # ------------------------------------------------------------------ #
    async def version(self) -> str:
        try:
            return (await self.run_text("version")).strip()
        except LuckinError:
            return ""

    async def stores(self, latitude: float, longitude: float, keyword: str | None = None) -> list[dict]:
        args = ["store", f"{latitude:.6f}", f"{longitude:.6f}"]
        if keyword:
            args.append(keyword)
        data = await self.data(*args)
        if isinstance(data, dict):
            data = data.get("list") or []
        return [s for s in (data or []) if isinstance(s, dict)]

    async def search_products(self, dept_id: int | str, query: str) -> list[dict]:
        data = await self.data("menu", str(dept_id), query)
        if isinstance(data, dict):
            data = data.get("list") or data.get("products") or []
        return [p for p in (data or []) if isinstance(p, dict)]

    async def preview_order(self, dept_id: int | str, items: Iterable[dict]) -> dict:
        args = ["order", "preview", str(dept_id)]
        for item in items:
            args += ["-p", _item_spec(item)]
        data = await self.data(*args)
        return data if isinstance(data, dict) else {}

    async def create_order(
        self,
        dept_id: int | str,
        items: Iterable[dict],
        latitude: float,
        longitude: float,
        coupons: Iterable[str] | None = None,
    ) -> dict:
        args = [
            "order",
            "create",
            str(dept_id),
            "--lat",
            f"{latitude:.6f}",
            "--lng",
            f"{longitude:.6f}",
        ]
        for item in items:
            args += ["-p", _item_spec(item)]
        for coupon in coupons or []:
            if coupon:
                args += ["--coupon", str(coupon)]
        data = await self.data(*args)
        return data if isinstance(data, dict) else {}

    async def order_detail(self, order_id: int | str) -> dict:
        data = await self.data("order", "detail", str(order_id))
        return data if isinstance(data, dict) else {}

    async def cancel_order(self, order_id: int | str) -> tuple[bool, str]:
        """返回 (是否取消成功, 说明)。"""
        payload = await self.run("order", "cancel", str(order_id))
        data = _unwrap(payload)
        if isinstance(data, bool):
            return data, ""
        if isinstance(data, dict):
            if "success" in data:
                return bool(data["success"]), str(data.get("msg") or "")
            return True, ""
        return bool(data), ""
