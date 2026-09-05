# Changelog

All notable changes. Format: Keep a Changelog, Semantic Versioning.

## [Unreleased]

## [1.1.0] — 2026-09-05

### Added & fixed (Audit Round 3 — B3G register + verification kit)

- ADR-0006 implemented via `V006__fk_native.sql`: connector linkage is now
  FK-native (`cp_id`, `connector_no` pair written by the packages, trigger
  derivation retired); D-02 `start_minute`/`end_minute` VIRTUAL columns +
  `uq_band_slot_minute`; invariant 11 gates the pair (NULL/dangling) on both
  engines; local store + Oracle hydrate write the pair natively.
- B3G-001: operator `RemoteStartTransaction` (allow-listed `TAG-<uid>`) with
  RemoteStop parity; gateway pino log call fixed (method-bound `this`).
- B3G-005: orphaned-invoice total guard — non-admins get 403 when an invoice's
  session no longer exists.
- OCPP remote-command contract suite (`apps/api/test/ocpp-remote.js`, 2 tests)
  wired into `npm test` and CI `quality` + `db-tests` jobs.
- Bench harness (`bench/run-local.js`, k6 contention/discovery scripts) + measured
  tables in `docs/perf.md`; `docs/verification.md` receipt discipline added.
- Fix (web): CSP hydration bug — `default-src 'self'` blocked Next's inline RSC
  bootstrap so the console never hydrated in dev **or** prod (verified via
  Playwright, React #423). `script-src` is now env-aware: `'unsafe-inline'`
  always, `'unsafe-eval'` dev-only.
- Evidence: real-pixel README strip + live OCPP GIF under `docs/screenshots/`
  with re-recordable tooling in `scripts/screenshots/` (self-contained deps).
- OpenAPI: service index `/` documented — drift gate reports zero notes.

### Fixed (Audit Round 2 — B2G register)

- B2G-001 (P0): full-stack compose demo now actually relays outbox events into TimescaleDB (worker `TS_HOST` env + `pg` in image + pinned Timescale tag).
- B2G-002 (P0): object-level authorization on `GET /invoices/:id`, `POST /sessions/:id/bill`, `POST /sessions/:id/remote-stop` (OWASP API1:2023).
- B2G-003 (P0): role gate on station analytics; manual fault reports no longer flip connector state.
- B2G-004 (P1): pay-parity — a failed wallet payment leaves the invoice DUE on BOTH engines (was: local mode bricked the invoice as FAILED).
- B2G-005 (P1): Oracle hydrate covers transactional tables; outbox acks now durable in Oracle.
- B2G-006 (P1): Timescale sink dedupe key aligned with the outbox (same-second ticks no longer dropped).
- B2G-013 (P1): session start verifies reservation ownership + connector match.
- B2G-010 (P1): JWT algorithm pinned; login-tier rate limit; scope-check NaN fixed.
- B2G-014 (P1): Idempotency-Key backed by the `idempotency_key` table under `STORE=oracle`.
- B2G-007/008/011/012 (P2): dead code removed; docs truth pass (SECURITY/README/ADR-0003); sargable view joins; band resolver determinism; lint + community files.

## [1.0.0] — initial two-engine build

- Oracle 23ai OLTP: 25-relation schema, 7 PL/SQL packages, connector guard, least-privilege role.
- OCPP 1.6J gateway (Security Profile 1) + 5-scenario simulator fleet.
- TimescaleDB telemetry: hypertables, hierarchical caggs, compression, retention; outbox relay.
- Next.js "Grid Current" console; 3-job CI with Oracle + Timescale service containers.
