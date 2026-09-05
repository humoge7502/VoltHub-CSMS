#!/usr/bin/env bash
# End-to-end demo: boots API, runs race proof + a live session + burst.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-4000}"
node "$ROOT/apps/api/src/server.js" & API_PID=$!
sleep 2
export API_BASE="http://localhost:$PORT/api/v1"
echo "--- R1 race (expect 201+409, exactly one winner) ---"
node "$ROOT/apps/simulator/src/index.js" --api "$API_BASE" --scenario race || true
echo "--- normal session ---"
node "$ROOT/apps/simulator/src/index.js" --api "$API_BASE" --scenario normal --chargers 1 || true
echo "--- health ---"
curl -s "$API_BASE/health"; echo
kill $API_PID
