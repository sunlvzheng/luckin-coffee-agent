"""瑞幸咖啡点单 Agent

用自研的 Agent 循环（LLM 函数调用）驱动本地 luckin CLI 的「非交互 JSON 子命令」，
彻底绕开原 CLI 的 TUI 刷屏问题，并提供一个干净的 Web 对话页面。

模块划分：
    settings    配置加载（.env / ~/.luckin/config.json）
    luckin_cli  luckin.exe 的异步封装
    tools       暴露给 LLM 的工具（含下单二次确认）
    agent       Agent 循环（OpenAI 兼容接口 + 流式 + 函数调用）
    server      FastAPI + SSE Web 服务
    repl        终端调试入口（复用同一套内核）
"""

__version__ = "0.1.0"
