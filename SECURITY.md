# Security Policy

## What is enforced (verify from code)

- Passwords: scrypt (N=16384, r=8, p=1) locally with timing-safe compare (`apps/api/src/db/store.js`).
  Argon2id (19 MiB, 2, 1) is the documented production target — **not yet implemented**; the
  `password_hash` column already stores PHC-shaped strings so the migration is a hasher swap.
- Login timing (SEC-011): unknown emails are verified against a fixed dummy scrypt hash, so
  response time does not reveal whether an account exists (≈33 ms both paths, measured in the
  hardening receipt; regression-gated in `apps/api/test/security.js`).
- Header hygiene (SEC-010): no `X-Powered-By` framework fingerprint; CSP/HSTS frame-ancestors
  policy at both the API and Next layers (`server.js:securityHeaders`, `apps/web/next.config.js`).
- JWT: 15-min access + rotating SHA-256 refresh with **family revocation on reuse**
  (`apps/api/src/middleware/auth.js:consumeRefresh`). Reusing a revoked token burns its family.
- Refresh cookie (SEC-012, formerly tracked as P2): the 30-day refresh token rides an
  **httpOnly, SameSite=Lax cookie scoped to `/api/v1/auth`** (`Secure` in production) — XSS
  cannot read it and it never rides non-auth requests. `POST /auth/logout` revokes the whole
  family server-side and clears the cookie; the JSON body field remains for non-browser
  clients (CLI/tests). Regression-gated by `TEST-SEC-COOKIE-1..4` in `apps/api/test/security.js`.
  The browser still holds only the 15-min access token in `localStorage` — the blast radius of
  an XSS token theft is one access-token window, not a 30-day refresh session.
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
  Proxy awareness (BUG-023): `req.ip` trusts proxy headers only when `TRUST_PROXY` is set
  (opt-in, `1` = one hop or a value like `loopback` for same-host Caddy) — without it the
  per-IP login throttle would see one IP behind the documented Caddy deploy profile.
- Audit: `LOGIN_SUCCESS`/`LOGIN_FAIL`/`REGISTER`/`LOGOUT`/`TOPUP`/`REFRESH_REUSE` are audit-logged
  (autonomous-txn in prod via `AUDIT_PKG`).
- Transport/storage: TLS via Caddy in deploy; no card data ever (wallet ledger only);
  `localStorage` holds only the 15-min access token; the refresh token is an httpOnly cookie (SEC-012).

## Grants (Oracle)

`VOLTHUB_APP_ROLE`: SELECT on business tables; INSERT/UPDATE only where justified; **no DELETE
anywhere**; no direct UPDATE on `connector.status` / `wallet_account.balance` / `wallet_ledger` /
`audit_log` / `meter_reading` — money-path writes go through `EXECUTE` on packages only
(`db/oracle/V004__triggers_grants.sql`).

## Demo credentials

Seeded logins in `README.md` are **demo-only** (`Admin@123` etc.). Rotate before any public
deploy; top-ups are capped (Rs.10,000/txn) and welcome credit is Rs.500.

Report issues privately to the repo owners.
