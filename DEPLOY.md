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

```bash
docker compose -f infra/docker-compose.yml up -d --build
curl -sf https://api.volthub.example/api/v1/health/deep
```

WS gateways connect to `wss://api.volthub.example/ocpp/<identity>` with
`Authorization: Basic base64(identity:secret)`.

## 3. First boot

```bash
bash scripts/migrate.sh          # V001..V005 + Timescale T001/T002
SEED_DB=1 bash scripts/migrate.sh # optional: package-driven seed (db/oracle/seed/seed.sql)
docker compose -f infra/docker-compose.yml up -d
curl -sf localhost:4000/api/v1/health/deep  # oracle:connected, outbox_lag: 0
```

## 4. Observability

- `GET /api/v1/health/deep` — `SELECT 1 FROM DUAL` + pool + Timescale reachability.
- `GET /api/v1/metrics` — Prometheus text (req rate, p95 ring, outbox depth, pool, OCPP).
- Grafana profile: `docker compose --profile observability up -d` (Timescale datasource + load dashboard).

## 5. Backups (one paragraph each)

- Oracle: nightly `expdp volthub/*** schemas=volthub directory=backups dumpfile=vh_%U.dmp` via cron on the host; keep 7 days.
- Timescale: nightly `pg_dump -h localhost -U volthub -Fc volthub > vh_ts_$(date +%F).dump`; retention policies (90/180d) already bound raw growth.

## 6. Offline demo fallback

Laptop compose is the graded path: `docker compose -f infra/docker-compose.yml up --build`
(one command, seeded demo data). If Oracle/Timescale containers fail, the API still boots
(`local-fallback` mode, honestly reported by `/health`) — demo the contract, not the engine.
