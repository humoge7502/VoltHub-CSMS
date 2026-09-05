# ADR-0003: Outbox pipeline Oracle → Timescale

Atomic commit (`meter_reading` + `outbox_event` in one `record_meter_tick` call), relay `SELECT … FOR UPDATE SKIP LOCKED LIMIT 500` every 2s, sink `INSERT … ON CONFLICT DO NOTHING` on `(session_id, seq_no, ts)` dedupe key (B2G-006: `seq_no`/`dedupe_key` columns carry the pipeline `tick:sid:seq` key; same-second ticks no longer collide) → at-least-once + idempotent = effectively-once.
Rejected: dual-write (divergence on crash), nightly batch (stale kills live curve), CDC/LogMiner (heavy, edition-sensitive).
Kill -9 mid-batch replays with zero dupes; billing never reads Timescale (graceful degrade).

## Implementation status (2026-09-05 audit build)

Implemented: `apps/worker/src/relay-timescale.js` (batched INSERT … ON CONFLICT DO NOTHING,
ack-after-COMMIT, ROLLBACK on failure) + `toRows()` PK mapping
(`meter_tick(session_id,seq_no,ts)`, `connector_state_event(connector_ref,ts)`);
local fallback mirror in `apps/worker/src/index.js` (in-memory dedupe set, BUG-015).
Read branch: `GET /telemetry/load-curve` reports honest `source: 'timescaledb' | 'local-rollup'`.
