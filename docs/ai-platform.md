# AI platform — design, guardrails, and measured receipts

ADR-0008. The AI subsystem (`apps/ai/`) is an **advisory-only** FastAPI sidecar. It never
sits in the charging control path: the REST API enforces RBAC + station scope before any AI
call, every response is `advisory: true`, and all AI queries are audit-logged.

## Tier map (mission A5)

| Tier | Workload                      | Implementation               | Device                  |
| ---- | ----------------------------- | ---------------------------- | ----------------------- |
| T1   | Forecast / anomaly / optimize | `service.py` (FastAPI)       | CPU inference (default) |
| T2   | Smart-charging optimization   | deterministic LP (HiGHS)     | CPU (measured winner)   |
| T3   | EV fleet demand simulation    | `simulate.py` (torch)        | GPU when available      |
| T4   | Demand forecaster training    | `train.py` (MLP + baselines) | CPU or GPU              |
| T5   | GPU allocator + receipts      | `gpu.py`                     | nvidia-smi measured     |

The sidecar is device-agnostic: it uses CUDA when present and falls back to CPU without
changing the artifact contract. The receipt below was produced on CPU.

## Data: three public research panels

The forecaster is trained on a **pooled panel of 87 stations / 754,032 station-hours /
1,331,724 kWh**, not on a synthetic series:

