<#
.SYNOPSIS
  Removes services, firewall rules and the backup task. Keeps the data directory
  (database, backups, certificates) so a reinstall picks it up again.
  STATUS: NOT executed on a real Windows host yet.
#>
param([Parameter(Mandatory)] [string] $AppDir)

$ErrorActionPreference = 'Continue'
foreach ($id in 'scgerp-server', 'scgerp-postgres') {
  $exe = Join-Path $AppDir "services\$id.exe"
  if (Get-Service -Name $id -ErrorAction SilentlyContinue) {
    Stop-Service -Name $id -Force -ErrorAction SilentlyContinue
    if (Test-Path $exe) { & $exe uninstall } else { sc.exe delete $id | Out-Null }
  }
}
Remove-NetFirewallRule -Name 'SCGShopERP-HTTPS', 'SCGShopERP-mDNS' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'SCG Shop ERP nightly backup' -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Services removed. Data kept in $env:ProgramData\SCG Shop ERP"
exit 0
