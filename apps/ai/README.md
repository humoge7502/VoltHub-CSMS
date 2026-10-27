# VoltHub AI (advisory-only sidecar)

ADR-0008. A small FastAPI sidecar that adds AI **advisory** capabilities to the
CSMS. It can never mutate charging/billing state — the REST API enforces RBAC +
operator station scope _before_ the sidecar is consulted, and every response is
marked `advisory: true`. See `docs/ai-platform.md` for the full design.

## Workloads

| Tier            | What                                                    | Where                     |
| --------------- | ------------------------------------------------------- | ------------------------- |
| T1 inference    | `/v1/forecast`, `/v1/anomalies`, `/v1/optimize`         | `service.py` (FastAPI)    |
| T2 optimization | smart-charging LP (HiGHS) — measured: CPU wins at scale | `service.py` + `bench.py` |
| T3 simulation   | GPU-batched EV fleet demand simulator                   | `simulate.py` (torch)     |
| T4 training     | per-station demand forecaster vs honest baselines       | `train.py` → `reports/`   |
| T5 GPU ops      | allocator, pinning, utilization receipts                | `gpu.py`                  |

## Run it

```bash
npm run ai:train     # trains on the licensed panel built by ingest.py (--source auto);
                     # the synthetic twin is used ONLY if no panel exists, and the
                     # receipt records which one produced the model
npm run ai:serve     # uvicorn on 127.0.0.1:8100 (AI_URL/AI_TOKEN/AI_PORT env-tunable)
npm run ai:bench     # hardware receipt -> reports/benchmarks.json (CPU here; GPU columns only when CUDA is present)
npm run test:ai      # pytest suite (CPU-safe; GPU smoke is opt-in via AI_TEST_GPU=1)
```

Then point the API at it: `AI_URL=http://127.0.0.1:8100 npm run dev:api` and call
`GET /api/v1/ai/forecast?stationId=1` (operator/admin; operators are station-scoped).

## Honesty contract

- `train.py` compares the model against **seasonal-naive and ridge baselines** on a
  held-out tail and records `beats_naive` in the receipt — a negative result ships
  as-is (it did during development; per-station target normalization fixed it).
- No trained artifact? `/v1/forecast` degrades to `seasonal-naive-fallback` and says
  so in the payload. It never fakes a model.
- `/v1/optimize` is a deterministic LP — no ML in the electrical constraint path.
- Interval fields describe the level they were measured at: `lower`/`upper` always carry
  the calibrated band plus `interval_level`, and the legacy `p10`/`p90` keys are only
  filled while that level is 0.8. An artifact declaring a level its own conformal table
  cannot produce is refused at load, so the sidecar degrades to seasonal naive instead of
  publishing a mislabelled band.
- GPU picking is measured (nvidia-smi), never assumed: the pool is shared with other
  tenants, and jobs fall back to CPU when nothing qualifies.