| Source    | Stations | Raw rows | Station-hours | Total kWh | License   | Provenance                                                                                                                                                      |
| --------- | -------: | -------: | ------------: | --------: | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tennessee |       40 |   46,575 |       335,195 |   554,889 | CC-BY-4.0 | [HuggingFace `jtupayac/EV_Charging_demand`](https://huggingface.co/datasets/jtupayac/EV_Charging_demand), 2024-01..2025-01                                      |
| Norway    |        7 |  469,897 |        89,494 |   442,070 | CC-BY-4.0 | [Zenodo 13896176](https://zenodo.org/records/13896176), 2019 residential charging                                                                               |
| Korea     |       40 |   72,856 |       329,343 |   334,765 | CC-BY-4.0 | [figshare 10.6084/m9.figshare.22495141.v1](https://doi.org/10.6084/m9.figshare.22495141.v1), Baek, Lee & Kim, _Scientific Data_ 11:262 (2024), 2022-09..2023-09 |

The per-source receipts, raw SHA-256 digests and aggregation method are written by
`apps/ai/ingest.py` to `apps/ai/reports/dataset.json`; no CSMS customer data is used for
training.

Each source is aggregated to **hourly station energy**: session energy is spread over the
hours it overlaps (overlap-weighted), local time is converted to UTC, and gaps on the hour
grid are true zeros. A source is excluded (and the exclusion recorded) if it cannot meet the
contract's 168-hour minimum or if its provenance/licence is missing.

## Measured receipts (2026-10-25, `apps/ai/reports/`)

Protocol: rolling-origin, 4 folds, 45 backtest days, 10-day calibration block, 1-day purge
before each test fold. **746,616 test points.** Per-station relative targets; the model
never sees a test fold during fit or calibration.

| Model                   |    MAE kWh |   RMSE kWh | MASE vs 168 h naive | Skill vs naive |
| ----------------------- | ---------: | ---------: | ------------------: | -------------: |
| **MLP 128×64 (served)** | **1.9060** | **6.9986** |          **0.6398** |   **+36.02 %** |
| Ridge                   |     3.2679 |     6.9195 |              1.0970 |        −9.70 % |
| Seasonal naive (168 h)  |     2.9790 |     9.3255 |              1.0000 |              — |
| Weekly same-hour mean   |     2.8721 |     7.4358 |                   — |              — |

- **Conformal intervals**: split conformal, per-horizon signed residual quantiles,
  finite-sample corrected. Nominal 80 %, **empirical coverage 0.8029** (error +0.29 pp) over
  662,952 calibration points; mean width 5.159 kWh. Coverage per fold: 0.794 / 0.837 /
  0.817 / 0.764 — the spread is reported, not hidden.
- **Artifact integrity**: `apps/ai/reports/model.pt` has file SHA-256
  `f8273bcc…b8d44` and payload SHA-256 `e77838a8…591fa`. Serving parity checked on 512 rows:
  max absolute relative difference **0**; `weights_only` load verified. A checksum mismatch
  is refused at startup, not served.
- **Training cost**: 642.61 s on CPU (torch 2.14.1+cpu). This is the honest number for the
  three-dataset panel; the earlier 3.5 s receipt was a single-source panel on an A100.
- `benchmarks.json` retains the hardware receipt (simulation 24 stations × 28 d × 2000
  vehicles: CPU 50.6 ms vs GPU 3.4 ms; batch-4096 inference: CPU 136.9 ms vs GPU 0.3 ms;
  LP on CPU/HiGHS 3.4 ms). Conclusion recorded there: **the optimizer stays on CPU**;
  accelerators earn their keep on simulation and training.

## Governance surface (new in 2026-10)

| Endpoint             | What it answers                                                                                                 | Guardrail                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /v1/model-card` | dataset, citations, licence, contract, metrics, conformal coverage, artifact digests, intended use, limitations | internal token; no customer data                                        |
| `POST /v1/explain`   | feature-group occlusion against the training mean, in standardized space                                        | needs a loaded artifact (503 otherwise); 422 on bad history             |
| `POST /v1/drift`     | PSI over demand deciles, two-sample KS, mean/zero/volatility shifts, hourly-shape TV                            | monitoring only; `retrain_recommended` requires an actual drift verdict |
| API proxies          | `GET /ai/model-card`, `GET /ai/drift?stationId=`, `POST /ai/explain`                                            | OPERATOR/ADMIN + station scope + audit log                              |

The model card is a **receipt, not marketing**: it lists what the model is not for
(billing, automatic curtailment, new connectors, driver profiling) and states that drift is
not proof of forecast error. Training is never triggered automatically — a retrain needs a
labelled backtest, because unlabelled drift can be harmless seasonality.

Drift deliberately uses **value bins, not hour-of-day bins**: whole-day windows always have
equal hour counts, so an hour-bucket PSI reports zero drift no matter how much demand
changed. `apps/ai/tests/test_service.py` pins both the stable case and a real regime change.

## Guardrails (enforced in code, not prose)

1. **RBAC before AI**: `/ai/*` is `roles('OPERATOR','ADMIN')`; operators are station-scoped
   (`OUT_OF_SCOPE` mirrors BUG-030/031). Drivers: 403.
2. **Advisory-only**: no AI route mutates domain state; responses carry `advisory: true` +
   model identity; queries are audit-logged (`AI_FORECAST`, `AI_ANOMALY_SCAN`,
   `AI_OPTIMIZE`, `AI_EXPLAIN`, `AI_DRIFT`).
3. **Deterministic electrical constraints**: `/v1/optimize` is an LP whose hard constraints
   are the station power cap, per-connector rate, plug-in windows, deadlines and required
   energy. Infeasible demand → `feasible: false` with a reason — never silently truncated
   (pytest-pinned).
4. **Honest degradation**: no trained artifact → `seasonal-naive-fallback` + a note naming
   `train.py`. Sidecar down → `503 AI_UNAVAILABLE` (never a 500).
5. **Internal-only sidecar**: `x-internal` shared token checked on every call (401
   otherwise); compose binds it off the public interface.
6. **Carbon is not an AI input**: CarbonPilot is a separate deterministic model (ADR-0017)
   and never becomes a hard constraint in the optimizer or the money path.

## Tests

- JS contract tests (`apps/api/test/ai.js`, 10): RBAC, station scope, unknown station,
  advisory passthrough + token riding, sidecar-down 503, 422 validation, model card, drift
  split, explain scope/history.
- pytest (`apps/ai/tests`, 98 passed + 2 skipped): ingest provenance round-trip, panel
  contract, training metrics, simulator determinism, optimizer hard-constraint satisfaction
  - infeasibility, anomaly math (incl. MAD=0), token auth, forecast degradation honesty,
    model card with/without artifact, drift stable/regime/malformed, explain scope, allocator
    parsing. Run: `npm run test:ai` (Windows: `cd apps/ai; python -m pytest tests -q`).

## Running

```bash
npm run ai:train   # ingest + train + write reports/{dataset,metrics}.json + model.pt
npm run ai:serve   # FastAPI on 127.0.0.1:8100
npm run ai:bench   # CPU-vs-GPU receipts -> reports/benchmarks.json
npm run test:ai    # pytest
```

API surface: `GET /api/v1/ai/forecast?stationId=&hours=`,
`GET /api/v1/ai/anomalies?stationId=`, `POST /api/v1/ai/optimize`,
`GET /api/v1/ai/model-card`, `GET /api/v1/ai/drift?stationId=`,
`POST /api/v1/ai/explain` (drift-gated in the OpenAPI spec).
