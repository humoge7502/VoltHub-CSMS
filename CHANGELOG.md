# Changelog

All notable changes. Format: Keep a Changelog, Semantic Versioning.

## [Unreleased]

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
