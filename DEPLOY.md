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

### Production overlay (required for anything reachable from the internet)

The base compose file is the laptop demo: `NODE_ENV` is unset, demo data is seeded, and
missing secrets fall back to published dev values. For a real deployment, add the
overlay — it sets `NODE_ENV=production`, requires `JWT_SECRET` / `INTERNAL_TOKEN` /
`AI_TOKEN` via `${VAR:?}` interpolation, disables welcome credit and unsigned top-ups,
and seeds no demo charge points (whose `dev-*` OCPP secrets are public):

```bash
docker compose --env-file .env \
  -f infra/docker-compose.yml -f infra/docker-compose.prod.yml up -d --build
```

With `NODE_ENV=production` the API refuses to boot on a missing/short/published
`JWT_SECRET` or `INTERNAL_TOKEN` (`apps/api/src/middleware/auth.js:assertBootSecrets`),
the worker refuses a published `INTERNAL_TOKEN`, the OCPP gateway rejects `dev-*`
charge-point secrets and ignores `OCPP_AUTH=off`, and the unsigned wallet top-up route
stays closed.

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
bash scripts/migrate.sh          # Oracle V*.sql + Timescale T*.sql (globbed, in order)
SEED_DB=1 bash scripts/migrate.sh # optional: package-driven seed (db/oracle/seed/seed.sql)
docker compose --env-file .env -f infra/docker-compose.yml up -d
curl -sf localhost:4000/api/v1/health/deep  # oracle:connected, outbox_lag: 0
```

Windows / Docker Desktop (the WSL docker CLI may not see the Windows engine):

```powershell
./scripts/migrate.ps1          # same canonical files, same order
./scripts/migrate.ps1 -Seed    # + demo seed
```

The migrate script globs `db/oracle/V00*.sql` and `db/timescale/T00*.sql`, so it picks
up new migrations automatically; it fails loudly (exit 1) when a client is present and
any migration errored, and says so when no client is available (the API then runs on
the local store rather than pretending).

## 4. Observability

- `GET /api/v1/health/deep` — `SELECT 1 FROM DUAL` + pool + Timescale reachability.
- `GET /api/v1/metrics` — Prometheus text (req rate, p95 ring, outbox depth/age, dead
  letters, relay heartbeat, pool, OCPP).
- Grafana profile: `docker compose --env-file .env -f infra/docker-compose.yml --profile observability up -d`
  (Timescale datasource + load dashboard, provisioned from `infra/grafana/`).

Three rules cover the telemetry pipeline; the old `lag_probe=ok` log line is gone because
it could not distinguish "the relay is busy" from "the relay is dead".

| Signal                              | Page when                                 | What it means                                                                                                                                             |
| ----------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `volthub_outbox_oldest_age_seconds` | > `RELAY_LAG_SLO_SECONDS` (120) for 5 min | The queue is not draining at fleet rate. Depth alone never fires a page — a busy fleet is legitimately deep.                                              |
| `volthub_relay_last_poll_seconds`   | `== -1`, or > 30                          | No worker has polled this API since boot / the worker stopped. Distinguishes a dead relay from a slow sink.                                               |
| `volthub_dead_letter_depth`         | any increase                              | The sink refused a row and the relay quarantined it. Triage at `GET /api/v1/ops/dead-letters` (replay or dismiss); the payload is stored with the letter. |

Queue size is bounded by `OUTBOX_RETENTION_HOURS` (acked rows age out; **unacked rows are
never dropped**), `OUTBOX_SOFT_CAP`/`OUTBOX_HARD_CAP` (memory guards — past the hard cap the
oldest _acked_ rows are shed) and `DEAD_LETTER_CAP`. The worker side is
`STATION_MAP_SYNC_SECONDS` (station metadata is re-synced per interval, not per 2 s poll) and
`TS_POOL_MAX` (one shared Timescale pool per worker process). All of them are in
`.env.example` and referenced from `infra/docker-compose.yml` — compose only passes variables
the YAML actually names, so a knob that is missing there is silently at its default.

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

Use `python` instead of `python3` on Windows — the `python3` on PATH there is the
Microsoft Store stub, which opens the store instead of running the script.

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
bash scripts/share-demo.sh        # Linux/macOS, or Git Bash on Windows
```

The script boots the compose stack, generates strong `JWT_SECRET` / `INTERNAL_TOKEN`
values in `.env` when needed, runs two cloudflared quick tunnels **as Docker containers
on the compose network** (web `:3000`, API `:4000` — they survive logout and auto-restart),
repoints the web build at the public API origin (`NEXT_PUBLIC_API_BASE` is baked at build
time), extends the API CORS allow-list to the public console origin, recreates the API and
worker, and health-checks both URLs plus a CORS preflight. It prints shareable
`https://<random>.trycloudflare.com` links.

- Free, HTTPS included, no ports opened (outbound-only tunnel), no Cloudflare account needed.
- Host ports for Oracle, Timescale, the API and the web console bind to `127.0.0.1`; the
  tunnel containers reach the services over the compose network, so nothing is exposed
  directly on the LAN or internet.
- `bash scripts/share-demo.sh --stop` tears the tunnels down; URLs change on each rerun —
  for a permanent name, create a **named tunnel** (free plan) or move to the VM path in §1–2.
- The script sets `TRUST_PROXY=1` and extends `WEB_ORIGIN` in `.env` for you (both
  interpolate through compose), so per-IP throttles keep working behind the tunnel.
- **Public-demo safety:** the seeded `arjun@volthub.in / Operator@123` and driver
  `Driver@123` logins, plus the deterministic `dev-*` OCPP secrets, are demo defaults.
  The admin credential is provisioned via `ADMIN_BOOTSTRAP_PASSWORD` and is not published;
  rotate `charge_point.auth_secret` (then start the simulator with the matching
  `OCPP_SECRET`) before exposing anything beyond disposable demo data.
