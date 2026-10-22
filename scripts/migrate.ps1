# VoltHub CSMS - Windows/Docker Desktop migration runner.
#
# The bash twin (scripts/migrate.sh) is the canonical path on Linux/macOS/CI. On
# Windows, WSL often has a `docker` binary that cannot see Docker Desktop's engine,
# so the bash script reports "no running Oracle container" even while the compose
# stack is healthy. This runner talks to the same live containers through the
# Windows docker CLI and applies the exact same canonical files.
#
# Usage (PowerShell, from the repo root, after `docker compose up -d oracle timescale`):
#   ./scripts/migrate.ps1              # V*.sql + T*.sql
#   ./scripts/migrate.ps1 -Seed        # + db/oracle/seed/seed.sql
#
# Notes:
#   - Run migrations in filename order. V008 is idempotent; V001..V007 are
#     first-boot migrations (re-running them on a populated DB is expected to fail).
#   - SQL*Plus needs WHENEVER SQLERROR or it exits 0 after failed statements.
#   - The password defaults match infra/docker-compose.yml; override with -OraclePassword.

[CmdletBinding()]
param(
  [switch]$Seed,
  [string]$OracleContainer = 'volthub-oracle',
  [string]$TimescaleContainer = 'volthub-timescale',
  [string]$OracleUser = 'volthub',
  [string]$OraclePassword = 'volthub_dev_pwd',
  [string]$OracleService = 'freepdb1',
  [string]$TsDb = 'volthub',
  [string]$TsUser = 'volthub',
  [string]$TsPassword = 'volthub_dev_pwd'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Assert-Running([string]$Name) {
  $running = & docker inspect -f '{{.State.Running}}' $Name 2>$null
  if ($LASTEXITCODE -ne 0 -or "$running".Trim() -ne 'true') {
    throw "container '$Name' is not running. Start it with: docker compose -f infra/docker-compose.yml up -d oracle timescale"
  }
}

function Invoke-OracleFile([System.IO.FileInfo]$File) {
  Write-Host "-- apply $($File.Name)"
  # Prefix in the pipe, not in the file: migrations stay plain SQL for every runner.
  $sql = "WHENEVER SQLERROR EXIT SQL.SQLCODE`n" + (Get-Content -Raw -LiteralPath $File.FullName)
  $sql | & docker exec -i $OracleContainer sqlplus -S "$OracleUser/$OraclePassword@localhost/$OracleService"
  if ($LASTEXITCODE -ne 0) { throw "Oracle migration failed: $($File.Name) (exit $LASTEXITCODE)" }
}

function Invoke-TimescaleFile([System.IO.FileInfo]$File) {
  Write-Host "-- apply $($File.Name)"
  $sql = Get-Content -Raw -LiteralPath $File.FullName
  $sql | & docker exec -i -e "PGPASSWORD=$TsPassword" $TimescaleContainer psql -U $TsUser -d $TsDb -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) { throw "Timescale migration failed: $($File.Name) (exit $LASTEXITCODE)" }
}

Assert-Running $OracleContainer
Assert-Running $TimescaleContainer

Write-Host "== Oracle $OracleContainer / $OracleService =="
Get-ChildItem -LiteralPath (Join-Path $root 'db/oracle') -Filter 'V*.sql' |
  Sort-Object Name |
  ForEach-Object { Invoke-OracleFile $_ }

if ($Seed) {
  $seedFile = Get-Item -LiteralPath (Join-Path $root 'db/oracle/seed/seed.sql')
  Write-Host '-- seed (db/oracle/seed/seed.sql)'
  Invoke-OracleFile $seedFile
}

Write-Host "== Timescale $TimescaleContainer / $TsDb =="
Get-ChildItem -LiteralPath (Join-Path $root 'db/timescale') -Filter 'T*.sql' |
  Sort-Object Name |
  ForEach-Object { Invoke-TimescaleFile $_ }

Write-Host 'MIGRATE-OK'
