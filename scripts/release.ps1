# 把单文件 exe 发布到 GitHub Releases（幂等，可以反复运行）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\scripts\release.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\release.ps1 -Tag v0.2.0
#
# 说明：
#   - 凭据复用 Git Credential Manager（和 git push 是同一份），脚本不会打印令牌
#   - dist 里没有 exe 时会先自动调用 build_exe.ps1
#   - 同名 release / asset 已存在时自动复用或覆盖，重复运行不会报错

[CmdletBinding()]
param(
  [string]$Tag = "v0.1.0",
  [string]$Title = "",
  [string]$AssetName = "luckin-bridge.exe",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $Title) { $Title = "瑞幸点单 Agent · 本机桥接服务 $Tag" }

# --------------------------------------------------------------------------- #
# 1. 解析仓库
# --------------------------------------------------------------------------- #
$remote = (git remote get-url origin).Trim()
if ($remote -notmatch "github\.com[:/](?<owner>[^/]+)/(?<repo>[^/.]+)") {
  throw "无法从 origin 解析出 GitHub 仓库：$remote"
}
$owner = $Matches["owner"]
$repo = "$owner/$($Matches["repo"])"
Write-Host "==> 仓库 $repo    标签 $Tag" -ForegroundColor Cyan

# --------------------------------------------------------------------------- #
# 2. 确保产物存在
# --------------------------------------------------------------------------- #
$exePath = ".\dist\$AssetName"
if (-not (Test-Path $exePath)) {
  if ($SkipBuild) { throw "找不到 $exePath（且指定了 -SkipBuild）" }
  Write-Host "==> 没找到 $exePath，先自动打包" -ForegroundColor Yellow
  & powershell -ExecutionPolicy Bypass -File .\scripts\build_exe.ps1
  if (-not (Test-Path $exePath)) { throw "打包后仍找不到 $exePath" }
}
$exePath = (Resolve-Path $exePath).Path
$sizeMB = [math]::Round((Get-Item $exePath).Length / 1MB, 1)
$sha256 = (Get-FileHash $exePath -Algorithm SHA256).Hash.ToLower()
Write-Host "==> 产物 $AssetName（$sizeMB MB）"
Write-Host "    SHA256 $sha256"

# --------------------------------------------------------------------------- #
# 3. 取凭据（不打印令牌）
#
#    PowerShell 5.1 下把数组管道给 `git credential fill` 有时会把字段喂丢，
#    所以这里先试多行字符串管道，失败再退回 cmd 重定向读文件。
# --------------------------------------------------------------------------- #
function Get-GitHubToken {
  $payload = "protocol=https`nhost=github.com`n`n"
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = $payload | git credential fill 2>$null
    if ($out -match "(?m)^password=(.+)$") { return $Matches[1].Trim() }

    $inFile = Join-Path $env:TEMP "luckin-cred-in.txt"
    $outFile = Join-Path $env:TEMP "luckin-cred-out.txt"
    [IO.File]::WriteAllText($inFile, $payload, (New-Object Text.UTF8Encoding $false))
    $null = cmd /c "git credential fill < `"$inFile`" > `"$outFile`" 2>nul"
    Remove-Item -Force $inFile -ErrorAction SilentlyContinue
    if (Test-Path $outFile) {
      $text = [IO.File]::ReadAllText($outFile)
      Remove-Item -Force $outFile -ErrorAction SilentlyContinue
      if ($text -match "(?m)^password=(.+)$") { return $Matches[1].Trim() }
    }
  } finally {
    $ErrorActionPreference = $prev
  }
  return $null
}

$token = Get-GitHubToken
if ([string]::IsNullOrWhiteSpace($token)) {
  throw "没能从 Git Credential Manager 取到 github.com 凭据；先手动 git push 一次完成登录"
}

$headers = @{
  Authorization = "Bearer $token"
  "User-Agent"  = "luckin-agent-release"
  Accept        = "application/vnd.github+json"
}

$me = Invoke-RestMethod -Uri "https://api.github.com/user" -Headers $headers -TimeoutSec 30
Write-Host "==> 已认证账号 $($me.login)"
if ($me.login -ne $owner) {
  Write-Host "    ⚠️  这个账号不是仓库属主 $owner，可能没有发布权限" -ForegroundColor Yellow
}

