# 一键启动：创建虚拟环境 → 安装依赖 → 启动 Web 服务
# 用法：  powershell -ExecutionPolicy Bypass -File .\run.ps1
param(
    [switch]$Reinstall
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not (Test-Path ".venv")) {
    Write-Host "→ 创建虚拟环境 .venv" -ForegroundColor Cyan
    py -3 -m venv .venv
}

$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

if ($Reinstall -or -not (Test-Path ".venv\Lib\site-packages\fastapi")) {
    Write-Host "→ 安装依赖" -ForegroundColor Cyan
    & $python -m pip install --upgrade pip -q
    & $python -m pip install -r requirements.txt
}

if (-not (Test-Path ".env")) {
    Write-Host "！还没有 .env，请复制 .env.example 为 .env 并填写 LLM_API_KEY" -ForegroundColor Yellow
}

Write-Host "→ 启动服务" -ForegroundColor Cyan
& $python -m coffee_agent.server
