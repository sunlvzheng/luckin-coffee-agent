"""配置加载。

优先级（从高到低）：
    1. 进程已有的环境变量
    2. 项目根目录的 .env
    3. ~/.luckin/config.json 里的 models.profiles（模型配置兜底）

其中瑞幸 Token 一般不需要配置：luckin.exe 会自己读取 ~/.luckin/.env，
只有当你想用别的 Token 覆盖时，才需要在 .env 里写 LUCKIN_MCP_ORDER_TOKEN。
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# PyInstaller 打包成单文件 exe 后，代码被解包到临时目录：
#   - 静态页面等只读资源在 sys._MEIPASS 里
#   - .env 则要读 exe 旁边的那份（用户能直接改），所以两者分开解析
if getattr(sys, "frozen", False):
    RESOURCE_ROOT = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    CONFIG_ROOT = Path(sys.executable).resolve().parent
else:
    RESOURCE_ROOT = CONFIG_ROOT = PROJECT_ROOT

ENV_FILE = CONFIG_ROOT / ".env"
DOCS_DIR = RESOURCE_ROOT / "docs"
LUCKIN_HOME = Path.home() / ".luckin"


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def _parse_env_file(path: Path) -> dict[str, str]:
    """手写一个极简 .env 解析，避免引入 python-dotenv 依赖。"""
    result: dict[str, str] = {}
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return result

    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        # 去掉成对的引号
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        result[key.strip()] = value
    return result


def _as_float(value: str | None) -> float | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _split(value: str | None) -> list[str]:
    """逗号分隔的列表，例如 WEB_ALLOW_ORIGINS。"""
    return [item.strip() for item in (value or "").split(",") if item.strip()]


def default_exe_path() -> Path:
    """默认的 luckin.exe 路径（Windows 安装位置）。"""
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / ".luckin" / "bin" / "luckin.exe"
    return LUCKIN_HOME / "bin" / "luckin.exe"


def other_exe_paths() -> list[Path]:
    """除默认位置外，再猜几个可能的安装位置，方便自动识别。"""
    home = Path.home()
    names = ("luckin.exe", "luckin") if os.name == "nt" else ("luckin",)
    candidates: list[Path] = []
    for name in names:
        candidates += [
            LUCKIN_HOME / "bin" / name,
            home / "AppData" / "Local" / ".luckin" / "bin" / name,
            home / ".local" / "bin" / name,
            Path("/usr/local/bin") / name,
            Path("/opt/homebrew/bin") / name,
        ]
    return candidates


def find_luckin_exe(explicit: str = "") -> Path:
    """自动识别 luckin CLI：显式路径 → 环境变量 → 默认位置 → 若干常见路径。"""
    if explicit:
        return Path(explicit)
    env = os.environ.get("LUCKIN_EXE")
    if env:
        return Path(env)
    default = default_exe_path()
    if default.exists():
        return default
    for candidate in other_exe_paths():
        if candidate.exists():
            return candidate
    return default


def luckin_token_present() -> bool:
    """~/.luckin/.env 里是否已有登录 Token —— 也就是「CLI 登录过没有」。"""
    path = LUCKIN_HOME / ".env"
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    for line in text.splitlines():
        key, _, value = line.partition("=")
        if key.strip() == "LUCKIN_MCP_ORDER_TOKEN" and value.strip().strip("\"'"):
            return True
    return False


def install_command() -> str:
    """官方一键安装命令（实测存在，免管理员）。"""
    if os.name == "nt":
        return "irm https://open.lkcoffee.com/window/install | iex"
    return "curl -fsSL https://open.lkcoffee.com/install | bash"



def openai_base(base_url: str) -> str:
    """把用户填的地址规范成 OpenAI 兼容 base（必要时补 /v1）。"""
    trimmed = (base_url or "").strip().rstrip("/")
    if not trimmed:
        return ""
    if trimmed.endswith("/v1") or "/v1/" in trimmed:
        return trimmed
    return f"{trimmed}/v1"


# --------------------------------------------------------------------------- #
# 读取瑞幸 CLI 自己的模型配置（格式：models.profiles.<name>.{base_url,api_key,api_key_env,model}）
# --------------------------------------------------------------------------- #
@dataclass
class ModelProfile:
    name: str
    base_url: str = ""
    api_key: str = ""
    api_key_env: str = ""
    model: str = ""


def read_luckin_profiles() -> tuple[dict[str, ModelProfile], str | None]:
    """返回 (profiles, active_name)。读不到就返回空。"""
    path = LUCKIN_HOME / "config.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}, None

    models = raw.get("models") or {}
    profiles_raw = models.get("profiles") or {}
    profiles: dict[str, ModelProfile] = {}
    for name, item in profiles_raw.items():
        if not isinstance(item, dict):
            continue
        profiles[name] = ModelProfile(
            name=name,
            base_url=str(item.get("base_url") or ""),
            api_key=str(item.get("api_key") or ""),
            api_key_env=str(item.get("api_key_env") or ""),
            model=str(item.get("model") or ""),
        )
    return profiles, models.get("active")


def _resolve_api_key(profile: ModelProfile) -> str:
    """profile 里存的可能是一个环境变量名（见 luckin 的 --api-key-env）。"""
    if profile.api_key_env and os.environ.get(profile.api_key_env):
        return os.environ[profile.api_key_env]
    if profile.api_key:
        # 形如 DEEPSEEK_API_KEY 的大写变量名 → 去环境变量里取真实值
        if profile.api_key.isupper() and os.environ.get(profile.api_key):
            return os.environ[profile.api_key]
        return profile.api_key
    return ""


# --------------------------------------------------------------------------- #
# 最终配置
# --------------------------------------------------------------------------- #
@dataclass
class Settings:
    # 瑞幸 CLI
    exe: str = ""
    token: str | None = None
    timeout: float = 120.0

    # 默认定位（可省略，页面/对话里设置也行）
    lat: float | None = None
    lng: float | None = None

    # LLM（OpenAI 兼容）
    base_url: str = "https://api.deepseek.com"
    api_key: str = ""
    model: str = "deepseek-chat"
    model_source: str = "未配置"

    # Web 服务
    host: str = "127.0.0.1"
    port: int = 8000
    password: str | None = None

    # 可选：用 segno 生成支付二维码
    qr_enabled: bool = True

    # 跨域白名单（默认空 = 只允许同源）
    allow_origins: list[str] = field(default_factory=list)

    extra: dict = field(default_factory=dict)

    @property
    def llm_ready(self) -> bool:
        return bool(self.api_key and self.base_url and self.model)

    @property
    def cross_origin(self) -> bool:
        """是否放行了跨域（静态页托管在别处时才需要）。"""
        return bool(self.allow_origins)

    @property
    def allow_any_origin(self) -> bool:
        return "*" in self.allow_origins


def load_settings(env_file: Path | None = None) -> Settings:
    """加载配置；.env 不会覆盖已存在的真实环境变量。"""
    env_path = env_file or ENV_FILE
    for key, value in _parse_env_file(env_path).items():
        os.environ.setdefault(key, value)

    get = os.environ.get

    settings = Settings(
        exe=str(find_luckin_exe(get("LUCKIN_EXE") or "")),        token=(get("LUCKIN_MCP_ORDER_TOKEN") or "").strip() or None,
        timeout=float(get("LUCKIN_TIMEOUT", "120") or 120),
        lat=_as_float(get("LUCKIN_LAT")),
        lng=_as_float(get("LUCKIN_LNG")),
        host=get("HOST", "127.0.0.1") or "127.0.0.1",
        port=int(get("PORT", "8000") or 8000),
        password=(get("WEB_PASSWORD") or "").strip() or None,
        allow_origins=_split(get("WEB_ALLOW_ORIGINS")),
        qr_enabled=_as_bool(get("ENABLE_QR"), default=True),
    )

    # ---- 模型配置：先看 .env / 环境变量 ----
    base_url = (get("LLM_BASE_URL") or "").strip()
    api_key = (get("LLM_API_KEY") or get("DEEPSEEK_API_KEY") or get("OPENAI_API_KEY") or "").strip()
    model = (get("LLM_MODEL") or "").strip()

    if base_url or api_key or model:
        settings.base_url = base_url or settings.base_url
        settings.model = model or settings.model
        settings.api_key = api_key
        settings.model_source = "环境变量 / .env"

    # ---- 兜底：复用瑞幸 CLI 已配置的模型 ----
    if not settings.api_key:
        profiles, active = read_luckin_profiles()
        if profiles:
            profile = profiles.get(active or "") or next(iter(profiles.values()))
            resolved_key = _resolve_api_key(profile)
            if resolved_key:
                settings.base_url = profile.base_url or settings.base_url
                settings.model = profile.model or settings.model
                settings.api_key = resolved_key
                settings.model_source = f"~/.luckin/config.json (models.profiles.{profile.name})"

    return settings
