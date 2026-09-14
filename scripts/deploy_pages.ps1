<#
一键把本地工程推到 GitHub 并开启 Pages 托管。

用法：
    powershell -ExecutionPolicy Bypass -File .\scripts\deploy_pages.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\deploy_pages.ps1 -Owner 你的用户名 -Repo luckin-coffee-agent

关于登录：
    脚本不会、也不需要你的 GitHub 令牌。
    - 如果装了 GitHub CLI 并已 `gh auth login`，脚本能连「建仓库 + 开 Pages」一起做完；
    - 否则第一次 `git push` 会弹出 GitHub 登录窗口（由 Git Credential Manager 处理），
      登录完成后令牌保存在 Windows 凭据管理器里，脚本和 AI 都看不到它。
#>

param(
    [string]$Owner = "",
    [string]$Repo = "luckin-coffee-agent",
    [string]$Branch = "main",
    [switch]$Private
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Info($m) { Write-Host "→ $m" -ForegroundColor Cyan }
function Good($m) { Write-Host "✅ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "⚠️  $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "❌ $m" -ForegroundColor Red }
function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor White }

# --------------------------------------------------------------------------- #
Step "1/5 检查环境"
# --------------------------------------------------------------------------- #
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Bad "没有找到 git，请先安装 Git for Windows：https://git-scm.com/download/win"
    exit 1
}
Good "git $(git --version)"

$hasGh = [bool](Get-Command gh -ErrorAction SilentlyContinue)
$ghReady = $false
if ($hasGh) {
    gh auth status *> $null
    $ghReady = ($LASTEXITCODE -eq 0)
    if ($ghReady) { Good "GitHub CLI 已登录" } else { Warn "装了 gh 但还没登录（可执行 gh auth login，或直接在 push 时用浏览器登录）" }
} else {
    Warn "未安装 GitHub CLI（可选）：装了它才能自动创建仓库和开启 Pages"
}

# --------------------------------------------------------------------------- #
Step "2/5 确认 GitHub 仓库"
# --------------------------------------------------------------------------- #
if (-not $Owner) {
    $Owner = (git config --global user.name)
    $answer = Read-Host "GitHub 用户名（回车用 [$Owner]）"
    if ($answer.Trim()) { $Owner = $answer.Trim() }
}
if (-not $Repo) { $Repo = Read-Host "仓库名" }
Info "目标仓库：$Owner/$Repo"

# --------------------------------------------------------------------------- #
Step "3/5 本地提交"
# --------------------------------------------------------------------------- #
if (-not (Test-Path ".git")) {
    git init -b $Branch | Out-Null
    Good "已初始化 git 仓库（分支 $Branch）"
} else {
    $current = (git rev-parse --abbrev-ref HEAD).Trim()
    if ($current -ne $Branch) {
        git branch -M $Branch | Out-Null
        Good "当前分支已重命名为 $Branch"
    }
}

if (-not (Test-Path ".env")) {
    Warn "还没有 .env（本地跑真实下单才需要；静态站点不需要）。.env 已被 .gitignore 排除，不会上传。"
}

git add -A
$staged = (git status --porcelain | Measure-Object).Count
if ($staged -gt 0) {
    git commit -m "feat: 瑞幸点单 Agent（公用心核 + 静态站点 + 桥接服务）" | Out-Null
    Good "已提交 $staged 项变更"
} else {
    Good "没有需要提交的变更"
}

# --------------------------------------------------------------------------- #
Step "4/5 推送到 GitHub"
# --------------------------------------------------------------------------- #
$hasOrigin = [bool](git remote 2>$null | Select-String -Quiet "^origin$")

if ($hasOrigin) {
    Info "已有 origin：$((git remote get-url origin).Trim())"
} elseif ($ghReady) {
    $visibility = if ($Private) { "--private" } else { "--public" }
    Info "用 GitHub CLI 创建仓库并推送…"
    gh repo create "$Owner/$Repo" $visibility --source . --remote origin --push
    if ($LASTEXITCODE -ne 0) { Bad "创建/推送失败，请检查仓库名是否已存在"; exit 1 }
    $hasOrigin = $true
    Good "仓库已创建并完成推送"
} else {
    Warn "还没配置 origin，需要你手动做两步（只需一次）："
    Write-Host ""
    Write-Host "   1) 点开这个链接创建空仓库（仓库名已帮你填好）："
    Write-Host "      https://github.com/new?name=$Repo&visibility=public" -ForegroundColor Yellow
    Write-Host "      注意不要勾选 Add README / .gitignore / license，保持空仓库。"
    Write-Host "      可见性必须是 Public —— 私有仓库要付费计划才能用 Pages。"
    Write-Host ""
    Write-Host "   2) 回来执行这两行（会弹出浏览器让你登录 GitHub）："
    Write-Host ""
    Write-Host "      git remote add origin https://github.com/$Owner/$Repo.git" -ForegroundColor Yellow
    Write-Host "      git push -u origin $Branch" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "   想省掉这一步？先装 GitHub CLI，之后脚本能连「建仓库 + 开 Pages」一起做完："
    Write-Host "      winget install --id GitHub.cli   然后   gh auth login" -ForegroundColor DarkGray
    Write-Host ""
    exit 0
}

if (-not $hasOrigin) { Bad "没有 origin，无法推送"; exit 1 }

$needPush = $true
git ls-remote --exit-code origin $Branch *> $null
if ($LASTEXITCODE -eq 0) {
    $local  = (git rev-parse HEAD).Trim()
    $remote = (git ls-remote origin "refs/heads/$Branch" | ForEach-Object { ($_ -split "\s+")[0] }).Trim()
    if ($local -eq $remote) {
        Good "远端已是最新，无需推送"
        $needPush = $false
    }
}

if ($needPush) {
    Info "推送中…（第一次会弹出浏览器让你登录 GitHub，登录完成后令牌存在 Windows 凭据管理器里）"
    git push -u origin $Branch
    if ($LASTEXITCODE -ne 0) { Bad "推送失败"; exit 1 }
    Good "推送完成"
}

# --------------------------------------------------------------------------- #
Step "5/5 开启 GitHub Pages"
# --------------------------------------------------------------------------- #
$pagesUrl = "https://$Owner.github.io/$Repo/"

if ($ghReady) {
    Info "尝试用 API 开启 Pages（分支 $Branch，目录 /docs）…"
    '{"source":{"branch":"' + $Branch + '","path":"/docs"}}' |
        gh api -X POST "repos/$Owner/$Repo/pages" --input - *> $null
    if ($LASTEXITCODE -ne 0) {
        '{"source":{"branch":"' + $Branch + '","path":"/docs"}}' |
            gh api -X PUT "repos/$Owner/$Repo/pages" --input - *> $null
    }
    if ($LASTEXITCODE -eq 0) {
        Good "Pages 已开启"
    } else {
        Warn "自动开启失败（可能已开启过，或令牌权限不足），请手动点一下"
    }
} else {
    Warn "未安装/未登录 GitHub CLI，需要手动开启一次（30 秒）："
}

Write-Host ""
Write-Host "  打开：https://github.com/$Owner/$Repo/settings/pages" -ForegroundColor Yellow
Write-Host "  Source 选 'Deploy from a branch'，Branch 选 $Branch，目录选 /docs，保存"
Write-Host ""
Write-Host "  等 1 分钟左右，访问：$pagesUrl" -ForegroundColor Green
Write-Host ""
Info "想先本地确认部署效果（含子路径）：node scripts/serve_static.mjs 8090 /$Repo"
