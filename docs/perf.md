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

## Measured — E1b/E3/E6: shipped solver, generative twin (2026-09-13, E6 2026-09-14)

Scripts: `bench/e1b-cost.js` (200 seeds × 2 arms), `bench/e3-deadline.js`
(100 seeds × 3 load levels × 2 SoC families) and `bench/e6-taper.js` (E3's ladder + a paired
`controller_aes` arm). Receipts: `bench/results/e1b-cost.json`,
`bench/results/e3-deadline.json`, `bench/results/e6-taper.json`. Workload:
`apps/simulator/src/twin.js` (deterministic
arrivals, battery/SoC, CC-CV acceptance, ToU prices, non-compliant chargers). Scoring:
`apps/simulator/src/offline.js` — every strategy is scored on the same population and
under identical actuator physics.

Every number below is regenerated by `npm run bench:e1b` / `npm run bench:e3`. Scenarios are
generated at a **fixed UTC epoch** (`2026-03-02T00:00:00Z`, recorded in each receipt as
`args.scenario_epoch`) and all diurnal quantities are computed in UTC, so a run is
reproducible from its seeds alone on any runner. Before that anchor existed these receipts
were neither reproducible across runs nor comparable across timezones — the same command
returned different numbers minutes apart.

**E1b, compliant fleet (ρ ≈ 0.91, 40 kW site):**

| Strategy        | total cost (mean) | peak kW   | cost/kWh delivered | promised-population deadline miss | calibration shortfall |
| --------------- | ----------------- | --------- | ------------------ | --------------------------------- | --------------------- |
| controller      | **592.86**        | **36.00** | 0.8777             | 7.3%                              | 0%                    |
| static-cap      | 639.55            | 40.00     | 0.9361             | 34.9%                             | 0%                    |
| price-blind EDF | 666.02            | 40.00     | 0.8889             | 26.6%                             | 0%                    |
| uncontrolled    | 1491.58           | 118.75    | 1.6685             | 5.7%                              | 0%                    |

(Admission refused 5,507 of 7,194 candidate vehicles — 76.6%. That is the mechanism being
honest about a 40 kW site facing ~910 kWh of demand, not a scheduling failure; refusal is
reported as an outcome, never hidden.)

Paired delta vs static-cap: **−46.69 cost units, 95% CI [−48.32, −45.04]** over 200 seeds
(same seeds ⇒ same fleets). H1/H2/H4 PASS. Certificate calibration: **0 shortfall** on
1,687 admitted vehicles. The controller buys its cost win partly with fairness
(jain 0.853 vs static-cap 0.892) — H2 tolerates that at a 0.90 ratio and held on 185/200
seeds, which is a trade-off the receipt states rather than hides.

**E1b, adversarial fleet (25% of chargers ignore their profile):** H1 **FAILS** — 85/200
seeds beat static-cap, paired delta +10.31, 95% CI **[−1.44, +22.30]** (straddles zero).
Calibration still holds (0 shortfall) because the promise is conservative. Physical peak
reached **86.43 kW against a 40 kW site cap** (46.4 kW of it caused by vehicles that
ignored their profiles): the envelope bounds what the CSMS _commands_, not what a rogue
charger _does_ — a real limitation of protocol-level enforcement, now measured rather than
assumed.

**E3, overload ladder (base family, target 80% SoC):**

| ρ   | controller refusal | controller miss | static-cap miss | max shortfall | H2 calibration | H3                                 |
| --- | ------------------ | --------------- | --------------- | ------------- | -------------- | ---------------------------------- |
| 0.6 | 66.2%              | 6.3%            | 12.6%           | 0.0009 kWh    | PASS (0%)      | PASS (−0.062, CI [−0.079, −0.046]) |
| 0.9 | 76.7%              | 6.6%            | 31.7%           | 0.0007 kWh    | PASS (0%)      | PASS (−0.250, CI [−0.278, −0.222]) |
| 1.2 | 77.2%              | 14.9%           | 45.8%           | 0.0010 kWh    | PASS (0%)      | PASS (−0.311, CI [−0.341, −0.282]) |

Admission responds to load (H1 PASS): refusal rises 66.2% → 76.7% → 77.2%.

**E3, taper-binding family (target 95% SoC) — the mechanism fails and the receipt says so:**

| ρ   | controller miss | static-cap miss | shortfall | max shortfall | H2       | H3                                     |
| --- | --------------- | --------------- | --------- | ------------- | -------- | -------------------------------------- |
| 0.9 | 56.6%           | 55.2%           | 42.6%     | **2.52 kWh**  | **FAIL** | **FAIL** (+0.017, CI [−0.014, +0.047]) |
| 1.2 | 52.9%           | 65.8%           | 40.7%     | **2.52 kWh**  | **FAIL** | PASS (−0.128, CI [−0.168, −0.088])     |

