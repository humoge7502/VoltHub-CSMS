# AI platform — design, guardrails, and measured receipts

ADR-0008. The AI subsystem (`apps/ai/`) is an **advisory-only** FastAPI sidecar on
the host's 8× A100-80GB pool (shared with other tenants). It never sits in the
charging control path; the REST API enforces RBAC + station scope before any AI
call, every response is `advisory: true`, and all AI queries are audit-logged.

## Tier map (mission §5)

| Tier | Workload                      | Implementation               | Device                |
| ---- | ----------------------------- | ---------------------------- | --------------------- |
| T1   | Forecast / anomaly / optimize | `service.py` (FastAPI)       | GPU inference, CPU LP |
| T2   | Smart-charging optimization   | deterministic LP (HiGHS)     | CPU (measured winner) |
| T3   | EV fleet demand simulation    | `simulate.py` (torch)        | GPU (15× vs CPU)      |
| T4   | Demand forecaster training    | `train.py` (MLP + baselines) | GPU                   |
| T5   | GPU allocator + receipts      | `gpu.py`                     | nvidia-smi measured   |

## Measured receipts (2026-09-07, `apps/ai/reports/`)

- `benchmarks.json` — simulation 24 stations × 28 d × 2000 vehicles:
  CPU 50.6 ms vs GPU 3.4 ms (**15.0×**); forecast inference batch 4096 rows:
  CPU 136.9 ms vs GPU 0.3 ms (**~525×**); optimizer LP (10 vehicles × 24 h):
  **3.4 ms on CPU/HiGHS** — verdict recorded honestly: the optimizer stays on CPU;
  GPUs earn their keep on simulation, training, and batched inference.
- `metrics.json` — forecaster (MLP 128×64, direct 24-h horizon, per-station
  relative targets, last 7 days held out): **MLP MAE 56.4 kWh < ridge 63.1 <
  seasonal-naive 73.8** on the test tail. `beats_naive: true`. Training: 3.5 s on
  one A100. Note: the first honest run recorded `beats_naive: false` (raw targets
  let large stations dominate the loss) — the receipt shipped as-is, and the fix
  (target normalization) is itself documented here.
- `gpu-util.jsonl` — utilization snapshots sampled during training (receipt, not a
  dashboard claim).

## Guardrails (enforced in code, not prose)

1. **RBAC before AI**: `/ai/*` is `roles('OPERATOR','ADMIN')`; operators are
   station-scoped (`OUT_OF_SCOPE` mirrors BUG-030/031). Drivers: 403.
2. **Advisory-only**: no AI route mutates domain state; responses carry
   `advisory: true` + model identity; queries are audit-logged (`AI_FORECAST`,
   `AI_ANOMALY_SCAN`, `AI_OPTIMIZE`).
3. **Deterministic electrical constraints**: `/v1/optimize` is an LP whose hard
   constraints are the station power cap, per-connector rate, plug-in windows,
   deadlines and required energy. Infeasible demand ⇒ `feasible: false` with a
   reason — never silently truncated (pytest-pinned).
4. **Honest degradation**: no trained artifact ⇒ `seasonal-naive-fallback` + a
   note naming `train.py`. Sidecar down ⇒ `503 AI_UNAVAILABLE` (never a 500).
5. **Internal-only sidecar**: `x-internal` shared token checked on every call
   (401 otherwise); compose binds it off the public interface.

## Tests

- JS contract tests (`apps/api/test/ai.js`, 6): RBAC, station scope, unknown
  station, advisory passthrough + token riding, sidecar-down 503, 422 validation.
- pytest (`apps/ai/tests`, 8 + 1 GPU opt-in): simulator determinism, optimizer
  hard-constraint satisfaction + optimality sanity, honest infeasibility, anomaly
  z-score math (incl. the MAD=0 edge), token auth, forecast degradation honesty,
  allocator parsing. Run: `npm run test:ai`.

## Running

```bash
npm run ai:train   # train + write reports/metrics.json (GPU if free, else CPU)
npm run ai:serve   # FastAPI on 127.0.0.1:8100
npm run ai:bench   # CPU-vs-GPU receipts -> reports/benchmarks.json
npm run test:ai    # pytest
```

API surface: `GET /api/v1/ai/forecast?stationId=&hours=`,
`GET /api/v1/ai/anomalies?stationId=`, `POST /api/v1/ai/optimize` (drift-gated in
the OpenAPI spec).
