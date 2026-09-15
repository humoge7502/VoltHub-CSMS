# DEPLOY.md — single-VM compose + TLS (course scope)

Target: one 4 GB VM, `docker compose` + Caddy for TLS. No K8s (see §15 reject list).

## 1. Provision

```bash
git clone <repo> && cd volthub-csms
cp .env.example .env   # then set real secrets below
```

Required secrets (fail-fast boot refuses defaults in prod-like profiles):

- `JWT_SECRET`: 32 random bytes — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `INTERNAL_TOKEN`: random string (worker ↔ API)
- `ORACLE_PASSWORD` / `TS_PASSWORD`: strong passwords

> **Pass `--env-file .env` to every compose command.** The compose file lives in
> `infra/`, so Compose's project directory is `infra/` and a `.env` at the repo root
> is _silently ignored_ — the stack then boots with the hardcoded dev `JWT_SECRET`
> and no overrides at all. Verified: `docker compose -f infra/docker-compose.yml
config` renders `JWT_SECRET: dev-only-32-byte-secret-0123456789` with a root `.env`
> present, and the right value with `--env-file .env`.
>
> `--env-file` feeds Compose's **interpolation only** (`${JWT_SECRET:-…}`), which is
> what you want: each service's explicit `environment:` block still wins, so the
> container-to-container wiring (`ORACLE_HOST: oracle`, `TS_HOST: timescale`) is not
> clobbered by the `localhost` values `.env.example` carries for bare-metal runs.

## 2. TLS (Caddy, auto-HTTPS, WS pass-through)

OCPP Basic-auth over `ws://` is plaintext — TLS is not optional once SEC-003 lands.

```caddyfile
# /etc/caddy/Caddyfile
api.volthub.example {
  reverse_proxy localhost:4000
}
app.volthub.example {
  reverse_proxy localhost:3000
}
```

Caddy terminates TLS on the same host, so the API must trust its proxy headers for
`req.ip`-based throttling to see real clients (BUG-023: without this, every request
looks like Caddy's IP and the per-IP login throttle becomes a platform-wide outage):

Set `TRUST_PROXY` on the `api` service (`infra/docker-compose.yml` environment) and
restart before exposing the stack behind Caddy. `TRUST_PROXY` is opt-in and off by
default: `1` trusts one hop; a value like `loopback` (Caddy on the same host) is
passed straight to Express `trust proxy`.

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d --build
curl -sf https://api.volthub.example/api/v1/health/deep
```

WS gateways connect to `wss://api.volthub.example/ocpp/<identity>` with
`Authorization: Basic base64(identity:secret)`.

## 3. First boot

```bash
bash scripts/migrate.sh          # Oracle V001..V007 + Timescale T001..T003 (globbed)
SEED_DB=1 bash scripts/migrate.sh # optional: package-driven seed (db/oracle/seed/seed.sql)
docker compose --env-file .env -f infra/docker-compose.yml up -d
curl -sf localhost:4000/api/v1/health/deep  # oracle:connected, outbox_lag: 0
```

The migrate script globs `db/oracle/V00*.sql` and `db/timescale/T00*.sql`, so it picks
up new migrations automatically; it fails loudly (exit 1) when a client is present and
any migration errored, and says so when no client is available (the API then runs on
the local store rather than pretending).

## 4. Observability

- `GET /api/v1/health/deep` — `SELECT 1 FROM DUAL` + pool + Timescale reachability.
- `GET /api/v1/metrics` — Prometheus text (req rate, p95 ring, outbox depth, pool, OCPP).
- Grafana profile: `docker compose --env-file .env -f infra/docker-compose.yml --profile observability up -d`
  (Timescale datasource + load dashboard, provisioned from `infra/grafana/`).

## 5. AI sidecar (optional)

The advisory service (`apps/ai`, ADR-0008) is **not** in the compose file — it needs a
Python runtime, and the API is designed to work without it: `/ai/*` returns
`503 AI_UNAVAILABLE` when it is unreachable, never a fabricated forecast. Run it on the
GPU host, reachable from the `api` container:

```bash
cd apps/ai && pip install -r requirements.txt
python3 train.py     # writes reports/model.pt (skip: forecast degrades to seasonal-naive)
python3 service.py   # uvicorn :8100, internal-token gated
# then point the API at it: AI_URL / AI_TOKEN in .env (same values both sides)
```

`AI_TOKEN` must match on both sides and is fail-fast in production, like the other
secrets. Keep it off the public internet — compose binds it to the private network and
the service rejects callers without `x-internal`.

## 6. Backups (one paragraph each)

- Oracle: nightly `expdp volthub/*** schemas=volthub directory=backups dumpfile=vh_%U.dmp` via cron on the host; keep 7 days.
- Timescale: nightly `pg_dump -h localhost -U volthub -Fc volthub > vh_ts_$(date +%F).dump`; retention policies (90/180d) already bound raw growth.

## 7. Offline demo fallback

Laptop compose is the graded path: `docker compose -f infra/docker-compose.yml up --build`
(one command, seeded demo data). If Oracle/Timescale containers fail, the API still boots
(`local-fallback` mode, honestly reported by `/health`) — demo the contract, not the engine.

## 8. Share a public demo link (no VM, no DNS)

To let anyone open the console from the internet while the stack runs on one machine:

```bash
bash scripts/share-demo.sh
```

The script boots the compose stack, runs two cloudflared quick tunnels **as Docker
containers** (web `:3000`, API `:4000` — they survive logout and auto-restart), repoints
the web build at the public API origin (`NEXT_PUBLIC_API_BASE` is baked at build time),
health-checks both, and prints shareable `https://<random>.trycloudflare.com` links.

- Free, HTTPS included, no ports opened (outbound-only tunnel), no Cloudflare account needed.
- `scripts/share-demo.sh --stop` tears the tunnels down; URLs change on each rerun —
  for a permanent name, create a **named tunnel** (free plan) or move to the VM path in §1–2.
- The script sets `TRUST_PROXY=1` and extends `WEB_ORIGIN` in `.env` for you (both now
  interpolate through compose), so per-IP throttles keep working behind the tunnel.
