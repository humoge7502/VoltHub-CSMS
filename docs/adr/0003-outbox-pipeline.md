# ADR-0003: Outbox pipeline Oracle → Timescale

Atomic commit (`meter_reading` + `outbox_event` in one `record_meter_tick` call), relay `SELECT … FOR UPDATE SKIP LOCKED LIMIT 500` every 2s, sink `INSERT … ON CONFLICT DO NOTHING` on `(kind,session_id,seq)` dedupe key → at-least-once + idempotent = effectively-once.
Rejected: dual-write (divergence on crash), nightly batch (stale kills live curve), CDC/LogMiner (heavy, edition-sensitive).
Kill -9 mid-batch replays with zero dupes; billing never reads Timescale (graceful degrade).
