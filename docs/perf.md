# Performance — methodology + how to reproduce (no unmeasured claims)

> Audit BUG-010: earlier versions of this file published specific timings with no
> committed benchmark scripts. This rewrite removes every unmeasured number.
> Numbers return only from the experiments below, with hardware specs + scripts.

## What runs where (today)

- Local profile (`npm run dev:api`): in-process store, no Oracle/Timescale. Useful for
  API-contract latency only — not for DB claims.
- Full profile (`docker compose -f infra/docker-compose.yml up`): Oracle 23ai + TimescaleDB
  via `apps/api/src/db/index.js` (`ORACLE_HOST` set) and `apps/worker/src/relay-timescale.js`
  (`TS_HOST` set). All DB numbers must come from this profile.

## Benchmark suite (post-wiring — §12.5)

| #   | Experiment                                         | Command                                                           | What to report                                           |
| --- | -------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | Discovery: JS aggregation vs `v_station_summary`   | `k6 run bench/k6-discovery.js` (50 VUs)                           | p50/p95/p99 + error rate, both paths                     |
| 2   | Reservation contention: 1 connector vs N           | `k6 run bench/k6-reserve-contention.js`                           | serialized latency on hot connector, linear scaling on N |
| 3   | Telemetry ingest: 50 chargers × 5 s × 10 min       | `node apps/simulator/src/index.js --scenario burst --chargers 50` | relay batches/s, INSERT rows/s, outbox-lag p95           |
| 4   | Cagg analytics: raw scan vs `tick_1m` vs `tick_1h` | `psql -f bench/cagg-compare.sql`                                  | latency + rows scanned at ≥1M ticks                      |
| 5   | Read-path step load 10→50→100 VUs                  | `k6 run test/load/k6-smoke.js`                                    | p50/p95/p99 + pool saturation (`poolMax=8`)              |

Local-profile shortcut (no k6/Docker): `node bench/run-local.js` boots an ephemeral
API and measures 1/2/3/5.To compare fairly across machines, prefer ratios over absolutes.

Reporting format: one table per experiment + hardware spec (CPU/RAM/disk, container
limits) + committed scripts under `bench/`. Ratios (cagg vs raw) preferred over
absolutes where hardware varies.

## Measured — engineering-mission round (2026-09-07)

Same hardware (AMD EPYC 7V12, Node v20.20.2, local profile). Additions this round,
all from `bench/results-local.json` + simulator runs:

- **Telemetry ingest 21,739 → 42,553 ticks/s** (PERF-004): `recordTick`'s
  METER_REGRESSION check was O(total readings) per tick; a per-session max-meter
  index makes it O(1). Same bench, same machine.
- **100-charger fleet soak, clean** (PERF-002/003 + GAP-002 + simulator fixes):
  `--scenario burst --chargers 100 --provision` → 0 BootNotification timeouts,
  0 CALLERRORs, 100/100 sessions started (each on its own freshly provisioned CP —
  one session per connector is the physical reality the old flow violated).
  Before the fixes: 7+ timeouts at 100 simultaneous, 8 at 50, `tx=0` Invalid-tag
  flows (hardcoded `TAG-1`). Cold-connect-storm behavior is covered by the
  `gateway-close.js` oversized-frame + rate-limit tests.
- **AI receipts** (`apps/ai/reports/`): simulation GPU 15× vs CPU; batched
  forecast inference ~525× GPU; smart-charging LP 3.4 ms on CPU (GPU does not help
  at CSMS scale — recorded as the verdict, not a victory). See `docs/ai-platform.md`.

## Measured — local profile (`node bench/run-local.js`, 2026-09-05)

Hardware: AMD EPYC 7V12 (96 vCPU), 1771.7 GB RAM, Linux 6.17 Azure, Node v20.20.2.
Profile: in-process store, no Docker. Raw results: `bench/results-local.json`.
Scope honesty: these numbers characterize the **local test-double path only** —
DB-backed claims still require the full compose profile (experiments 3–5 below).
Latest run is post-SEC-012 (httpOnly refresh cookie) — auth-path overhead unchanged.

| Exp | Workload                                          | p50                                              | p95                                              | p99                                               | Extra                                                             |
| --- | ------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | 200× sequential `GET /stations`                   | 1 ms                                             | 2 ms                                             | 3 ms                                              | 0 errors                                                          |
| 2   | 20 parallel same-window reserves, 1 hot connector | 36 ms                                            | 54 ms                                            | 54 ms                                             | **exactly 1×201 + 19×409** (lock scope proven)                    |
| 3   | 2000 sequential `recordTick` on one session       | —                                                | —                                                | —                                                 | 19,231 ticks/s, 104 ms wall; outbox lag 2002 (relay drains async) |
| 5   | concurrent `GET /stations` step-load              | 10 VU: 8 ms / 50 VU: 53 ms / 100 VU: 60 ms (p50) | 10 VU: 9 ms / 50 VU: 93 ms / 100 VU: 97 ms (p95) | 10 VU: 9 ms / 50 VU: 94 ms / 100 VU: 100 ms (p99) | 0 errors at all levels                                            |

## Still pending (full profile)

- Experiment 4 (cagg vs raw at ≥1M ticks): needs TimescaleDB + seeded ticks —
  `psql -h $TS_HOST -U $TS_USER -d $TS_DB -f bench/cagg-compare.sql`.
- Full-profile runs of 1/2/3/5 under `docker compose` with Oracle + Timescale
  (pool saturation at `poolMax=8` is only observable there).

## Current status

- `test/load/k6-smoke.js` encodes NFR thresholds (p95 < 300 ms, failures < 2%) but is
  **not run in CI yet** — run manually against the DB-backed build (see `bench/README.md`).
- No published latency/throughput/compression numbers until experiments 1–5 are run.
  The web footer and README make no performance claims beyond "see docs/perf.md".

## Reproduce (smoke)

```bash
SEED_PROFILE=full npm run dev:api
node apps/simulator/src/index.js --scenario burst --chargers 50
```
