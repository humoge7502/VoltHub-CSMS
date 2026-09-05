# Part XV — Security, Concurrency, and Performance

> Masterplan sections 30–32. Security is structural (grants, binds, hashing), concurrency is proven (races named and killed), performance is measured (not vibed).

---

## 30. Security

### 30.1 Authentication

- **Password hashing:** Argon2id (via `argon2` npm), memory 19 MiB, iterations 2, parallelism 1 — OWASP-recommended baseline; hashes stored as the encoded PHC string in `app_user.password_hash` (VARCHAR2(97)). Login re-derives and compares with constant-time verification. Password policy: 12+ chars, checked with a blocklist, never length-capped.
- **Tokens:** 15-minute access JWT (HS256, `sub`, `role`, `stationScope` claims) + 30-day refresh token, *stored hashed (SHA-256) in a `refresh_token` table with device metadata; rotation on every refresh; reuse of a rotated token revokes the family* (the standard theft-response). Logout revokes server-side.
- **Why not cookie sessions:** stateless API suits the demo and shows token lifecycle mastery; cookies remain a documented alternative for browser-only systems. CSRF risk is nil while we are header-bearer (no cookies); if cookies are ever adopted, SameSite=Strict + CSRF token notes are pre-written in the security doc.

### 30.2 Authorization (RBAC, twice)

API layer: NestJS guards + a `@Roles()` decorator; operators additionally scoped by `stationScope` claim (they only see their stations). Database layer (Section 13.2): `VOLTHUB_APP_ROLE` lacks DELETE everywhere, lacks UPDATE on ledger/audit/reading tables, and can reach state changes only through packages. Result: even a compromised API process cannot rewrite money history — defense in depth that can be *demonstrated* by attempting the forbidden UPDATE live in SQLcl.

### 30.3 Injection and input safety

- 100% bind variables (`node-oracledb` named binds); the codebase has zero string-concatenated SQL by convention and a lint rule (`eslint-plugin-security`) to keep it that way. Order-by/column names go through allow-lists, never interpolation (Section 19.3).
- Zod validation on every DTO boundary (types + ranges + string lengths); Oracle CHECK constraints re-validate the same invariants (the DB does not trust the app either).
- OCPP payloads are schema-validated (`packages/ocpp-messages`) before touching the database; unknown message types are logged and dropped.

### 30.4 Secrets, transport, CORS

Secrets via `.env` (git-ignored) + `.env.example` committed; in deployment they arrive as platform environment variables; the JWT secret is 32+ random bytes. Local traffic is HTTP-with-a-note (localhost demo); the deployed demo uses HTTPS via the platform's edge. CORS allow-list: the web origin only. Helmet sets HSTS, `X-Content-Type-Options`, frame-ancestors none.

### 30.5 Audit and sensitive data

Every state-changing mutation writes AUDIT_LOG (triggers + packages; NFR-05) with old/new JSON values. PII is minimal by design: name, email, phone; masked in operator views (`a***@vitstudent.ac.in`). **Payments:** no card data ever exists — the wallet is an internal ledger; this is stated in the README ("deliberately: real payments require PCI-DSS scope we refuse to fake"). Ledger rows are append-only by grant; reconciliation query Q19 (Part IX) proves balance integrity on demand.

---

## 31. Concurrency and Transactions

### 31.1 The race catalog (each row = a named, tested, handled race)

| # | Race | Mechanism that kills it | Test |
|---|---|---|---|
| R1 | Two drivers reserve the same connector window | `SELECT ... FOR UPDATE` on the connector row serializes writers; overlap check then fails the loser (15.2) | 2 parallel API calls → 201 + 409, exactly one row |
| R2 | Reservation window overlapping an *active session* | connector status check inside the same locked read (OCCUPIED is not bookable) | attempt during live simulated session → 409 |
| R3 | Station goes UNAVAILABLE while reservations exist | expiry/conversion path marks BOOKED rows CANCELLED with notification; blocked new bookings by status check | operator toggle mid-test → reservation cancelled, audit row |
| R4 | Wallet debited twice for one invoice | `FOR UPDATE` on the invoice row + status flip inside the same transaction (15.4) | 2 parallel pay calls → one SUCCESS, one 409 |
| R5 | Duplicate API requests (network retry) | Idempotency-Key table replays recorded response (18.6) | same key twice → identical bodies, one ledger row |
| R6 | Meter ticks out of order (OCPP retry) | per-session monotonic check BR-11 + `(session_id, seq_no)` PK absorbs duplicates | shuffled ticks → PK rejects dupes, package rejects regressions |
| R7 | Session state flapping (COMPLETED then CHARGING) | transition matrix + `FOR UPDATE` on session row (-20601) | illegal transition attempt → 409, audit row |
| R8 | Relay crash between sink insert and processed_at mark | at-least-once + sink dedupe key (Section 29) | kill -9 mid-batch → zero dupes in Timescale |

### 31.2 Isolation choices

Oracle default READ COMMITTED is correct for every flow *because the correctness arguments above use explicit row locks*, not isolation-level heroics. We document why SERIALIZABLE is unnecessary here (its retry-on-write-conflict burden would buy nothing once `FOR UPDATE` exists) — a sentence that usually impresses more than a wrong "we use SERIALIZABLE for safety".

### 31.3 The demo-ready proof

`apps/simulator/src/scenarios/race.ts` fires 2 concurrent `create_reservation` calls for the same connector/window and prints the verdict; `pnpm test:race` asserts it in CI (R1), plus the wallet double-pay test (R4). Two tests, each ~40 lines, worth more than any feature bullet in an interview.

---

## 32. Performance Optimization

### 32.1 Where the bottlenecks actually are (in order)

1. **Meter-tick ingest** (600k+ rows): solved by package batch path (`FORALL`-friendly single insert per tick is fine at our rate; DA3 uses COPY into Timescale).
2. **History/analytics scans**: solved by the index plan (Part V, 10.5) + `mv_station_daily` + (DA3) caggs.
3. **Dashboard round-trips**: solved by Q26 single-call header query and cursor pagination.
4. **Not bottlenecks (and said so)**: connection setup (pool), CPU, auth.

### 32.2 What we implement vs what we discuss

| Technique | Status | Notes |
|---|---|---|
| Composite indexes matched to named queries | **implemented** | every index traces to a query ID (Part V, 10.5) |
| Keyset pagination | **implemented** | Q15; OFFSET banned from list endpoints |
| Materialized view + scheduler refresh | **implemented** | mv_station_daily + DBMS_SCHEDULER (14.3) |
| Connection pooling | **implemented** | node-oracledb pool (18.3) |
| DBMS_APPLICATION_INFO | **implemented** | module/action per request — `V$SESSION` shows who is running what |
| Bind-variable caching (cursor cache) | discussed | falls out of binds; explained with `V$SQL` example |
| Partitioning | discussed | EE-only on Oracle; *realized instead* via Timescale chunks (the DA3 argument) |
| Compression | **implemented (DA3)** | 7-day policy on meter_tick, measured 10x+ |
| Retention policies | **implemented (DA3)** | 90d ticks / 180d state events |
| Redis cache | stretch only | requires a measured miss-rate to justify (6.4) |
| EXPLAIN PLAN habits | **implemented in CI** | `test:perf` fails if Q10 exceeds budget (500ms) on seeded data |

### 32.3 What "measured" means here

A `docs/perf.md` table with: query, dataset size, cold/warm latency, plan notes; plus the Section 28 micro-benchmarks. Claims stay within what a laptop demo can reproduce — the honesty rule (NFR-11) is itself a portfolio signal.
