<#
.SYNOPSIS
  CI only: downloads the Windows runtime pieces into apps/installer/build/.
    build\node\      Node.js 22 win-x64 (latest 22.x, SHA256 checked against SHASUMS256.txt)
    build\pgsql\     PostgreSQL binaries zip from EnterpriseDB, trimmed (no pgAdmin/StackBuilder/docs)
    build\winsw\     WinSW-x64.exe v2.12.0
  Used by .github/workflows/release-windows.yml. Bump -PgVersion when a new 16.x minor ships.
#>
param(
  [string] $OutDir = (Join-Path $PSScriptRoot '..\build'),
  [string] $NodeMajor = '22',
  [string] $PgVersion = '16.10-1',
  [string] $PgSha256 = '',
  [string] $WinswVersion = 'v2.12.0'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$tmp = Join-Path $OutDir '_downloads'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Get-File([string] $Url, [string] $Dest) {
  Write-Host "GET $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
}
function Assert-Sha256([string] $File, [string] $Expected) {
  $actual = (Get-FileHash $File -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) { throw "SHA256 mismatch for $File`n expected $Expected`n actual   $actual" }
}

# ---- Node ----------------------------------------------------------------------
$index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
$nodeVer = ($index | Where-Object { $_.version -like "v$NodeMajor.*" } | Select-Object -First 1).version
$nodeZip = "node-$nodeVer-win-x64.zip"
Get-File "https://nodejs.org/dist/$nodeVer/$nodeZip" (Join-Path $tmp $nodeZip)
$sums = (Invoke-WebRequest "https://nodejs.org/dist/$nodeVer/SHASUMS256.txt" -UseBasicParsing).Content
$expected = ($sums -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape($nodeZip))$" }) -split '\s+' | Select-Object -First 1
Assert-Sha256 (Join-Path $tmp $nodeZip) $expected
Expand-Archive (Join-Path $tmp $nodeZip) -DestinationPath $tmp -Force
Remove-Item (Join-Path $OutDir 'node') -Recurse -Force -ErrorAction SilentlyContinue
Move-Item (Join-Path $tmp "node-$nodeVer-win-x64") (Join-Path $OutDir 'node')
Write-Host "Node $nodeVer -> build\node"

# ---- PostgreSQL ----------------------------------------------------------------
$pgZip = "postgresql-$PgVersion-windows-x64-binaries.zip"
Get-File "https://get.enterprisedb.com/postgresql/$pgZip" (Join-Path $tmp $pgZip)
if ($PgSha256) { Assert-Sha256 (Join-Path $tmp $pgZip) $PgSha256 } else { Write-Warning 'PgSha256 not set: PostgreSQL zip not checksum-verified' }
Remove-Item (Join-Path $OutDir 'pgsql') -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive (Join-Path $tmp $pgZip) -DestinationPath $OutDir -Force   # zip root folder is "pgsql"
foreach ($drop in 'pgAdmin 4', 'StackBuilder', 'doc', 'include', 'symbols') {
  Remove-Item (Join-Path $OutDir "pgsql\$drop") -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "PostgreSQL $PgVersion -> build\pgsql"

# ---- WinSW ---------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'winsw') | Out-Null
Get-File "https://github.com/winsw/winsw/releases/download/$WinswVersion/WinSW-x64.exe" (Join-Path $OutDir 'winsw\WinSW-x64.exe')

Remove-Item $tmp -Recurse -Force
