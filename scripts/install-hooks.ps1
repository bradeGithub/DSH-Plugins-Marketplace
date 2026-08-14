# PowerShell 安装 Git Hooks（Windows 用户）
# 用法: .\scripts\install-hooks.ps1
# 原理: 把 scripts/hooks/ 下的 hook 脚本复制到 .git/hooks/ 并设为可执行（Windows 下由 git 直接调用 sh 脚本）。

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$src = Join-Path $PSScriptRoot "hooks"
$dst = Join-Path $repo ".git\hooks"

if (-not (Test-Path $dst)) {
  Write-Error "未找到 .git/hooks，确认在仓库根目录运行。"
}

$hooks = @("pre-commit", "commit-msg")
foreach ($h in $hooks) {
  $target = Join-Path $dst $h
  Copy-Item (Join-Path $src $h) $target -Force
  # Windows 下 git 需要 shebang 的 sh 脚本即可执行，无需 +x 位；同时删除 sample 同名文件避免歧义
  Write-Host "[OK] 已安装 hook: $h"
}

Write-Host "`nGit Hooks 安装完成。"
Write-Host "如需跳过（不推荐）: git commit --no-verify"
