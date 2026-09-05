#!/usr/bin/env bash
# Migrate Oracle (numbered, single truth) + Timescale. Idempotent-ish for dev.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "== Oracle ${ORACLE_HOST:-localhost}:${ORACLE_PORT:-1521}/${ORACLE_SERVICE:-freepdb1} =="
if command -v sqlplus >/dev/null 2>&1; then
  for f in "$ROOT"/db/oracle/V00*.sql; do
    echo "-- apply $f"
    sqlplus -S "${ORACLE_USER:-volthub}/${ORACLE_PASSWORD:-volthub_dev_pwd}@${ORACLE_HOST:-localhost}/${ORACLE_SERVICE:-freepdb1}" @"$f"
  done
else
  echo "(sqlplus not installed — Oracle SQL is canonical in db/oracle/; API runs on the local store. Install Oracle Instant Client to apply.)"
fi
echo "== Timescale ${TS_HOST:-localhost}:${TS_PORT:-5432}/${TS_DB:-volthub} =="
if command -v psql >/dev/null 2>&1; then
  for f in "$ROOT"/db/timescale/T00*.sql; do
    echo "-- apply $f"
    PGPASSWORD="${TS_PASSWORD:-volthub_dev_pwd}" psql -h "${TS_HOST:-localhost}" -U "${TS_USER:-volthub}" -d "${TS_DB:-volthub}" -f "$f"
  done
else
  echo "(psql not installed — Timescale SQL is canonical in db/timescale/; telemetry falls back to local rollup.)"
fi
