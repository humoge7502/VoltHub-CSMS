# Security Policy

## What is enforced (verify from code)

- Passwords: scrypt (N=16384, r=8, p=1) locally with timing-safe compare (`apps/api/src/db/store.js`).
  Argon2id (19 MiB, 2, 1) is the documented production target — **not yet implemented**; the
  `password_hash` column already stores PHC-shaped strings so the migration is a hasher swap.
- JWT: 15-min access + rotating SHA-256 refresh with **family revocation on reuse**
  (`apps/api/src/middleware/auth.js:consumeRefresh`). Reusing a revoked token burns its family.
- Boot discipline: production (`NODE_ENV=production`) refuses
  to start with a missing/default `JWT_SECRET` or `INTERNAL_TOKEN` (fail-fast, `auth.js:secret`,
  `routes.js:internalOk`). Demo compose (ORACLE_HOST set, NODE_ENV unset) boots with a loud
  warning instead — one-command demo must work; production must not.
- RBAC: `authRequired` + `roles()` + operator station-scope on session state
  (`extended.js`). Session/live/telemetry/admin endpoints require auth; drivers see only their
  own sessions (403 otherwise). See `TEST-SEC-AUTHZ5` in `apps/api/test/security.js`.
- OCPP: Security Profile 1 — HTTP Basic on the WS upgrade against per-CP `auth_secret`
  (`apps/api/src/ocpp/gateway.js:checkBasic`); `Authorize` is allow-list only (`TAG-<user_id>`).
  TLS terminates at the platform (Caddy) in the deploy profile — see `DEPLOY.md`.
- Internal worker endpoints: `crypto.timingSafeEqual` compare on `x-internal` (no string `!==`).
- Throttle: tier from **signature-verified** JWT claims only; buckets keyed by verified `sub`
  else IP; idle buckets evicted (no unbounded growth). Per-process state (single-VM scope).
- Audit: `LOGIN_SUCCESS`/`LOGIN_FAIL`/`REGISTER`/`TOPUP`/`REFRESH_REUSE` are audit-logged
  (autonomous-txn in prod via `AUDIT_PKG`).
- Transport/storage: TLS via Caddy in deploy; no card data ever (wallet ledger only);
  `localStorage` holds the short-lived access token (httpOnly refresh cookie tracked as P2).

## Grants (Oracle)

`VOLTHUB_APP_ROLE`: SELECT on business tables; INSERT/UPDATE only where justified; **no DELETE
anywhere**; no direct UPDATE on `connector.status` / `wallet_account.balance` / `wallet_ledger` /
`audit_log` / `meter_reading` — money-path writes go through `EXECUTE` on packages only
(`db/oracle/V004__triggers_grants.sql`).

## Demo credentials

Seeded logins in `README.md` are **demo-only** (`Admin@123` etc.). Rotate before any public
deploy; top-ups are capped (Rs.10,000/txn) and welcome credit is Rs.500.

Report issues privately to the repo owners.
