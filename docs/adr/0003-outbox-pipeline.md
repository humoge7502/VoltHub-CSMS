# ADR-0003: Outbox pipeline Oracle → Timescale

Atomic commit (`meter_reading` + `outbox_event` in one `record_meter_tick` call), relay `SELECT … FOR UPDATE SKIP LOCKED LIMIT 500` every 2s, sink `INSERT … ON CONFLICT DO NOTHING` on `(session_id, seq_no, ts)` dedupe key (B2G-006: `seq_no`/`dedupe_key` columns carry the pipeline `tick:sid:seq` key; same-second ticks no longer collide) → at-least-once + idempotent = effectively-once.
Rejected: dual-write (divergence on crash), nightly batch (stale kills live curve), CDC/LogMiner (heavy, edition-sensitive).
Kill -9 mid-batch replays with zero dupes; billing never reads Timescale (graceful degrade).

## Implementation status (2026-09-05 audit build)

Implemented: `apps/worker/src/relay-timescale.js` (batched INSERT … ON CONFLICT DO NOTHING,
ack-after-COMMIT, ROLLBACK on failure) + `toRows()` PK mapping
(`meter_tick(session_id,seq_no,ts)`, `connector_state_event(connector_ref,ts,dedupe_key)` —
T004 upgrades databases whose key still allows only one transition per connector per
second, and the relay now writes the key it always had in `toRows`);
local fallback mirror in `apps/worker/src/index.js` (in-memory dedupe set, BUG-015).
Read branch: `GET /telemetry/load-curve` reports honest `source: 'timescaledb' | 'local-rollup'`.

## Hardening (2026-10-25)

Four gaps turned "at-least-once" into "at-least-once until something goes wrong":

- **Head-of-line blocking.** A single row the sink refused (class 22/23) rolled the whole
  batch back, and the queue never moved again. `writeSpecs()` now retries the batch row by
  row and POSTs only the refusing keys to `POST /internal/outbox/quarantine`, which acks
  them and opens a letter for `/ops/dead-letters` triage. Guard: if per-row mode writes
  _nothing_, that is an outage or a relay bug, not poison — the relay fails loudly instead
  of dead-lettering the fleet. Class 42 (schema drift) and 08/53/57/58/40 (sink down,
  deadlock, resource) still back off with the events intact.
- **Unbounded queue.** The in-process outbox grew forever. Acked rows age out after
  `OUTBOX_RETENTION_HOURS`, `OUTBOX_SOFT_CAP` prunes on emit, `OUTBOX_HARD_CAP` sheds the
  oldest acked rows, `DEAD_LETTER_CAP` bounds the letters. Unacked events are never
  eligible — the delivery guarantee is worth more than the memory.
- **Self-reported health.** The worker printed a hardcoded `lag_probe=ok`. `/health`,
  `/health/deep` and `/metrics` now expose measured `outbox_oldest_age_s`,
  `dead_letters_open`, and `relay_last_poll_age_s` / `volthub_relay_last_poll_seconds`
  (-1 = no relay has ever polled this process, which is how "the queue is deep" and "the
  worker is dead" stop looking identical).
- **Connection churn.** Both relay paths opened and closed a Timescale `Pool` per 2-second
  poll. One pool is shared for the process lifetime and closed when the SIGTERM drain starts.
