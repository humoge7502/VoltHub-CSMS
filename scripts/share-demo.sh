#!/usr/bin/env bash
# scripts/share-demo.sh — give VoltHub CSMS a public, shareable HTTPS link.
#
# What it does (beginner mode: you run one command):
#   1. ensures the compose stack is up (local profile is fine),
#   2. runs two cloudflared quick tunnels as Docker containers (web :3000, API :4000)
#      — containers survive logout/reboot and auto-restart,
#   3. repoints the web build at the PUBLIC API URL (NEXT_PUBLIC_* is baked in),
#   4. health-checks both public URLs and prints the links to share.
#
# Re-running generates fresh URLs — quick tunnels are ephemeral by design.
# Stop the tunnels with:  scripts/share-demo.sh --stop
# Stop everything with:   scripts/share-demo.sh --stop && docker compose -f infra/docker-compose.yml down
#
# Want a permanent URL? Use a named Cloudflare tunnel (DEPLOY.md §2) or a VM:
# this script is the free, zero-DNS, zero-VPS path for demos and sharing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="${ROOT}/infra/docker-compose.yml"
CF_IMAGE="cloudflare/cloudflared:latest"
C_API="volthub-tunnel-api"
C_WEB="volthub-tunnel-web"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found — install it first: curl -fsSL https://get.docker.com | sh" >&2
  exit 1
fi

ENV_ARGS=()
if [ -f "${ROOT}/.env" ]; then
  ENV_ARGS=(--env-file "${ROOT}/.env")
else
  echo "No .env found — creating one from the template (dev-default secrets; fine for a demo)."
  cp "${ROOT}/.env.example" "${ROOT}/.env"
  ENV_ARGS=(--env-file "${ROOT}/.env")
fi

compose() { docker compose "${ENV_ARGS[@]}" -f "${COMPOSE_FILE}" "$@"; }

set_env_key() { # key value — idempotent, preserves the rest of .env
  local key="$1" val="$2" file="${ROOT}/.env"
  touch "$file"
  if grep -qE "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$file"
  else
    printf '%s=%s\n' "$key" "$val" >> "$file"
  fi
}

stop_tunnels() {
  docker rm -f "$C_WEB" "$C_API" 2>/dev/null || true
  echo "Tunnels stopped."
}

if [ "${1:-}" = "--stop" ]; then stop_tunnels; exit 0; fi

echo "== 1/5 compose stack =="
compose up -d
compose ps --format '{{.Name}}: {{.Status}}'

docker image inspect "$CF_IMAGE" >/dev/null 2>&1 || docker pull -q "$CF_IMAGE" >/dev/null

echo "== 2/5 start tunnels (as durable containers) =="
stop_tunnels >/dev/null 2>&1 || true
docker run -d --name "$C_API" --restart unless-stopped --network host "$CF_IMAGE" \
  tunnel --no-autoupdate --url http://localhost:4000 >/dev/null
docker run -d --name "$C_WEB" --restart unless-stopped --network host "$CF_IMAGE" \
  tunnel --no-autoupdate --url http://localhost:3000 >/dev/null

wait_url() { # container — poll cloudflared logs for the trycloudflare URL
  local name="$1" url="" i
  for i in $(seq 1 45); do
    url="$(docker logs "$name" 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1 || true)"
    [ -n "$url" ] && { echo "$url"; return 0; }
    sleep 1
  done
  return 1
}

API_URL="$(wait_url "$C_API")" || { echo "ERROR: API tunnel URL not found — docker logs $C_API" >&2; exit 1; }
WEB_URL="$(wait_url "$C_WEB")" || { echo "ERROR: web tunnel URL not found — docker logs $C_WEB" >&2; exit 1; }
echo "   API: $API_URL"
echo "   Web: $WEB_URL"

echo "== 3/5 repoint web build at the public API URL =="
set_env_key NEXT_PUBLIC_API_BASE "${API_URL}/api/v1"
set_env_key NEXT_PUBLIC_SITE_URL "${WEB_URL}"
set_env_key WEB_ORIGIN "${WEB_URL}"
set_env_key TRUST_PROXY "1"
compose up -d --build web

echo "== 4/5 health checks =="
ok_api=0; ok_web=0
for i in $(seq 1 20); do
  curl -sf --max-time 10 "${API_URL}/api/v1/health" >/dev/null 2>&1 && ok_api=1 && break
  sleep 2
done
for i in $(seq 1 20); do
  curl -sf --max-time 10 "${WEB_URL}" >/dev/null 2>&1 && ok_web=1 && break
  sleep 2
done
[ "$ok_api" = 1 ] || echo "WARN: API public URL not responding yet — retry in a minute (docker logs $C_API)"
[ "$ok_web" = 1 ] || echo "WARN: web public URL not responding yet — retry in a minute (docker logs $C_WEB)"

echo "== 5/5 done =="
cat <<EOF

==========================================================
  VoltHub CSMS is now PUBLIC — share these links:

    Console:  ${WEB_URL}
    API:      ${API_URL}/api/v1/health

  Demo logins:
    admin@volthub.in / Admin@123      (admin)
    arjun@volthub.in / Operator@123   (operator)
    any seeded driver / Driver@123

  Make the demo lively (live kWh/kW/cost ticking):
    node apps/simulator/src/index.js --scenario normal

  Notes:
    - Tunnels run as Docker containers (auto-restart, survive logout).
    - Quick-tunnel URLs change on each rerun of this script.
    - Stop tunnels:  scripts/share-demo.sh --stop
    - Stop stack:    docker compose -f infra/docker-compose.yml down
==========================================================
EOF
