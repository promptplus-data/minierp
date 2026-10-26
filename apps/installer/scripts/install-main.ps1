<#
.SYNOPSIS
  Configures the MAIN machine after Inno Setup has copied the files.
  Idempotent: runs on first install and on every upgrade.

.DESCRIPTION
  1. Creates the data directory (pgdata, certs, backups, logs, config).
  2. Generates secrets once (DB password, JWT secret, PFX password) into config\secrets.json.
  3. initdb the bundled PostgreSQL on first install (127.0.0.1:5433, scram-sha-256).
  4. Generates a self-signed TLS certificate (hostname + LAN IPs) once.
  5. Registers/updates the WinSW services scgerp-postgres and scgerp-server.
  6. Starts PostgreSQL, creates the erp role and database, runs migrations.
  7. Opens the firewall for the HTTPS port and mDNS on the Private profile only.
  8. Registers the nightly backup scheduled task, then starts the server.

  STATUS: written for Windows PowerShell 5.1, NOT executed on a real Windows host yet.
  Log: <DataDir>\logs\install-main.log
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $AppDir,
  [Parameter(Mandatory)] [string] $DataDir,
  [int] $HttpsPort = 8443,
  [int] $PgPort = 5433
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$Pg = Join-Path $AppDir 'pgsql\bin'
$Services = Join-Path $AppDir 'services'
$Dirs = @{
  pgdata  = Join-Path $DataDir 'pgdata'
  certs   = Join-Path $DataDir 'certs'
  backups = Join-Path $DataDir 'backups'
  logs    = Join-Path $DataDir 'logs'
  config  = Join-Path $DataDir 'config'
}
foreach ($d in $Dirs.Values) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
Start-Transcript -Path (Join-Path $Dirs.logs 'install-main.log') -Append | Out-Null

function New-Secret([int] $Length = 32) {
  # Alphanumeric only: safe inside XML, URLs and command lines without escaping.
  $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] $Length
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

function Set-RestrictedAcl([string] $Path, [switch] $AllowLocalService) {
  # SYSTEM + Administrators full control, optionally LocalService (service account), nobody else.
  $grants = @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
  if ($AllowLocalService) { $grants += '*S-1-5-19:(OI)(CI)M' }
  $icaclsArgs = @($Path, '/inheritance:r') + ($grants | ForEach-Object { '/grant:r'; $_ })
  & icacls.exe @icaclsArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed on $Path" }
}

function Invoke-Native([string] $Exe, [string[]] $Arguments) {
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Exe $($Arguments -join ' ') exited with $LASTEXITCODE" }
}

function Wait-Postgres {
  for ($i = 0; $i -lt 60; $i++) {
    & (Join-Path $Pg 'pg_isready.exe') -h 127.0.0.1 -p $PgPort -q
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep -Seconds 1
  }
  throw "PostgreSQL did not become ready on 127.0.0.1:$PgPort"
}

# ---- 2. secrets (generated once, preserved across upgrades) ------------------
$secretsFile = Join-Path $Dirs.config 'secrets.json'
if (Test-Path $secretsFile) {
  $secrets = Get-Content $secretsFile -Raw | ConvertFrom-Json
} else {
  $secrets = [pscustomobject]@{
    pgSuperPassword = New-Secret
    dbPassword      = New-Secret
    jwtSecret       = New-Secret 48
    pfxPassword     = New-Secret
  }
  $secrets | ConvertTo-Json | Set-Content -Path $secretsFile -Encoding UTF8
}
Set-RestrictedAcl $Dirs.config -AllowLocalService

# ---- 3. initdb (first install only) ------------------------------------------
Set-RestrictedAcl $Dirs.pgdata -AllowLocalService
Set-RestrictedAcl $Dirs.logs -AllowLocalService
# The server (LocalService) runs backup.ps1 after shift close, so it needs write access here.
Set-RestrictedAcl $Dirs.backups -AllowLocalService
if (-not (Test-Path (Join-Path $Dirs.pgdata 'PG_VERSION'))) {
  Write-Host 'Initialising PostgreSQL cluster...'
  $pwFile = Join-Path $Dirs.config 'pgsuper.tmp'
  Set-Content -Path $pwFile -Value $secrets.pgSuperPassword -NoNewline -Encoding ASCII
  try {
    Invoke-Native (Join-Path $Pg 'initdb.exe') @('-D', $Dirs.pgdata, '-U', 'postgres', "--pwfile=$pwFile",
      '--auth=scram-sha-256', '-E', 'UTF8', '--no-locale')
  } finally { Remove-Item $pwFile -Force -ErrorAction SilentlyContinue }
  Add-Content -Path (Join-Path $Dirs.pgdata 'postgresql.auto.conf') -Encoding ASCII -Value @(
    "listen_addresses = '127.0.0.1'",
    "port = $PgPort",
    "logging_collector = on",
    "log_directory = '$($Dirs.logs -replace '\\','/')'",
    "log_filename = 'postgresql-%a.log'",
    "log_truncate_on_rotation = on"
  )
  # initdb ran as the installing admin; the service runs as LocalService.
  Set-RestrictedAcl $Dirs.pgdata -AllowLocalService
}

