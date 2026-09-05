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

| # | Experiment | Command | What to report |
|---|---|---|---|
| 1 | Discovery: JS aggregation vs `v_station_summary` | `k6 run bench/k6-discovery.js` (50 VUs) | p50/p95/p99 + error rate, both paths |
| 2 | Reservation contention: 1 connector vs N | `k6 run bench/k6-reserve-contention.js` | serialized latency on hot connector, linear scaling on N |
| 3 | Telemetry ingest: 50 chargers × 5 s × 10 min | `node apps/simulator/src/index.js --scenario burst --chargers 50` | relay batches/s, COPY rows/s, outbox-lag p95 |
| 4 | Cagg analytics: raw scan vs `tick_1m` vs `tick_1h` | `psql -f bench/cagg-compare.sql` | latency + rows scanned at ≥1M ticks |
| 5 | Read-path step load 10→50→100 VUs | `k6 run test/load/k6-smoke.js` | p50/p95/p99 + pool saturation (`poolMax=8`) |

Reporting format: one table per experiment + hardware spec (CPU/RAM/disk, container
limits) + committed scripts under `bench/`. Ratios (cagg vs raw) preferred over
absolutes where hardware varies.

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
