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
- Oracle execution: PENDING (no Oracle runtime in this environment; covered by
  CI `db-tests` migrate step on every push).

## P2V-01 — `tick_1m` correlated subquery on `station_map` (PENDING)

- Attempted 2026-09-05: `docker pull timescale/timescaledb:2.17.2-pg16` →
  **blocked, daemon disk full** (`/var/lib` 100%; running research containers
  untouched). No local Timescale available.
- Coverage: CI `db-tests` applies `T001`+`T002` to a fresh Timescale service on
  every push (DDL acceptance continuously proven) — config VERIFIED in
  `.github/workflows/ci.yml`.
- To close: `docker compose exec timescale psql -U volthub -d volthub -c
"CALL refresh_continuous_aggregate('tick_1m', NULL, NULL);"`
  Fallback (unchanged): move enrichment to `v_tick_enriched`, drop the subquery.

## P2V-02 — `MODE() WITHIN GROUP` in `state_1m` (PENDING)

- Same blocker and same CI coverage as P2V-01.
- To close: same `CALL refresh_continuous_aggregate('state_1m', NULL, NULL);`
  Fallback: `COUNT(*) FILTER` variants only.

## P2V-03 — V001–V006 entrypoint re-runs on fresh Oracle volume (PENDING)

- `db-tests` uses `scripts/migrate.sh`, not the `docker-entrypoint-initdb.d`
  path, so second-`up` tolerance is unobserved in CI either.
- To close: `docker compose down -v && docker compose up` (first boot only),
  watch Oracle logs for tolerated `-27477` on the scheduler job and V005/V006
  re-run guards. V006's `NOT NULL` enforcement warns (never fails) on legacy
  NULLs; invariant 11 reports any leftovers.

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
