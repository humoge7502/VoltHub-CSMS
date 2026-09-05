# @volthub/worker — outbox relay + expiry sweeper

2s loop, batch 500: `GET /internal/outbox` → sink (TimescaleDB `COPY … ON CONFLICT
DO NOTHING` in prod, idempotent `timescale-mirror.jsonl` locally) → `POST
/internal/outbox/ack`, plus reservation no-show expiry. Crash-after-COPY replays
with zero dupes (dedupe key `(kind,session_id,seq)`); sink-down accumulates and the
dashboard stays stale-honest via `/health.outbox_lag`.

```bash
API_BASE=http://localhost:4000/api/v1 npm start
```
