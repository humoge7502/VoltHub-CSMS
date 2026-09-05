#!/usr/bin/env bash
# Migrate Oracle (numbered, single truth) + Timescale. Idempotent-ish for dev.
# CI truth: when sqlplus is absent on the runner but Oracle is up (service container),
# run migrations from inside the Oracle image (docker exec/run) instead of skipping.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ORACLE_HOST="${ORACLE_HOST:-localhost}"; ORACLE_PORT="${ORACLE_PORT:-1521}"; ORACLE_SERVICE="${ORACLE_SERVICE:-freepdb1}"
ORACLE_USER="${ORACLE_USER:-volthub}"; ORACLE_PASSWORD="${ORACLE_PASSWORD:-volthub_dev_pwd}"
echo "== Oracle ${ORACLE_HOST}:${ORACLE_PORT}/${ORACLE_SERVICE} =="
run_oracle_file() {
  local f="$1"
  echo "-- apply $f"
  if command -v sqlplus >/dev/null 2>&1; then
    sqlplus -S "${ORACLE_USER}/${ORACLE_PASSWORD}@${ORACLE_HOST}/${ORACLE_SERVICE}" @"$f"
  elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^volthub-oracle$'; then
    # In-container sqlplus via the running compose/service container (fixes old "skip" path).
    docker exec -i volthub-oracle sqlplus -S "${ORACLE_USER}/${ORACLE_PASSWORD}@localhost/${ORACLE_SERVICE}" < "$f"
  elif command -v docker >/dev/null 2>&1; then
    docker run --rm --network host -v "$ROOT/db/oracle:/sql:ro" gvenzl/oracle-free:23-slim \
      sqlplus -S "${ORACLE_USER}/${ORACLE_PASSWORD}@${ORACLE_HOST}/${ORACLE_SERVICE}" @"/sql/$(basename "$f")"
  else
    echo "(sqlplus/docker both absent — Oracle SQL is canonical in db/oracle/; API runs on the local store.)"
    return 1
  fi
}
ORACLE_OK=1
for f in "$ROOT"/db/oracle/V00*.sql; do
  run_oracle_file "$f" || ORACLE_OK=0
done
if [ "$ORACLE_OK" = "1" ] && [ -f "$ROOT/db/oracle/seed/seed.sql" ] && [ "${SEED_DB:-0}" = "1" ]; then
  echo "-- seed (SEED_DB=1)"
  run_oracle_file "$ROOT/db/oracle/seed/seed.sql" || true
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
