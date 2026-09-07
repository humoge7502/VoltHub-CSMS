# ADR-0008: AI as an advisory sidecar (apps/ai) — never in the control path

Date: 2026-09 (engineering mission) · Status: accepted

## Context

The platform had zero AI capability while running on a host with 8× A100-80GB GPUs
(shared with other tenants). Two failure modes were both unacceptable:

1. No intelligence at all: operators get no demand forecasts, anomaly triage, or
   smart-charging schedules — capability the CSMS market treats as table stakes.
2. AI bolted into the charging path: an LLM or ML model standing between a driver
   and a breaker is unauditable, non-deterministic, and unsafe (mission rule:
   _deterministic safety constraints > AI recommendations_).

## Decision

A **separate Python sidecar** (`apps/ai`, FastAPI) behind the API, strictly advisory:

- The API's `/ai/*` routes enforce **RBAC + operator station scope BEFORE** the
  sidecar is consulted (the sidecar never sees user identity, only data shapes).
- Every AI response carries `advisory: true`; no AI output can mutate charging,
  billing, or connector state. Audited as `AI_*` audit-log actions.
- The smart-charging optimizer is a **deterministic LP (HiGHS)** — no ML touches
  electrical constraints. Hard constraints (station cap, connector rate, deadlines,
  required energy) are LP constraints; infeasible demand is **reported, never
  silently truncated**.
- The forecaster ships with **honest baselines** (seasonal-naive, ridge) evaluated on
  a held-out tail; `beats_naive` is recorded even when false (it was false until
  per-station target normalization fixed a real modeling defect).
- Missing model artifact ⇒ `seasonal-naive-fallback` with a payload note. Never fake.

## GPU policy (8× A100-80GB, shared host)

- **Measured allocation, never assumed**: `gpu.py` picks the least-memory-used GPU
  with enough free memory and <90% utilization via nvidia-smi, pins it with
  CUDA_VISIBLE_DEVICES before torch initializes, file-locks it (quota), and logs
  utilization to `reports/gpu-util.jsonl`. Falls back to CPU when nothing qualifies.
- Workloads by tier: T3 simulation (GPU 15× vs CPU), T4 training (GPU), T1 batch
  inference (GPU ~500× on batches), T2 optimization (stays on CPU — LP at CSMS scale
  is 3.4 ms; a GPU grid search is an approximation and loses).
- **No Kubernetes**: one shared host + batch jobs = a ~100-line allocator. A scheduler
  would add operational surface with no demonstrated requirement (ADR-0001 ethos).

## Trade-offs accepted

- A Python sidecar adds a second runtime to a deliberately plain-JS repo. Accepted:
  GPU/ML ergonomics in Node are poor; the boundary is one HTTP hop with a shared
  internal token, and the JS-side contract tests stub the sidecar so the Node CI
  needs no Python.
- Forecasts are per-station aggregate demand, not per-connector — sufficient for
  operator planning; finer granularity is a data-availability question (Timescale
  enriched views), not a modeling one.
- CI cannot run GPU workloads (GitHub runners have no A100): pytest is CPU-safe, the
  GPU smoke is opt-in (`AI_TEST_GPU=1`), and GPU receipts come from the dev host.

## Consequences

- New env: `AI_URL` (default `http://127.0.0.1:8100`), `AI_TOKEN` (shared secret),
  `AI_TIMEOUT_MS` (3 s). Sidecar down ⇒ `503 AI_UNAVAILABLE`, never a 500, never
  blocking the money path (contract-tested).
- OpenAPI gained `/ai/forecast`, `/ai/anomalies`, `/ai/optimize` (drift-gated).
