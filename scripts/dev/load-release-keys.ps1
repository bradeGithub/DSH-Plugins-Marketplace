# Load release signing keys into the Windows ssh-agent service (once per boot).
# ASCII-only comments on purpose: PowerShell 5.1 misreads UTF-8-without-BOM .ps1
# files under GBK locales. Keep this file ASCII.
$ErrorActionPreference = "Stop"

foreach ($k in @("dsh-release-1", "dsh-release-2")) {
  $f = Join-Path $env:USERPROFILE ".ssh\$k"
  if (Test-Path $f) { ssh-add $f } else { Write-Host "skip $k (not found)" }
}
