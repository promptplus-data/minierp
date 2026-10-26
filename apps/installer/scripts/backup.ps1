<#
.SYNOPSIS
  pg_dump backup of the SCG Shop ERP database on the main machine.

.DESCRIPTION
  Writes <DataDir>\backups\erp-<yyyyMMdd-HHmmss>-<Reason>.dump (custom format, compressed)
  and prunes old dumps per reason. Callers:
    - Scheduled task "SCG Shop ERP nightly backup" (registered by install-main.ps1, 23:30, as SYSTEM)
    - The server after a shift is closed (it runs the script named in its BACKUP_SCRIPT env
      with -Reason shift-close; the service account is LocalService)
    - The installer before an upgrade (-Reason pre-upgrade)
  Connection: $env:DATABASE_URL if set (the server passes its own), else config\secrets.json.
  Exit code 0 on success, 1 on failure. Prints the dump path on success.

  STATUS: NOT executed on a real Windows host yet.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File backup.ps1 -Reason manual -CopyTo E:\ERP-Backups
#>
[CmdletBinding()]
param(
  [ValidateSet('nightly', 'shift-close', 'pre-upgrade', 'manual')]
  [string] $Reason = 'manual',
  [string] $AppDir = (Split-Path -Parent $PSScriptRoot),
  [string] $DataDir = (Join-Path $env:ProgramData 'SCG Shop ERP'),
  [int] $PgPort = 5433,
  # Copy the finished dump here too (USB drive, NAS share). Failure to copy is a warning only.
  [string] $CopyTo,
  [int] $Keep = 0
)

$ErrorActionPreference = 'Stop'
$retention = @{ 'nightly' = 30; 'shift-close' = 60; 'pre-upgrade' = 5; 'manual' = 20 }
if ($Keep -le 0) { $Keep = $retention[$Reason] }

$backupDir = Join-Path $DataDir 'backups'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$target = Join-Path $backupDir "erp-$stamp-$Reason.dump"
$partial = "$target.partial"

try {
  if ($env:DATABASE_URL) {
    $dbUrl = $env:DATABASE_URL
  } else {
    $secrets = Get-Content (Join-Path $DataDir 'config\secrets.json') -Raw | ConvertFrom-Json
    $dbUrl = "postgres://erp:$($secrets.dbPassword)@127.0.0.1:$PgPort/erp"
  }

  & (Join-Path $AppDir 'pgsql\bin\pg_dump.exe') --format=custom --compress=6 --no-owner `
    --file=$partial --dbname=$dbUrl
  if ($LASTEXITCODE -ne 0) { throw "pg_dump exited with $LASTEXITCODE" }
  Move-Item $partial $target -Force

  # Retention: keep the newest $Keep dumps for this reason.
  Get-ChildItem $backupDir -Filter "erp-*-$Reason.dump" | Sort-Object Name -Descending |
    Select-Object -Skip $Keep | Remove-Item -Force

  if ($CopyTo) {
    try { Copy-Item $target -Destination $CopyTo -Force }
    catch { Write-Warning "Backup written but copy to '$CopyTo' failed: $_" }
  }
  Write-Output $target
  exit 0
} catch {
  Remove-Item $partial -Force -ErrorAction SilentlyContinue
  $msg = "Backup ($Reason) failed: $_"
  Write-Error $msg -ErrorAction Continue
  try { Write-EventLog -LogName Application -Source 'SCG Shop ERP' -EventId 1001 -EntryType Error -Message $msg } catch {}
  exit 1
}
