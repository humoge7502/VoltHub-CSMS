#!/usr/bin/env bash
# Migrate Oracle (numbered, single truth) + Timescale. Idempotent-ish for dev.
# CI truth: when sqlplus is absent on the runner but Oracle is up (service container),
# run migrations from inside the Oracle image (docker exec/run) instead of skipping.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ORACLE_HOST="${ORACLE_HOST:-localhost}"; ORACLE_PORT="${ORACLE_PORT:-1521}"; ORACLE_SERVICE="${ORACLE_SERVICE:-freepdb1}"
ORACLE_USER="${ORACLE_USER:-volthub}"; ORACLE_PASSWORD="${ORACLE_PASSWORD:-volthub_dev_pwd}"
echo "== Oracle ${ORACLE_HOST}:${ORACLE_PORT}/${ORACLE_SERVICE} =="
HAD_ORACLE_CLIENT=0
run_oracle_file() {
  local f="$1"
  echo "-- apply $f"
  if command -v sqlplus >/dev/null 2>&1; then
    HAD_ORACLE_CLIENT=1
    sqlplus -S "${ORACLE_USER}/${ORACLE_PASSWORD}@${ORACLE_HOST}/${ORACLE_SERVICE}" @"$f"
  elif command -v docker >/dev/null 2>&1; then
    HAD_ORACLE_CLIENT=1
    # Find the RUNNING Oracle container (compose name or CI service container by image).
    # Running the image via `docker run` boots a NEW database (gvenzl entrypoint demands
    # SYS/SYSTEM passwords) and never reaches sqlplus — exec into the live one instead.
    local cname
    cname="$(docker ps --format '{{.Names}}' 2>/dev/null | grep '^volthub-oracle$' || true)"
    if [ -z "$cname" ]; then
      cname="$(docker ps --filter 'ancestor=gvenzl/oracle-free:23-slim' --format '{{.Names}}' 2>/dev/null | head -1)"
    fi
    if [ -n "$cname" ]; then
      echo "   (sqlplus via docker exec ${cname})"
      docker exec -i "$cname" sqlplus -S "${ORACLE_USER}/${ORACLE_PASSWORD}@localhost/${ORACLE_SERVICE}" < "$f"
    else
      echo "   (no running Oracle container found — skipping; API runs on the local store)"
      return 1
    fi
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
  run_oracle_file "$ROOT/db/oracle/seed/seed.sql" || ORACLE_OK=0
fi
echo "== Timescale ${TS_HOST:-localhost}:${TS_PORT:-5432}/${TS_DB:-volthub} =="
TS_OK=1
if command -v psql >/dev/null 2>&1; then
  for f in "$ROOT"/db/timescale/T00*.sql; do
    echo "-- apply $f"
    PGPASSWORD="${TS_PASSWORD:-volthub_dev_pwd}" psql -h "${TS_HOST:-localhost}" -U "${TS_USER:-volthub}" -d "${TS_DB:-volthub}" -v ON_ERROR_STOP=1 -f "$f" || TS_OK=0
  done
else
  echo "(psql not installed — Timescale SQL is canonical in db/timescale/; telemetry falls back to local rollup.)"
fi
# Fail loudly when psql was available but a Timescale migration errored —
# CI must never pass on half-applied caggs (mirrors the Oracle guard above).
if command -v psql >/dev/null 2>&1 && [ "$TS_OK" != "1" ]; then
  echo "MIGRATE-FAIL: Timescale migrations did not apply (see errors above)." >&2
  exit 1
fi
# Fail loudly when an Oracle client was available but migrations did not apply —
# CI must never pass on an unmigrated database (round-1 "CI is partly theater" fix).
if [ "$HAD_ORACLE_CLIENT" = "1" ] && [ "$ORACLE_OK" != "1" ]; then
  echo "MIGRATE-FAIL: Oracle migrations did not apply (see errors above)." >&2
  exit 1
fi
