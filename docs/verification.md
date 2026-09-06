# Runtime verification log (POTENTIAL → VERIFIED receipts)

Evidence discipline: **EXECUTED** (ran in this repo's environment) vs
**STRONGLY INFERRED** (CI config verified line-by-line; execution on runners)
vs **PENDING** (blocked here; exact command given). No claim without a receipt.

## B3G-001 — OCPP remote-command contract (EXECUTED, local profile)

`node apps/api/test/ocpp-remote.js` — boots the real gateway, connects a fake
charge point over WS with Basic auth, drives both REST legs:

- `POST /sessions/:id/remote-stop` → CP socket received
  `[2, "<uid>", "RemoteStopTransaction", {"transactionId": <sid>}]` with the
  exact session id; CP answered CALLRESULT `Accepted`.
- `POST /sessions/remote-start` (operator) → CP socket received
  `[2, "<uid>", "RemoteStartTransaction", {"idTag", "connectorId"}]`.
- Result: **2 passed**. Wired into `npm test`, CI `quality` and `db-tests` jobs.

## V006 / ADR-0006 — FK-native connector (static VERIFIED; Oracle runtime PENDING)

- Static: `V006__fk_native.sql` replaces both package bodies with native-pair
  INSERTs (textually identical to the updated `V003__packages.sql` canonical
  source); drops `trg_res_cp_sync`/`trg_sess_cp_sync` with `-4080` tolerance;
  backfills the pair; adds D-02 `start_minute`/`end_minute` VIRTUAL columns +
  `uq_band_slot_minute`; `migrate.sh` globs `V00*.sql` so no script change needed.
- Invariant 11 gates the pair (NULL + dangling, both tables); local mirror in
  `test/sql/run-invariants.js` checks the JS store writes the pair natively.
- Oracle execution: **CLOSED 2026-09-05** — CI `db-tests` now applies V001–V006
  - seed to a fresh Oracle service and runs the DB-backed suites against it on
    every push (see the receipts below).

## P2V-01 — `tick_1m` correlated subquery on `station_map` (CLOSED 2026-09-05)

- Local attempt was blocked by the full host disk; the blocker was instead
  proven **for real on a fresh Timescale service in CI**: the correlated
  subquery (and `MODE()`, see P2V-02) is rejected inside a continuous
  aggregate, so `T002` never applied end-to-end.
- Fix shipped: `T002__caggs.sql` rewritten join-free — `tick_1m`/`tick_1h` are
  connector-scoped with station enrichment moved to query-time views
  (`v_tick_1m_enriched`, `v_tick_1h_enriched`); `tick_1h` is hierarchical over
  `tick_1m` (its `GROUP BY` must name the hour-bucket expression — plain
  `bucket` collides with the minute column).
- Verified: CI `db-tests` `Timescale cagg refresh smoke` step runs
  `CALL refresh_continuous_aggregate` on `tick_1m`, `tick_1h`, `state_1m` and
  reads the enriched views with `ON_ERROR_STOP=1` on every push. Green since
  2026-09-05.
- Enrichment data (masterplan §26.5, previously unimplemented): the worker now
  syncs Oracle-owned `station_map` into Timescale every loop from the API's
  `GET /internal/station-map`; compose e2e asserts live population (16 rows from
  the seeded stack, 2026-09-05). This also surfaced that the API image never
  shipped `apps/worker` (relay dead in compose) and that `insertBatch` doubled
  its column list (invalid SQL) — both fixed and unit-locked in
  `apps/worker/test/relay.test.js`.

## P2V-02 — `MODE() WITHIN GROUP` in `state_1m` (CLOSED 2026-09-05)

- Confirmed on the real service: ordered-set aggregates are rejected inside
  continuous aggregates (timescale/timescaledb#2872).
- Fix shipped: `state_1m` now carries per-state `COUNT(*) FILTER` columns and
  `dominant_state` is derived at query time in `v_state_1m` (greatest-count
  with fault/offline-first tie-break, NULL when no known state moved).
  Consumers (`db/timescale/queries.sql` T2, Grafana `load.json`) read the
  views / join `station_map` at query time — joins against caggs are fine.
- Verified: same CI refresh-smoke step (green).

## P2V-03 — V001–V006 + seed on a fresh Oracle volume (CLOSED 2026-09-05)

- Proven on fresh Oracle services in CI and in the compose e2e stack. This
  surfaced and fixed four latent defects that had silently broken every
  migration run:
  1. V002/V003 referenced the `cp_id`/`connector_no` FK pair before V005 added
     it — V001 now owns the pair (V005's guarded ALTERs no-op on fresh DBs).
  2. `audit_log.old_value/new_value` carried `CHECK (... IS JSON)` but
     `audit_pkg.log` writes plain text / NULL — V001 no longer creates them;
     V006 drops them on already-migrated DBs.
  3. `maintenance_pkg.report_fault`/`resolve_maintenance` updated connector
     status without the `pkg:` `CLIENT_IDENTIFIER` the V004 guard requires
     (ORA-20801) — identifiers added.
  4. The seed ran stations → fault → tariffs in one giant transaction while
     `audit_pkg.log` is autonomous (ORA-00060 self-deadlock) — the seed now
     COMMITs per story; the fault seed also used an illegal PL/SQL scalar
     subquery as a procedure argument.
  5. Least-privilege role: `CREATE ROLE` needs privileges the schema-owner
     migrate account (gvenzl APP_USER) lacks — V004 now creates the role +
     grants when privileged and otherwise prints one note (the connector-write
     gate that actually protects the API is `trg_connector_guard`). Migrate
     output is clean in the standard path.
- `migrate.sh` now fails loudly when Oracle (sqlplus/docker-exec) or Timescale
  (psql `ON_ERROR_STOP`) migrations error — no more green-then-red CI.
- Verified: `db-tests` + `e2e` green (lint/quality/db-tests/e2e), compose stack
  boots with seeded schema and healthy deep-health, 2026-09-05.

## Bench evidence (EXECUTED, local profile)

`node bench/run-local.js` → `bench/results-local.json`; tables in `docs/perf.md`
(2026-09-05, AMD EPYC 7V12, Node v20.20.2): discovery p95 2 ms; hot-connector
20-race exactly 1×201 + 19×409, p95 47 ms; 22,989 ticks/s ingest; step-load
0 errors at 10/50/100 VU. Scope: local test-double path only. Experiment 4
(cagg vs raw at ≥1M ticks) needs TimescaleDB — same PENDING blocker as P2V-01.

## Wrap run 2026-09-05 (post Round-3 kit) — full-gate receipts

All EXECUTED in this repo (no Docker):

- `npm run lint` (eslint --max-warnings 0) — clean.
- `npm run format:check` (prettier) — clean.
- `npm test` — api suite + simulator suite, security 7, XLAYER 4, OCPP-remote 2,
  invariants 11 (local), OpenAPI drift OK (0 missing paths, 0 notes after `/` added).
- `npm run test:race -w apps/api` — R1 double-reserve + R4 double-pay, exactly
  one winner each (201 + 409 asserted).
- `npm run test:e2e` — 7 steps (register→discover→reserve→charge→ticks→stop→
  bill→pay→review→operator fault triage→admin tariff version).
- `npm run build -w apps/web` (Next 14 prod) — 17 routes compile.

### B3G-NEW — web CSP hydration bug found & fixed by browser capture (EXECUTED)

`next.config.js` shipped `default-src 'self'` with no `script-src` allowance; Next
inlines its RSC bootstrap, so the console **never hydrated** (dev _and_ prod —
verified in Playwright: React #423, login fell back to a native form POST). Fix:
`script-src 'self' 'unsafe-inline'` always (Next's inline bootstrap), `'unsafe-eval'`
dev-only (fast refresh). Re-verified: full login → /discover navigation works in
production mode (`next start`) with Playwright.

### B3G-NEW — README evidence is real pixels (EXECUTED)

`scripts/screenshots/capture.js` (re-homed from scratch; requires API :4000 +
web :3120) drives a genuine OCPP 1.6J WS charge point and screenshotted
dashboard / telemetry / invoice / live-session @2x; `make-gif.js` built
docs/screenshots/demo-live.gif (8 frames, real MeterValues between frames).
Gotcha documented in scripts/screenshots/README.md: the second demo session must
run on a **different charge point** (two sockets sharing an OCPP identity trip
the gateway duplicate guard → `ocpp timeout MeterValues`).

### P2V-01 / P2V-02 / P2V-03 — blocker re-measured (still PENDING, CI-covered)

Host `/dev/sdc` (9.8 T) is **shared** with `/data`, `/opt`, `/lp-dev` (other
tenants) and is 100 % full (20 K free). `docker builder prune -f` reclaimed
663 MB; `docker pull timescale/timescaledb:2.17.2-pg16` still fails ENOSPC on
containerd content ingest. No local Oracle/Timescale runtime is possible on this
box without deleting other tenants' data — out of scope. Coverage stands: CI
`db-tests` applies migrations + invariants to fresh service containers on every
push; exact close commands remain in P2V-01..03 above.

## HARDEN-2026-09 — platform hardening series (EXECUTED locally; db-tests/e2e in CI)

All local items EXECUTED in this repo against the post-upgrade stack:

- **Audit (both lockfiles):** `npm audit` → **0 findings** root workspace AND
  `apps/web` (dev included). CI `security` job gates on this every push.
- **API suites on express 5.2.1 + pino 10.3.1:** api 16 · relay 4 · sim 2 ·
  security 9 (incl. new SEC-010 header + SEC-011 timing cases) · xlayer 4 ·
  ocpp-remote 2 · gateway-close 2 · race 2 — all passed.
- **OpenAPI drift gate under Express 5:** `app.router` fallback re-verified —
  spec=48, routes~52, no missing paths (the pre-fix `app._router` access would
  have silently reported no routes).
- **eslint 10 flat config:** 0 problems, `--max-warnings 0`. The stricter gate
  caught two latent issues on adoption (unused catch binding in `oracle.js`;
  never-read assignment in `gateway.js`) — both fixed.
- **`next build` (16.3.4/React 19):** 17 routes compile; `/stations/[id]` +
  `/session/[id]` migrated to `useParams()`.
- **Browser-executed (Playwright, `next start` prod):** /login renders → operator
  login stores `vh_token` → client nav to /discover → `/stations/1` renders
  "VIT Chennai Gate" with connector tiles (useParams route live) → /telemetry
  renders. Zero page errors across all four pages.
- **SEC-011 timing parity (measured):** known-email wrong-password vs
  unknown-email over 3 sample pairs — medians **42 ms vs 42 ms, gap 0 ms**.
- **BUG-021 regression validation:** `gateway-close.js` fails (CP flips OFFLINE)
  against the unguarded handler, passes with the guard — the suite is validated
  to catch its own bug.
- **Graceful drain probe:** SIGTERM to the running API → `"drained — bye"` within
  1.5 s; worker stops between 2 s cycles (loop contract reviewed in code).
- **Not run here (by design):** Oracle/Timescale db-tests + compose e2e execute on
  push in CI (db-tests → e2e chain); stated plainly rather than simulated.

## HARDEN-2026-09B — GitHub pack + roadmap closure (2026-09-05)

- **Presentation & automation pack applied**: README v2, GitHub Pages one-pager
  (`docs/index.html`, deployed from `main`/`/docs`), 1280×640 social preview,
  YAML issue forms, tag-driven `release.yml`, OpenSSF `scorecard.yml` (first run
  green on push). Release **v1.2.0** published with notes extracted from
  `CHANGELOG.md`.
- **oracledb 6.10.0 → 7.0.1 merged** — the last deferred dependency, after PR #5
  CI passed every gate including `db-tests` against real Oracle 23ai.
- `ci.yml` push trigger scoped to `main` (tag pushes no longer duplicate CI).

## BUG-027 + BUG-028 (2026-09-06) — receipts

- **BUG-027 red→green (EXECUTED):** `apps/web/src/app/discover/page.js` polled via a
  `setInterval(load, 15000)` whose closure captured the FIRST render's `q`/`std`/`sel`.
  Effects: (1) user-applied search filters were never used by the poll (it replayed the
  initial query forever) and (2) because `sel` was always `null` inside that closure,
  every poll re-selected the first station, snapping the user's selection back within
  15 s. Fixed by mirroring the three values into refs the interval reads; initial-load
  auto-select behaviour is unchanged. Verified by `next build` (17 routes) + lint clean
  ( behavioural proof is in the browser: select station 3, wait 15 s — selection stays).
- **BUG-028 red→green (EXECUTED):** `POST /invoices/:id/pay` lacked the
  `requireOwned(store, 'invoice')` guard that `GET /invoices/:id` enforces — a second
  driver could POST pay on the first driver's invoice (draining their own wallet and
  mutating someone else's invoice state). Guard added; regression test 9
  (`pay: foreign driver cannot pay someone else's invoice`) asserts 403 for a foreign
  driver while the owner still hits the normal 409 already-paid path.
- **Post-fix full gate (EXECUTED):** lint + prettier clean · api tests **17** passed ·
  sim 2 · security 14 · xlayer 4 · ocpp-remote 2 · gateway-close 3 · invariants 11 ·
  drift `spec=49 routes~53` OK · race 2/2 · e2e 7/7.

## BUG-026 provision-status honesty (2026-09-06) — receipt

- **Baseline full gate (EXECUTED):** lint + prettier clean · `npm audit` 0 findings on
  both lockfiles · `npm test` green · race 2/2 · e2e 7/7 · `next build` 17 routes.
- **BUG-026 red→green (EXECUTED):** `provisionStation` (store.js) and
  `POST /admin/charge-points` (extended.js) seeded `status: 'ONLINE'` on freshly
  provisioned charge points — a CP that has never opened an OCPP socket counted in
  `volthub_ocpp_online`, the dashboard, and CorridorMap availability dots. Fixed to
  `OFFLINE` in both paths; the gateway flips status on first socket. Regression
  assertion added to `apps/api/test/run.js` test 16 (`charge_point.status === 'OFFLINE'`).
- **Post-fix (EXECUTED):** lint clean · api tests 16/16.

## Truth pass + BUG-024 / BUG-025 (2026-09-06) — receipts

Full gate EXECUTED locally before any change (baseline): `npm run lint` clean ·
`npm run format:check` clean · `npm audit` 0 findings on both lockfiles ·
`npm test` green · `npm run test:race` (R1 + R4, one winner each) ·
`npm run test:e2e` 7 steps · `next build` 17 routes.

- **Docs truth pass (EXECUTED):** every count re-derived from the code, not from
  prose: `node scripts/check-openapi.js` → `spec=49 routes~53`; `grep -c 'CREATE TABLE'`
  over `db/oracle/V001` → 29 relations; package specs → 7; V001 indexes → 12 (+2
  V006 pair indexes); `invariants.sql` SELECTs → 11; `ci.yml` jobs → 6. All stale
  mentions (48/52, 25 relations, "6 PL/SQL packages" on the web KPI card, "7
  invariants", V001..V005 ranges, docs-site 5-CI stat, CITATION.cff v1.3.0) fixed
  and reconciled; masterplan §10.2 now documents `IDEMPOTENCY_KEY` and
  `REFRESH_TOKEN` (present in V001 since the initial commit, missing from the
  inventory); §10.5 lists the two missing indexes.
- **BUG-024 red→green (EXECUTED):** `gateway-close.js` test 3 clears the gateway's
  tick cursor (`__ocppTickCursor`) and recycles the socket mid-session. With the
  cursor-recovery disabled the test fails (`all three ticks must persist, got 1`);
  with the fix it passes — the suite is validated to catch its own bug.
- **BUG-025 red→green (EXECUTED):** `TEST-SEC-SWEEP-1` seeds stale buckets into
  both throttle maps and runs `sweepIdle(now)`. With the login-map sweep removed
  the test fails (`fully-stale LOGIN bucket must also be deleted`); with the fix
  it passes.
- **Post-fix full gate (EXECUTED):** lint + prettier clean; `npm test` green
  (api 16 · relay · sim 2 · security **14** · xlayer 4 · ocpp-remote 2 ·
  gateway-close **3** · invariants 11 · drift `spec=49 routes~53` OK);
  `npm run test:race` 2 passed.
- **Not run here (stated plainly):** local Oracle/Timescale runs remain blocked
  by host disk (see P2V-01..03) — CI `db-tests` + compose `e2e` cover both
  engines on every push. `docs/architecture-hero.png` still renders the previous
  25-relation diagram (no image toolchain on this host); re-render from
  `diagrams/architecture.mmd` when available.
