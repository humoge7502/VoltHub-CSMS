# bench/ — reproducible performance experiments (§12.5)

Every published number in `docs/perf.md` must come from a committed script here +
a stated hardware spec. No script, no number (BUG-010).

## Experiments

| #   | Script                     | What it measures                                                                                        |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | `k6-discovery.js`          | `/stations` geo query p95: JS aggregation vs `v_station_summary`                                        |
| 2   | `k6-reserve-contention.js` | reservation latency: 1 hot connector vs N (lock scope)                                                  |
| 3   | burst (simulator)          | `node apps/simulator/src/index.js --scenario burst --chargers 50` → relay INSERT rows/s, outbox-lag p95 |
| 4   | `cagg-compare.sql`         | 24 h load curve: raw hypertable scan vs `tick_1m` vs `tick_1h`                                          |
| 5   | `test/load/k6-smoke.js`    | read-path step load 10→50→100 VUs, p50/p95/p99 + pool saturation                                        |

Local shortcut (no k6/Docker): `node bench/run-local.js` → `bench/results-local.json`
(measured tables land in `docs/perf.md`).

## cagg-compare.sql

See `bench/cagg-compare.sql` — run with `psql -h $TS_HOST -U $TS_USER -d $TS_DB -f bench/cagg-compare.sql`
after seeding ≥1M ticks. Record `EXPLAIN (ANALYZE, BUFFERS)` medians + hardware spec.

## Status

Local-profile runs measured 2026-09-05 (`bench/results-local.json`, tables in
`docs/perf.md`); full-profile runs (compose + k6 + ≥1M ticks) remain for the
DB-backed build. The committed `test/load/k6-smoke.js` thresholds
(p95 < 300 ms, failures < 2%) are the gates to beat.
