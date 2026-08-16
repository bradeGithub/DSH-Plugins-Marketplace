<#
  DSH 插件市场（dsh-plugin-marketplace）一键安装脚本

  支持三种执行方式：
    1) 本仓库直接运行：  git clone 后运行 install.ps1
    2) 一行命令（推荐）：irm https://raw.githubusercontent.com/bradeGithub/DSH-Plugins-Marketplace/main/install.ps1 | iex
    3) 由 DSH 插件市场执行（repo 被识别为 script 类型时自动调用）

  安装内容：
    - 复制本体到 ~/.dsh/profiles/web/node_modules/dsh-plugin-marketplace/
    - 在 ~/.dsh/profiles/web/cordis.patch.yml 中注册（已存在则跳过）
  完成后需重启 DSH（重新运行 dsh web）再刷新页面。
#>
$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/bradeGithub/DSH-Plugins-Marketplace"

# 优先使用官方安装方式：dsh CLI 可用时由 harness 完成安装与 reconcile（免手工拷贝/注册）；
# 失败则回退手动安装。
if (Get-Command dsh -ErrorAction SilentlyContinue) {
  Write-Host "检测到 dsh CLI，使用官方安装方式：dsh plugin --profile web install bradeGithub/DSH-Plugins-Marketplace"
  try {
    dsh plugin --profile web install "bradeGithub/DSH-Plugins-Marketplace"
    Write-Host ""
    Write-Host "✔ dsh-plugin-marketplace installed via official CLI"
    Write-Host "  请重启 DSH（重新运行 dsh web）后刷新页面生效。"
    Write-Host "  Restart DSH (re-run dsh web), then refresh the page."
    exit 0
  } catch {
    Write-Host "官方 CLI 安装失败，回退到手动安装方式..." -ForegroundColor Yellow
  }
}

# 定位源码目录：直接运行 = 脚本所在目录；irm|iex 模式 = 无路径，改为下载仓库 zip
$src = $PSScriptRoot
if (-not $src -or -not (Test-Path (Join-Path $src "package.json"))) {
  $tmp = Join-Path $env:TEMP ("dshm-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp "src.zip"
  Write-Host "Downloading $RepoUrl ..."
  Invoke-WebRequest -Uri "$RepoUrl/archive/refs/heads/main.zip" -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp "src") -Force
  $src = Get-ChildItem (Join-Path $tmp "src") -Directory | Select-Object -First 1
}

$dest = Join-Path $env:USERPROFILE ".dsh\profiles\web\node_modules\dsh-plugin-marketplace"
New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Copy-Item $src $dest -Recurse
Remove-Item (Join-Path $dest ".git") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $dest "install.ps1") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $dest "install.sh") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $dest ".ca-bundle.crt") -Force -ErrorAction SilentlyContinue

# 注册到 web profile 补丁（幂等；行级精确匹配，避免前缀子串误判）。
# 注意：patch 条目是 `- insert:` 块内的缩进行（`      name: ...`），
# 行首锚定必须允许前导空白，否则永远匹配不到 → 每次运行都会追加重复条目（KIMI 审阅 H1）。
# v1.4.12（issue #39）：若本体已通过 profile bundles（package.json dsh.profile.bundles）加载，
# 再注册 patch 会双加载 → webserver 重复路由崩溃——此时跳过注册。
$profilePkg = Join-Path $env:USERPROFILE ".dsh\profiles\web\package.json"
$bundled = $false
if (Test-Path $profilePkg) {
  try {
    $bundled = [bool]((Get-Content $profilePkg -Raw | ConvertFrom-Json).dsh.profile.bundles -contains "dsh-plugin-marketplace")
  } catch { $bundled = $false }
}
$patch = Join-Path $env:USERPROFILE ".dsh\profiles\web\cordis.patch.yml"
$registered = $false
if (Test-Path $patch) {
  $registered = [bool](Select-String -Path $patch -Pattern "^\s*name:\s+dsh-plugin-marketplace\s*$" -Quiet)
}
if ($bundled) {
  Write-Host "Marketplace already loaded via profile bundles (skipped patch registration)"
} elseif (-not $registered) {
  $entry = "`n- insert:`n    - id: dsh-plugin-marketplace`n      name: dsh-plugin-marketplace`n"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::AppendAllText($patch, $entry, $utf8NoBom)
  Write-Host "Registered in cordis.patch.yml"
} else {
  Write-Host "Already registered in cordis.patch.yml (skipped)"
}

Write-Host ""
Write-Host "✔ dsh-plugin-marketplace installed to $dest"
Write-Host "  请重启 DSH（重新运行 dsh web）后刷新页面生效。"
Write-Host "  Restart DSH (re-run dsh web), then refresh the page."
