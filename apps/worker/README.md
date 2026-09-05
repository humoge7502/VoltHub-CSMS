# @volthub/worker — outbox relay + expiry sweeper

2s loop, batch 500: `GET /internal/outbox` → sink (TimescaleDB `COPY … ON CONFLICT
DO NOTHING` in prod, idempotent `timescale-mirror.jsonl` locally) → `POST
/internal/outbox/ack`, plus reservation no-show expiry. Crash-after-COPY replays
with zero dupes (dedupe key `(kind,session_id,seq)`); sink-down accumulates and the
dashboard stays stale-honest via `/health.outbox_lag`.

Each loop also syncs Timescale `station_map` from `GET /internal/station-map`
(masterplan §26.5): Oracle-owned station metadata denormalized for query-time cagg
enrichment — `v_tick_1m_enriched`/`v_tick_1h_enriched`, Grafana per-station panels.
Failures log and back off; they never stall event relay. Unit tests:
`node apps/worker/test/relay.test.js` (fake pool + fetch, no DB).

```bash
API_BASE=http://localhost:4000/api/v1 npm start
```