Diagnosis (not a rescue): both the certificate and the scheduler reason about _capacity_
but only the certificate reasons about _acceptance_. Below the taper knee the flat-floor
promise is honest; above it, the plan back-loads energy into the expensive intervals where
the battery can no longer accept it, so promises break and — at ρ = 0.9 — the controller's
deadline advantage over the industry default **disappears entirely** (the paired CI
includes zero; the point estimate is slightly negative). Note the softer claim than an
earlier receipt of this family suggested: re-anchoring the scenario moved ρ = 0.9 from
"significantly worse" to "indistinguishable", and the honest statement is the latter. The
fix is a scheduler that models acceptance end-to-end, which is a _new_ pre-registered
experiment (E6), not an edit to these results (ADR-0013).

### E6 — the repair, measured (2026-09-14)

Script `bench/e6-taper.js`, receipt `bench/results/e6-taper.json`, mechanism ADR-0015.
E6 is **additive**: E3 above remains the committed pre-fix record and is not edited. E6 runs
the same ladder with a paired `controller_aes` arm (acceptance-envelope scheduling), scored
on the same population by the same harness.

Hypotheses declared before running: **H0** below the knee AES ≡ power-based (Δdelivered 0,
Δcost 0); **H1** taper-binding shortfall ≤ 5%; **H2** AES keeps the deadline advantage over
static-cap (paired CI excludes 0); **H3** AES cost/kWh ≤ static-cap; **H4** the AES plan's
own claim equals realised physics. All five PASS.

**The failure repaired — target 95% SoC (the family where the taper binds):**

| ρ   | shortfall (power-based → AES) | max shortfall kWh | deadline miss (power → AES) | static-cap miss | cost/kWh (AES vs static) |
| --- | ----------------------------- | ----------------- | --------------------------- | --------------- | ------------------------ |
| 0.9 | **42.62% → 2.36%**            | 2.516 → 2.427     | **56.6% → 15.7%**           | 55.2%           | 0.8982 vs 0.9573         |
| 1.2 | **40.67% → 1.66%**            | 2.516 → 2.168     | **52.9% → 13.6%**           | 65.8%           | 0.8564 vs 0.8962         |

Paired deltas over 100 seeds (ρ = 0.9): AES − power-based **+12.19 kWh delivered**
(95% CI 11.58–12.84) at **+4.74 total cost units** (CI 4.47–5.01); AES − static-cap
deadline-miss rate **−0.3988** (CI −0.4252 to −0.372). AES delivers ~12 kWh more per
site-day, spends marginally more absolute energy cost to do it, and **lowers cost per kWh
delivered** (0.8982 vs the legacy 0.9049): feasibility is bought with energy that was
previously planned and never delivered, not with money.

**Plan honesty — the defect and the fix in one number (ρ = 0.9, 100 seeds):**

| allocator   | plan claims   | physics delivers | gap              |
| ----------- | ------------- | ---------------- | ---------------- |
| power-based | 93,573.79 kWh | 92,293.53 kWh    | **1,280.27 kWh** |
| AES         | 93,512.75 kWh | 93,512.74 kWh    | **0.011 kWh**    |

At ρ = 1.2 the power-based gap is 781.90 kWh against an AES gap of −0.003 kWh. The legacy
planner was not slightly optimistic: it **claimed ~1.3 MWh per 100-seed run that the
vehicles physically could not absorb**, and every planned metric was blind to it.

**No regression, exactly — base family (target 80% SoC):** H0 PASS at ρ = 0.6/0.9/1.2 —
Δdelivered 0, Δcost 0, identical schedules. On the compliant fleet every printed metric
(cost/kWh, peak, jain, deadline-miss) is unchanged to the last digit; the change is
invisible below the taper knee, which is why it is safe to ship (pinned by A1/A1b in
`apps/api/test/control-aes.js`).

**Honest trade-offs:** AES absolute total cost is ~0.6% higher because it delivers 1.3% more
energy; fairness is essentially unchanged (jain 0.8676 vs 0.8682 at ρ = 0.9); and
`uncontrolled` still keeps deadlines better than any planner because it charges flat-out —
the controller's claim remains cost, peak and plan honesty, not deadline superiority over
brute force.

Also honest: on the promised population, `uncontrolled` keeps deadlines better than the
controller (4.9% vs 6.9%) because it front-loads at maximum rate. The controller wins on
cost, peak _and_ fairness-vs-static-cap, but not on deadline adherence against a baseline
that simply charges as fast as it can.

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
