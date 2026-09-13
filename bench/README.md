# bench/ — reproducible performance experiments (§12.5)

Every published number in `docs/perf.md` must come from a committed script here +
a stated hardware spec. No script, no number (BUG-010).

## Experiments

| #   | Script                     | What it measures                                                                                                                                                                                  |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `k6-discovery.js`          | `/stations` geo query p95: JS aggregation vs `v_station_summary`                                                                                                                                  |
| 2   | `k6-reserve-contention.js` | reservation latency: 1 hot connector vs N (lock scope)                                                                                                                                            |
| 3   | burst (simulator)          | `node apps/simulator/src/index.js --scenario burst --chargers 50` → relay INSERT rows/s, outbox-lag p95                                                                                           |
| 4   | `cagg-compare.sql`         | 24 h load curve: raw hypertable scan vs `tick_1m` vs `tick_1h`                                                                                                                                    |
| 5   | `test/load/k6-smoke.js`    | read-path step load 10→50→100 VUs, p50/p95/p99 + pool saturation                                                                                                                                  |
| 6   | `e1-cost.js`               | historical (2026-09-13): the solver re-implemented inside the script — superseded by E1b, kept as history                                                                                         |
| 7   | `e1b-cost.js`              | **cost / peak / calibration: the SHIPPED solver** vs static-cap, price-blind EDF, uncontrolled; 2 arms (compliant, 25% non-compliant); 200 paired seeds, bootstrap CIs                            |
| 8   | `e3-deadline.js`           | **promise-keeping under overload**: admission refusal, certificate calibration and deadline-miss vs load (ρ 0.6/0.9/1.2) in two SoC families (target 80%, target 95% where the CC-CV taper binds) |

E1b/E3 run in seconds and need no Docker or k6: `npm run bench:e1b`, `npm run bench:e3`
(receipts: `bench/results/e1b-cost.json`, `bench/results/e3-deadline.json`). Their workload
comes from the deterministic twin (`apps/simulator/src/twin.js`) and every strategy is
scored by the same harness (`apps/simulator/src/offline.js`) on the same population.

**Reproducibility is an enforced property, not a hope.** Scenarios are generated at a
fixed UTC epoch (`twin.SCENARIO_EPOCH` = `2026-03-02T00:00:00Z`, recorded in every receipt
as `args.scenario_epoch`) and the twin reads all diurnal quantities in UTC. Before that,
these receipts were anchored to `Date.now()` and `getHours()`, so re-running the same
command after a wall-clock or timezone change produced different numbers while the
protocol claimed they were "reproducible from their seed" — the twin's tests now pin both
properties. A receipt is only evidence if you can regenerate it.

Local shortcut (no k6/Docker): `node bench/run-local.js` → `bench/results-local.json`
(measured tables land in `docs/perf.md`).

## Rules that make these receipts usable

1. **One script per experiment id** (ADR-0013). Changing a metric, a baseline or the
   solver under test after results exist means a **new id** — `e1-cost.js` stays committed
   as the historical record of a solver the bench implemented itself; `e1b` supersedes it
   and imports `apps/api/src/control/model.solveSchedule` (the code that ships).
2. **Paired seeds.** Every strategy is scored on the identical fleet for a given seed.
3. **Same population.** Deadline-miss and calibration are measured on the vehicles the
   controller _promised_ to serve, for every strategy — otherwise a baseline can look
   better by serving fewer, easier vehicles.
4. **Cost is never read alone.** `total_cost_units` always sits beside `delivered_kwh`,
   `cost_per_kwh_delivered` and `deadline_miss_rate`, because under-delivering is cheaper.
5. **A failed hypothesis exits 0 and is published.** Only an envelope (planned-peak)
   violation exits non-zero: safety is not a statistic.
6. **A receipt is regenerable from its seeds alone.** No wall clock, no timezone, no
   ambient state: scenarios are anchored to the fixed UTC epoch recorded in `args`.

## cagg-compare.sql

See `bench/cagg-compare.sql` — run with `psql -h $TS_HOST -U $TS_USER -d $TS_DB -f bench/cagg-compare.sql`
after seeding ≥1M ticks. Record `EXPLAIN (ANALYZE, BUFFERS)` medians + hardware spec.

## Status

Local-profile runs measured 2026-09-05 (`bench/results-local.json`, tables in
`docs/perf.md`); full-profile runs (compose + k6 + ≥1M ticks) remain for the
DB-backed build. The committed `test/load/k6-smoke.js` thresholds
(p95 < 300 ms, failures < 2%) are the gates to beat.
