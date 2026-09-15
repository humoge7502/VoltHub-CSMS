# Security Policy

## What is enforced (verify from code)

- Passwords: **Argon2id** (19 MiB, t=2, p=1 — the OWASP-recommended baseline) via
  `@node-rs/argon2` (prebuilt binaries, no node-gyp), stored as the standard PHC string in
  `app_user.password_hash` (`apps/api/src/db/store.js:hashPassword`). Legacy `$scrypt$…`
  rows (old seeds, pre-Argon2 durable rows) still verify — the migration needs no reset —
  and malformed/garbage stored hashes fail closed without throwing. Regression-gated by
  `TEST-SEC-ARGON2-1` in `apps/api/test/security.js`.
- Login timing (SEC-011): unknown emails are verified against a fixed dummy Argon2id hash
  (same parameters as real hashes), so response time does not reveal whether an account exists
  (re-measured medians 26 ms vs 26 ms — 0 ms gap — under Argon2id; regression-gated
  in `apps/api/test/security.js`).
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
- Rate-limit tiers (`middleware/security.js`, `server.js` — verify from code, not from this
  file): the **global per-role throttle** (60/min DRIVER, 120/min OPERATOR|ADMIN, override via
  `RATE_LIMIT_USER`) is the binding limit, and every authorizing router additionally mounts a
  `routerBarrier()` keyed by the same verified `sub` (SEC-006) with an IPv6-safe IP fallback.
  Be precise about what that buys: the barriers sit **at or above** the global tier, so they are
  a backstop plus a defense-in-depth net — not a new cap on normal traffic. The control plane is
  the one strictly stricter tier (**30/min per user**) because those routes actuate hardware.
  Login is its own **10/min per-IP** tier, and `/internal/*` is excluded from **every** tier
  (the relay polls it every 2 s and is token-gated). `RATE_LIMIT_OFF=1` bypasses every tier for
  load tests. Pinned by `apps/api/test/ratelimit.js` (RL-1..RL-7), which is the one suite that
  runs with limiting **on** — everywhere else it is off, which is why this tier went unverified
  until then.
- Connector state (BR-07): `connector.status` is writable only through the OCPP gateway or a
  PL/SQL package. `trg_connector_guard` (`db/oracle/V004__triggers_grants.sql`) accepts the write
  only while `SYS_CONTEXT('USERENV','CLIENT_IDENTIFIER')` is `ocpp-gw` or `pkg:<owner>`. That
  context is **session**-scoped, so every package write goes through a single
  `guard_pkg.set_status()` (`db/oracle/V003__packages.sql`), which opens the identity for exactly
  one statement and clears it on every exit path (including a raise out of the `UPDATE`). Before
  that (BUG-052) the packages set the identity and never cleared it, so a pooled connection
  stayed able to write `connector.status` directly for the rest of its life — measured on live
  Oracle 23ai: a fresh session was refused with `ORA-20801` while the same session was allowed
  the identical `UPDATE` right after `reservation_pkg.expire_stale` ran. `cancel_reservation`
  had in fact been relying on that leak to pass the guard at all. **What this does not cover:**
  the database owner can always set an identity and write directly — the guard constrains the
  application's paths, and it is the least-privilege role in this section that constrains the
  app's grants (that role layer is skipped when migrations run as the schema owner; see the note
  in V004). Gated by `GUARD-META-1/2/3` plus the Oracle behaviour probes in
  `test/sql/run-invariants.js`.
- Audit: `LOGIN_SUCCESS`/`LOGIN_FAIL`/`REGISTER`/`LOGOUT`/`TOPUP`/`REFRESH_REUSE` are audit-logged
  (autonomous-txn in prod via `AUDIT_PKG`).
- Transport/storage: TLS via Caddy in deploy; no card data ever (wallet ledger only);
  `localStorage` holds only the 15-min access token; the refresh token is an httpOnly cookie (SEC-012).

## Grants (Oracle)

`VOLTHUB_APP_ROLE`: SELECT on business tables; INSERT/UPDATE only where justified; **no DELETE
anywhere**; no direct UPDATE on `connector.status` / `wallet_account.balance` / `wallet_ledger` /
`audit_log` / `meter_reading` — money-path writes go through `EXECUTE` on packages only
(`db/oracle/V004__triggers_grants.sql`). `connector.status` is enforced twice: by the grant here
and, independently, by `trg_connector_guard` + `guard_pkg` — see the BR-07 bullet above.

## Demo credentials

Seeded logins in `README.md` are **demo-only** (`Admin@123` etc.). Rotate before any public
deploy; top-ups are capped (Rs.10,000/txn) and welcome credit is Rs.500.

Report issues privately to the repo owners.
