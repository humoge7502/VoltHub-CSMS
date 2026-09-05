# @volthub/api — modular-monolith REST + OCPP 1.6J gateway

Thin over the money-path: reads are hand SQL-shaped JSON, writes go through the
store packages that mirror `db/oracle/V003__packages.sql` procedure-for-procedure
(same names, same Oracle error numbers `-205xx…-208xx` → same HTTP mapping).

## Layout

- `src/server.js` — Express + WS upgrade routing, pino request IDs, error envelope (`{error:{code,message,ora?,requestId}}`), security headers, per-role throttle
- `src/routes.js` — core: auth, vehicles, stations, reservations, sessions, billing, faults, analytics, telemetry, admin, worker-internal, health
- `src/extended.js` — tariffs-public, reviews feed, notifications, vehicle default, operator state control, admin hardware CRUD + OCPP provisioning
- `src/docs.js` — hand-maintained OpenAPI 3.0 served at `GET /api/v1/docs`
- `src/db/store.js` — OLTP reference implementation (mutex = `SELECT … FOR UPDATE`)
- `src/db/seed.js` — deterministic story seed (RNG `20260904`)
- `src/ocpp/gateway.js` — 1 socket/CP, 10 msg/s, Boot→Stop lifecycle
- `src/middleware/` — `auth.js` (JWT 15m + rotating refresh + RBAC + station scope), `security.js`

## Run / test

```bash
npm run dev          # :4000, demo seed
npm test             # 16 API tests
npm run test:race    # R1 double-reserve + R4 double-pay
```