# --------------------------------------------------------------------------- #
# 4. 组装 release 说明（单引号 here-string，避免反引号被 PowerShell 吃掉）
# --------------------------------------------------------------------------- #
$notes = @'
## 瑞幸点单 Agent · 本机桥接服务（单文件 exe）

双击即用，不用装 Python / Node：启动后会自检、托管网页、并自动打开浏览器。

### 用法

1. 下载下面的 `luckin-bridge.exe`，放到任意目录
2. 装好并登录瑞幸 CLI（网页里的「配置向导」每步都有可一键复制的命令）
   - 安装：`irm https://open.lkcoffee.com/window/install | iex`
   - 登录：`luckin login`
3. 双击 `luckin-bridge.exe` —— 浏览器会自动打开，页面顶部出现 `🔌 本机服务已就绪`

要自定义端口 / 访问口令 / 跨域白名单，就在 **exe 同目录**放一个 `.env`（参考仓库里的 `.env.example`）。

### 这个版本包含

- 启动自检（CLI 装没装、登录没有、跨域放开了没）+ 自动打开浏览器（`BRIDGE_NO_BROWSER=1` 可关）
- 网页已打包进去，`http://127.0.0.1:8000` 打开就是对话界面
- `/api/invoke`、`/api/llm`、`/api/qr`、`/api/status`
- 跨域默认关闭，必须显式配置 `WEB_ALLOW_ORIGINS`

### 校验

```
SHA256  __SHA256__
```

### 说明

- 未做代码签名，Windows SmartScreen 可能提示「未知发布者」→ 选「更多信息 → 仍要运行」
- 命令白名单：只接受 6 条固定命令，不接受任意 CLI 参数
- 下单前一定会弹确认卡并重新试算金额，不会「看到的钱数 ≠ 实际扣款」
'@
$notes = $notes.Replace("__SHA256__", $sha256)

$jsonPath = Join-Path $env:TEMP "luckin-release-$Tag.json"
$payload = @{
  tag_name         = $Tag
  target_commitish = "main"
  name             = $Title
  body             = $notes
  draft            = $false
  prerelease       = $false
} | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($jsonPath, $payload, (New-Object Text.UTF8Encoding $false))

# --------------------------------------------------------------------------- #
# 5. 创建（或复用）release
# --------------------------------------------------------------------------- #
$release = $null
try {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/tags/$Tag" -Headers $headers -TimeoutSec 30
  Write-Host "==> 标签 $Tag 的 release 已存在（id=$($release.id)），复用" -ForegroundColor Yellow
} catch {
  $release = $null
}
if (-not $release) {
  Write-Host "==> 创建 release"
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases" `
    -Method Post -Headers $headers -ContentType "application/json" -InFile $jsonPath -TimeoutSec 120
}

# --------------------------------------------------------------------------- #
# 6. 上传产物（同名先删，保证可重复运行）
# --------------------------------------------------------------------------- #
$assets = @(Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/$($release.id)/assets" -Headers $headers -TimeoutSec 30)
$old = $assets | Where-Object { $_.name -eq $AssetName }
if ($old) {
  Write-Host "==> 已存在同名文件，先删掉旧的"
  Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/assets/$($old.id)" `
    -Method Delete -Headers $headers -TimeoutSec 30 | Out-Null
}

Write-Host "==> 上传 $sizeMB MB，请稍等" -ForegroundColor Cyan
$uploaded = Invoke-RestMethod -Uri "https://uploads.github.com/repos/$repo/releases/$($release.id)/assets?name=$AssetName" `
  -Method Post -Headers $headers -ContentType "application/octet-stream" -InFile $exePath -TimeoutSec 900

# --------------------------------------------------------------------------- #
# 7. 收尾
# --------------------------------------------------------------------------- #
Remove-Item -Force $jsonPath -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "==> 发布完成" -ForegroundColor Green
Write-Host "    Release    $($release.html_url)"
Write-Host "    下载直链   $($uploaded.browser_download_url)"
Write-Host "    远端大小   $([math]::Round($uploaded.size / 1MB, 1)) MB"
Write-Host "    远端 SHA   $($uploaded.digest)"
