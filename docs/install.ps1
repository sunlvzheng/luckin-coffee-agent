<#
  瑞幸点单 Agent · 一键启动本机桥接服务

  用法（在 PowerShell 里粘一行，回车）：
      irm https://sunlvzheng.github.io/luckin-coffee-agent/install.ps1 | iex

  它做三件事：
      1. 找到瑞幸 CLI；没有就调用官方脚本装好（装到用户目录，不需要管理员）
      2. 检查登录态；没登录就拉起 `luckin login`（会打开浏览器）
      3. 下载最新的单文件桥接服务到 %LOCALAPPDATA%\LuckinAgent\ 并启动
         —— 它自己会再自检一遍，并打开 http://127.0.0.1:8000

  可选环境变量：
      LUCKIN_AGENT_FORCE=1     强制重新下载桥接服务
      LUCKIN_AGENT_SKIP_CLI=1  跳过第 1、2 步（CLI 已经弄好了）
      LUCKIN_AGENT_PORT=8001   指定端口（默认 8000）
#>

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # PS 5.1 的画进度条会明显拖慢下载
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo      = "sunlvzheng/luckin-coffee-agent"
$homeDir   = Join-Path $env:LOCALAPPDATA "LuckinAgent"
$exePath   = Join-Path $homeDir "luckin-bridge.exe"
$download  = "https://github.com/$repo/releases/latest/download/luckin-bridge.exe"
$port      = if ($env:LUCKIN_AGENT_PORT) { [int]$env:LUCKIN_AGENT_PORT } else { 8000 }
$baseUrl   = "http://127.0.0.1:$port"
$force     = $env:LUCKIN_AGENT_FORCE -eq "1"
$skipCli   = $env:LUCKIN_AGENT_SKIP_CLI -eq "1"

function Write-Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "    [OK] $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "    [ ! ] $text" -ForegroundColor Yellow }
function Write-Bad($text)  { Write-Host "    [ X ] $text" -ForegroundColor Red }

Write-Host ""
Write-Host "  瑞幸点单 Agent · 一键启动本机服务" -ForegroundColor White
Write-Host "  ========================================" -ForegroundColor DarkGray