# ---- 4. self-signed TLS certificate (once) -----------------------------------
$pfx = Join-Path $Dirs.certs 'server.pfx'
$cer = Join-Path $Dirs.certs 'scg-shop-erp-main.cer'
if (-not (Test-Path $pfx)) {
  Write-Host 'Generating self-signed TLS certificate...'
  $hostName = $env:COMPUTERNAME
  $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress
  $san = @("DNS=$hostName", "DNS=$hostName.local", 'DNS=localhost') + ($ips | ForEach-Object { "IPAddress=$_" })
  $cert = New-SelfSignedCertificate -Subject "CN=$hostName SCG Shop ERP" -FriendlyName 'SCG Shop ERP (LAN)' `
    -CertStoreLocation 'Cert:\LocalMachine\My' -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears(10) -TextExtension @("2.5.29.17={text}$($san -join '&')")
  $pfxPw = ConvertTo-SecureString $secrets.pfxPassword -AsPlainText -Force
  Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pfxPw | Out-Null
  Export-Certificate -Cert $cert -FilePath $cer | Out-Null   # public part, for client machines to trust
  Remove-Item "Cert:\LocalMachine\My\$($cert.Thumbprint)" -ErrorAction SilentlyContinue
  # NOTE: if the main machine's IP changes, delete certs\server.pfx and re-run this script.
}
Set-RestrictedAcl $Dirs.certs -AllowLocalService

# ---- 5. WinSW services --------------------------------------------------------
function Install-WinswService([string] $Id, [hashtable] $Tokens) {
  $exe = Join-Path $Services "$Id.exe"
  $xml = Join-Path $Services "$Id.xml"
  Copy-Item (Join-Path $AppDir 'winsw\WinSW-x64.exe') $exe -Force
  $text = Get-Content (Join-Path $AppDir "winsw\$Id.xml.template") -Raw
  foreach ($k in $Tokens.Keys) { $text = $text.Replace("{{$k}}", [System.Security.SecurityElement]::Escape([string]$Tokens[$k])) }
  Set-Content -Path $xml -Value $text -Encoding UTF8
  if (-not (Get-Service -Name $Id -ErrorAction SilentlyContinue)) {
    Invoke-Native $exe @('install')
  }
  # postgres.exe refuses administrator rights; run both services unprivileged.
  # (Built-in accounts take no password; PS 5.1 would drop an empty-string argument anyway.)
  Invoke-Native 'sc.exe' @('config', $Id, 'obj=', 'NT AUTHORITY\LocalService')
}

New-Item -ItemType Directory -Force -Path $Services | Out-Null
Set-RestrictedAcl $Services -AllowLocalService
$tokens = @{
  APP_DIR = $AppDir; DATA_DIR = $DataDir; PG_PORT = $PgPort; PG_MAJOR = '16'; HTTPS_PORT = $HttpsPort
  DB_PASSWORD = $secrets.dbPassword; JWT_SECRET = $secrets.jwtSecret; PFX_PASSWORD = $secrets.pfxPassword
}
Install-WinswService 'scgerp-postgres' $tokens
Install-WinswService 'scgerp-server' $tokens

# ---- 6. database, role, migrations -------------------------------------------
Start-Service scgerp-postgres
Wait-Postgres
$env:PGPASSWORD = $secrets.pgSuperPassword
$psql = Join-Path $Pg 'psql.exe'
$roleExists = & $psql -h 127.0.0.1 -p $PgPort -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='erp'"
if ($roleExists -ne '1') {
  Invoke-Native $psql @('-h', '127.0.0.1', '-p', $PgPort, '-U', 'postgres', '-v', 'ON_ERROR_STOP=1',
    '-c', "CREATE ROLE erp LOGIN PASSWORD '$($secrets.dbPassword)'", '-c', 'CREATE DATABASE erp OWNER erp')
}
Remove-Item Env:PGPASSWORD

$migrate = Join-Path $AppDir 'server\migrate.mjs'
if (Test-Path $migrate) {
  Write-Host 'Running database migrations...'
  $env:DATABASE_URL = "postgres://erp:$($secrets.dbPassword)@127.0.0.1:$PgPort/erp"
  $env:MIGRATIONS_DIR = Join-Path $AppDir 'server\migrations'
  $env:EDITION = 'onprem'
  try { Invoke-Native (Join-Path $AppDir 'node\node.exe') @($migrate) }
  finally { Remove-Item Env:DATABASE_URL, Env:MIGRATIONS_DIR, Env:EDITION -ErrorAction SilentlyContinue }
} else {
  Write-Warning 'server\migrate.mjs not found in this build; skipping migrations.'
}

# ---- 7. firewall: Private (LAN) profile only ---------------------------------
$rules = @(
  @{ Name = 'SCGShopERP-HTTPS'; DisplayName = 'SCG Shop ERP (HTTPS, LAN)'; Protocol = 'TCP'; LocalPort = $HttpsPort },
  @{ Name = 'SCGShopERP-mDNS';  DisplayName = 'SCG Shop ERP (mDNS discovery, LAN)'; Protocol = 'UDP'; LocalPort = 5353 }
)
foreach ($r in $rules) {
  Remove-NetFirewallRule -Name $r.Name -ErrorAction SilentlyContinue
  New-NetFirewallRule -Name $r.Name -DisplayName $r.DisplayName -Direction Inbound -Action Allow `
    -Protocol $r.Protocol -LocalPort $r.LocalPort -Profile Private -RemoteAddress LocalSubnet | Out-Null
}
$public = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object NetworkCategory -eq 'Public'
if ($public) {
  Write-Warning "Network '$($public.Name -join ', ')' is set to Public. Client machines cannot connect until it is set to Private."
}

# ---- 8. nightly backup task + start server -----------------------------------
$backup = Join-Path $AppDir 'scripts\backup.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$backup`" -Reason nightly"
$trigger = New-ScheduledTaskTrigger -Daily -At '23:30'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName 'SCG Shop ERP nightly backup' -Action $action -Trigger $trigger `
  -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null

Start-Service scgerp-server
Write-Host "Main machine ready: https://$($env:COMPUTERNAME):$HttpsPort"
Stop-Transcript | Out-Null
