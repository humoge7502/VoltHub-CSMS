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

## Measured — local profile (`node bench/run-local.js`, 2026-09-07)

Hardware: AMD EPYC 7V12 (96 vCPU), 1771.7 GB RAM, Linux 6.17 Azure, Node v20.20.2.
Profile: in-process store, no Docker. Raw results: `bench/results-local.json`.
Scope honesty: these numbers characterize the **local test-double path only** —
DB-backed claims live in the experiment-4 section below and in CI's db-tests job.
Run is post-SEC-013 (Argon2id) + PERF-004 (O(1) max-meter index). Numbers vary a few
percent between runs on this shared host; ranges noted where observed.

| Exp | Workload                                          | p50                                                      | p95                                                      | p99                                                       | Extra                                                            |
| --- | ------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | 200× sequential `GET /stations`                   | 1 ms                                                     | 5 ms                                                     | 7 ms                                                      | 0 errors                                                         |
| 2   | 20 parallel same-window reserves, 1 hot connector | 37–45 ms                                                 | 54 ms                                                    | 54 ms                                                     | **exactly 1×201 + 19×409** (lock scope proven)                   |
| 3   | 2000 sequential `recordTick` on one session       | —                                                        | —                                                        | —                                                         | **38,462–50,000 ticks/s** (PERF-004 O(1) check; pre-fix 19,231)  |
| 5   | concurrent `GET /stations` step-load              | 10 VU: 8–9 ms / 50 VU: 53–66 ms / 100 VU: 60–75 ms (p50) | 10 VU: 9 ms / 50 VU: 93–542 ms / 100 VU: 97–141 ms (p95) | 10 VU: 9 ms / 50 VU: 94–543 ms / 100 VU: 100–146 ms (p99) | 0 errors at all levels; one 50-VU run hit shared-host contention |

## Measured — experiment 4: TimescaleDB cagg vs raw (2026-09-07)

Executed on the real TimescaleDB 2.17.2-pg16 container (Docker 29.5.3), 1.2M synthetic
`meter_tick` rows across 16 connectors, continuous aggregates refreshed, 24 h window.
Methodology: `bench/cagg-compare.sql` (`EXPLAIN (ANALYZE, BUFFERS)`), one run each —
numbers are medians-ish single executions, reported as measured.

| Path                   | Rows read (24 h) | Execution time            | Note                                                              |
| ---------------------- | ---------------- | ------------------------- | ----------------------------------------------------------------- |
| Raw hypertable scan    | 86,340           | 41.6 ms                   | 5-minute buckets, AVG/MAX kW per bucket                           |
| `tick_1m` cagg         | 46,033           | 52.2 ms                   | per-minute rows ≈ 2× raw buckets; win is on wide/repeated windows |
| `tick_1h` cagg (hier.) | 768              | **0.74 ms (~56× vs raw)** | index scan over 768 pre-aggregated rows                           |

Verdict (honest): the hierarchical 1-hour cagg is the query-time win for dashboards
(56× on this shape); the 1-minute cagg's value is avoiding a re-scan of the full raw
window on every load — measured here at parity on a single 24 h slice, better on wider
retention windows. Compression ratio is NOT claimed: the 7-day compression policy has
not triggered for the synthetic data, so `hypertable_compression_stats` reports no
compressed bytes — nothing compressed, nothing claimed.

## Still pending (full profile)

- Full-profile runs of 1/2/3/5 under `docker compose` with Oracle + Timescale
  (pool saturation at `poolMax=8` is only observable there). Note: the e2e job WAS
  executed locally on the full compose stack (see `docs/verification.md`), but the
  k6 load gates (`test/load/`) still require a DB-backed build + k6.

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