# --------------------------------------------------------------------------- #
# 已经在跑就别重复启动（端口占用会让新进程一闪而过）
# --------------------------------------------------------------------------- #
function Test-BridgeUp($url) {
  try {
    $response = Invoke-WebRequest -Uri "$url/api/status" -UseBasicParsing -TimeoutSec 4
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (Test-BridgeUp $baseUrl) {
  Write-Step "桥接服务已经在运行"
  Write-Ok "$baseUrl"
  Write-Host ""
  Write-Host "  直接打开这个页面就能点单（它比网页版更省事，没有跨域问题）：" -ForegroundColor White
  Write-Host "  $baseUrl" -ForegroundColor Cyan
  Start-Process $baseUrl
  return
}

# --------------------------------------------------------------------------- #
# 1 & 2. 瑞幸 CLI
# --------------------------------------------------------------------------- #
function Find-LuckinCli {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA ".luckin\bin\luckin.exe"),
    (Join-Path $env:LOCALAPPDATA ".luckin\bin\luckin"),
    (Join-Path $env:USERPROFILE ".luckin\bin\luckin.exe"),
    (Join-Path $env:USERPROFILE ".luckin\bin\luckin")
  )
  foreach ($path in $candidates) { if (Test-Path $path) { return $path } }
  $command = Get-Command luckin -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

function Test-LuckinLogin {
  $envFile = Join-Path $env:USERPROFILE ".luckin\.env"
  if (-not (Test-Path $envFile)) { return $false }
  return [bool](Select-String -Path $envFile -Pattern "^\s*LUCKIN_MCP_ORDER_TOKEN\s*=\s*\S+" -Quiet -ErrorAction SilentlyContinue)
}

$cli = Find-LuckinCli

if (-not $skipCli) {
  Write-Step "[1/3] 检查瑞幸 CLI"
  if ($cli) {
    Write-Ok "已安装：$cli"
  } else {
    Write-Warn "还没装，这就调用瑞幸官方安装脚本（装到用户目录，不需要管理员）"
    irm https://open.lkcoffee.com/window/install | iex
    $cli = Find-LuckinCli
    if (-not $cli) {
      throw "装完还是找不到 CLI。请手动执行：irm https://open.lkcoffee.com/window/install | iex"
    }
    Write-Ok "安装完成：$cli"
  }

  Write-Step "[2/3] 检查瑞幸登录状态"
  if (Test-LuckinLogin) {
    Write-Ok "已登录"
  } else {
    Write-Warn "还没登录，马上会打开浏览器让你登录瑞幸账号"
    & $cli login
    if (Test-LuckinLogin) {
      Write-Ok "登录成功"
    } else {
      Write-Warn "没看到登录 Token。可以先继续，等会儿在网页里照着提示再登录一次。"
    }
  }
} else {
  Write-Step "[1/3] [2/3] 已按 LUCKIN_AGENT_SKIP_CLI 跳过 CLI 检查"
}

# --------------------------------------------------------------------------- #
# 3. 下载桥接服务
# --------------------------------------------------------------------------- #
Write-Step "[3/3] 准备本机桥接服务"
New-Item -ItemType Directory -Force -Path $homeDir | Out-Null

if ((Test-Path $exePath) -and -not $force) {
  Write-Ok "已存在：$exePath"
  Write-Host "    （想强制更新：删掉它，或先设 LUCKIN_AGENT_FORCE=1 再跑本脚本）" -ForegroundColor DarkGray
} else {
  Write-Host "    正在下载（约 15 MB）……" -ForegroundColor Gray
  $tempPath = "$exePath.download"
  Remove-Item -Force $tempPath -ErrorAction SilentlyContinue
  try {
    Invoke-WebRequest -Uri $download -OutFile $tempPath -UseBasicParsing -TimeoutSec 600
  } catch {
    throw "下载失败：$($_.Exception.Message)`n也可以手动下载 $download 然后放到 $homeDir 目录里。"
  }
  Move-Item -Force $tempPath $exePath
  $sizeMB = [math]::Round((Get-Item $exePath).Length / 1MB, 1)
  Write-Ok "下载完成：$sizeMB MB"
  Write-Host "    SHA256 $((Get-FileHash $exePath -Algorithm SHA256).Hash.ToLower())" -ForegroundColor DarkGray
}

# --------------------------------------------------------------------------- #
# 启动
# --------------------------------------------------------------------------- #
Write-Host ""
Write-Host "==> 启动桥接服务" -ForegroundColor Cyan
Write-Host "    会弹出一个黑色窗口显示自检结果，浏览器随后自动打开。" -ForegroundColor Gray
Write-Host "    那个窗口要一直留着；关掉它服务就停了。" -ForegroundColor Gray
Write-Host ""

$previousPort = $null
if (Test-Path Env:\PORT) { $previousPort = $env:PORT }
$env:PORT = "$port"          # 子进程会继承；跑完就还原，不在用户会话里留副作用
Start-Process -FilePath $exePath -WorkingDirectory $homeDir
if ($previousPort) { $env:PORT = $previousPort } else { Remove-Item Env:\PORT -ErrorAction SilentlyContinue }

# 等它起来，顺便确认真的成功了
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 700
  if (Test-BridgeUp $baseUrl) { $ready = $true; break }
}

Write-Host ""
if ($ready) {
  Write-Host "  一切就绪 ✓  $baseUrl" -ForegroundColor Green
  Write-Host "  以后想再用，再跑一次这行命令即可（已经装好的会被复用，秒开）。" -ForegroundColor Gray
} else {
  Write-Warn "服务好像没起来。看一眼那个黑色窗口里的报错，多半是没登录或端口被占。"
  Write-Host "  也可以直接把 $baseUrl 粘到浏览器里试试。" -ForegroundColor Gray
}
Write-Host ""
