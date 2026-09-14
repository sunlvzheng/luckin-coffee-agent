# 打包成单文件 exe：dist\luckin-bridge.exe（Windows，双击即用）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\scripts\build_exe.ps1
#
# 产物不含 .env / Token，用户第一次运行时把 .env 放在 exe 旁边即可。

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$python = ".\.venv\Scripts\python.exe"
if (-not (Test-Path $python)) { $python = "python" }

Write-Host "==> 检查 PyInstaller" -ForegroundColor Cyan
& $python -m PyInstaller --version 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "    未安装，正在安装 PyInstaller ..." -ForegroundColor Yellow
  & $python -m pip install --upgrade pyinstaller
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller 安装失败" }
}

Write-Host "==> 清理旧产物" -ForegroundColor Cyan
Remove-Item -Recurse -Force .\build, .\dist -ErrorAction SilentlyContinue
Remove-Item -Force .\luckin-bridge.spec -ErrorAction SilentlyContinue

Write-Host "==> 开始打包（首次约 1-2 分钟）" -ForegroundColor Cyan
& $python -m PyInstaller `
  --noconfirm `
  --onefile `
  --console `
  --name luckin-bridge `
  --add-data "docs;docs" `
  --collect-submodules uvicorn `
  --hidden-import segno `
  --exclude-module tkinter `
  bridge_main.py

if ($LASTEXITCODE -ne 0) { throw "打包失败" }

$exe = ".\dist\luckin-bridge.exe"
if (-not (Test-Path $exe)) { throw "没有找到产物：$exe" }

Write-Host ""
Write-Host "==> 完成：$exe" -ForegroundColor Green
Write-Host "    体积：$([math]::Round((Get-Item $exe).Length / 1MB, 1)) MB"
Write-Host ""
Write-Host "    用法：把 exe 拷到任意目录，双击即可；需要自定义配置时" -ForegroundColor Gray
Write-Host "    在同目录放一个 .env（参考 .env.example）。" -ForegroundColor Gray
