# VoltHub CSMS — Performance, Scalability & Verification Audit

**Date:** 25 October 2026  
**Snapshot:** `ce9160e` plus the working-tree changes present on 25 Oct 2026 (the tree was already dirty; nothing was reverted or staged).  
**Scope:** API hot paths (`apps/api`), OCPP 1.6J gateway, in-process store and Oracle adapter, TimescaleDB read paths, outbox relay (`apps/worker`), carbon/AI read paths, CI and test gates.  
**Mode:** read-only. No application source was modified. This report is the only file added by this audit.  
**Method:** direct code reads, read-only `EXPLAIN`/`EXPLAIN ANALYZE` against the running Docker databases, the existing test/bench suites, and six standalone Node harnesses under `C:\Users\Devesh tiwari\AppData\Local\Temp\opencode\` (listed in Appendix A).  
**Machine:** Windows 11, AMD Ryzen 7 7435HS (8C/16T), 17 GB RAM, Node v24.16.0. CI targets Node 20/22, so absolute numbers are not directly comparable to CI or to the EPYC/Linux receipt in `docs/perf.md`.  
**Databases:** Oracle Free 23ai and TimescaleDB 2.17.2-pg16, both local Docker containers, read-only queries. Oracle held 1,260 `meter_reading`, 34 `reservation`, 443 `outbox_event`; Timescale held 14,231 `meter_tick` rows, 9 chunks and 4 continuous aggregates.

**Labeling:** every number is marked **measured** (this machine, this run) or **estimated** (extrapolated from measured complexity/plans, or from the repo's own 1.2M-row receipt). A measured absolute on this laptop is not a capacity claim for production; the ratios and the algorithmic cliffs are the transferable evidence.

---

## 0. Verdict at a glance

> **The system is fast while the data is small, and its money-path invariants are genuinely strong. Three measured cliffs break the 100-charger story once the process has been up for a while: outbox pruning collapses ingest from 149,226 ticks/s to 43 ticks/s, every power-only gateway MeterValues frame scans all telemetry, and list endpoints materialise the whole domain before pagination. None needs a rewrite; each is an O(N) hot path with a bounded fix. The larger long-term risk is memory: readings are hydrated twice, every session keeps a sequence Set, and unacked outbox rows are never dropped. At 10M readings the process needs ~3 GB; at 20k sessions station analytics takes 6.8 s.**

**Release posture**

| Context                                                                 | Verdict                                                                                                                                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Demo, 100 chargers, fresh process, <10k sessions                        | Works. The measured test suite is green and the money path is race-tested.                                                                    |
| Same 100-charger fleet after ~21 minutes with an active control profile | **Fragile.** The outbox crosses 50k acked rows and every emit pays a 22 ms prune; gateway frames still scan every reading.                    |
| ~1k stations / 1M rows                                                  | **Does not meet NFR-03** (p95 <300 ms): discovery 1.03 s, sessions 1.74 s, station analytics 6.76 s at 20k, carbon ~2.8 s (estimated) at 300k. |
| Sink outage / Timescale down                                            | **Unbounded memory.** Unacked events are never dropped; at 40 events/s the queue grows ~3.46M events/day (estimated 1.4 GB/day).              |

**What is genuinely working**

- **The money path is database-enforced, not application-asserted.** Reservation overlap and wallet payment run under Oracle row locks/packages, and the race suite fires real concurrent requests (`apps/api/test/race.js`; 2/2 measured).
- **The relay is ack-after-commit.** It acknowledges only rows that landed or were quarantined, and the chaos tests cover API-down, ack failure and recovery replay (`apps/worker/test/relay.test.js`; 14/14 measured).
- **The Timescale read plan is sane at small scale.** `loadCurve` uses `ix_tick_conn_ts` and a nested loop, not a sequential scan; the caggs exist and are refreshed (`db/timescale/T001__hypertables.sql`, `T002__caggs.sql`).
- **Argon2 is off the event loop** (`apps/api/src/db/store.js:419`), the OCPP ack sweeper is `unref`'d and cleared on close (`apps/api/src/ocpp/gateway.js:311-322`), and rate-limit maps are swept (`apps/api/src/middleware/security.js:121-125`). These were checked and are **not** reported as leaks.
- **API/OpenAPI drift is gated** (`scripts/check-openapi.js`: 82 spec paths, ~87 routes, no missing paths, 0.80 s measured).

**What must change before scale**

1. Take `pruneOutbox()` off the emit path (PF-01).
2. Replace the gateway's full scans with per-connector/per-session indexes (PF-03).
3. Fix the quadratic station-analytics join and the unpaginated list endpoints (PF-04, PF-17).
4. Bound hydration and outbox memory (PF-02, PF-06).
5. Make the CI load/coverage gates real (PF-16).

---

## 1. Scope, method and severity policy

### 1.1 In scope

- Reservation/session/telemetry reads and writes: `apps/api/src/routes.js`, `db/store.js`, `db/oracle.js`, `db/timescale.js`.
- OCPP gateway: BootNotification, StatusNotification, MeterValues, StopTransaction, remote commands, ack sweeper.
- Outbox emit/ack/prune and the worker relay (`apps/worker/src/index.js`, `relay-timescale.js`).
- Health/metrics, carbon summary, AI sidecar input assembly.
- Oracle schema/PLSQL, Timescale hypertables/caggs/retention/policies.
- Test suites, CI gates and load/chaos/security/a11y coverage.

### 1.2 Out of scope

- Changing application code (the only write is this report).
- A full production-like load test: k6 is not installed on this machine, so no k6/soak run was executed. This is called out again in §7.
- Multi-instance behaviour: the store is a documented single-VM read cache (`apps/api/src/db/oracle.js:1-5`); this audit evaluates that architecture, not a clustered variant.

### 1.3 Severity policy

| Severity | Definition                                                                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0**   | Measured collapse or event-loop blocking reachable in normal operation at the project's own 100-charger / 5-second-tick target, or a data-loss/correctness path. |
| **P1**   | NFR-03/NFR-04 breach at ~1k stations or ~1M rows, or a failure mode that takes the service down without a code change.                                           |
| **P2**   | Scale risk above ~10k stations/rows, or a moderate inefficiency worth scheduling.                                                                                |
| **P3**   | Minor/cosmetic performance issue.                                                                                                                                |

NFR-03 is p95 <300 ms for interactive API on laptop-scale data (10k sessions); NFR-04 is ingest lag <30 s for 50 chargers × 5 s ticks (`docs/masterplan/02-requirements-scope-roles.md:108-109`). The 100-charger burst is the repo's own soak target (`docs/perf.md:40-44`).

### 1.4 How to read the numbers

- **Measured** means the harness ran on this machine against the current tree, with the row counts stated.
- **Estimated** means a projection from a measured slope/plan, or from the repo's 1.2M-row cagg receipt. Estimates are deliberately conservative and say what they assume.
- **p50/p95** are over the stated number of runs; one-shot numbers are labelled as such.
- Throughput numbers are single-process, in-memory, with no HTTP/JSON/DB in the loop unless stated. They isolate the algorithmic cost of the store/gateway path; they are not end-to-end API throughput.

---

## 2. Verified baseline

### 2.1 Test and verification receipts (measured)

All commands were run on 25 Oct 2026 against the current working tree. Wall clock is a single run on this machine, not a CI benchmark.

| Suite              | Command                               | Result                                            | Wall clock |
| ------------------ | ------------------------------------- | ------------------------------------------------- | ---------: |
| API contract/unit  | `node apps/api/test/run.js`           | **44/44 passed**                                  |     1.98 s |
| Rate limiting      | `node apps/api/test/ratelimit.js`     | **8/8 passed**                                    |     1.49 s |
| Security           | `node apps/api/test/security.js`      | **19/19 passed**                                  |     2.30 s |
| Race (local store) | `node apps/api/test/race.js`          | **2/2 passed** (R1 double-reserve, R4 double-pay) |     0.81 s |
| Worker relay       | `node apps/worker/test/relay.test.js` | **14/14 passed**                                  |     0.21 s |
| Carbon             | `node apps/api/test/carbon.js`        | **8/8 passed**                                    |     1.53 s |
| Wallet             | `node apps/api/test/wallet.js`        | **14/14 passed**                                  |     0.87 s |
| Control AES        | `node apps/api/test/control-aes.js`   | **6/6 passed**                                    |     0.10 s |
| AI contract        | `node apps/api/test/ai.js`            | **10/10 passed**                                  |     1.27 s |
| OpenAPI drift      | `node scripts/check-openapi.js`       | **82 spec paths, ~87 routes, no missing paths**   |     0.80 s |

The root `npm test` additionally includes `xlayer`, `ocpp-remote`, `gateway-close`, `control`, `ocpp-commands`, `oracle-adapter`, `twin`, SQL invariants and the OpenAPI check. Those were not all rerun in this pass; the subset above is the rerun evidence. No suite was modified to make it pass.

### 2.2 Store/gateway microbenchmarks (measured)

Standalone harnesses call the real store/gateway functions with synthetic Maps/arrays. Node v24.16.0, single process, no HTTP.

| Path                                                |                             Data size |                                       p50 |                                   p95 | What it means                                                                            |
| --------------------------------------------------- | ------------------------------------: | ----------------------------------------: | ------------------------------------: | ---------------------------------------------------------------------------------------- |
| `recordTick` clean                                  |                           2,000 ticks |                       **149,226 ticks/s** |                                     — | The hot write path is fast when the outbox is not full.                                  |
| `recordTick` with 19,999 acked outbox rows          |                             500 ticks |                           **183 ticks/s** |                                     — | The first emit crosses 20k; the other 499 pay prune, so the average already collapses.   |
| `recordTick` with 20,000 acked outbox rows          |                             300 ticks |                           **106 ticks/s** |                                     — | Every emit now calls `pruneOutbox()`; **1,408× collapse** vs clean.                      |
| `recordTick` with 50,000 acked outbox rows          |                             100 ticks |                            **43 ticks/s** |                                     — | 3,470× collapse; 23 ms per tick.                                                         |
| `pruneOutbox`, 20k acked                            |                           20,001 rows |                               **5.73 ms** |                           **8.48 ms** | The cost paid on every emit once over the soft cap.                                      |
| `pruneOutbox`, 50k acked                            |                           50,000 rows |                              **22.56 ms** |                          **28.65 ms** | Event-loop block per tick.                                                               |
| `emitOutbox`, 50k unacked                           |                           50,000 rows |                               **1.46 ms** |                           **2.10 ms** | Even with no acked rows, the over-cap prune scans the queue on every emit.               |
| `outboxLag`                                         |                             20k / 50k |                           3.68 / 10.50 ms |                       5.93 / 13.98 ms | Called by `/health`, `/health/deep`, `/metrics`, `/internal/outbox`.                     |
| `/internal/outbox` shape                            |                             20k / 50k |                           8.75 / 23.23 ms |                      18.73 / 28.54 ms | Two full filters per poll.                                                               |
| MeterValues power-only frame                        |                    250k / 1M readings |                        4.34 / **5.87 ms** |                        4.63 / 7.80 ms | Full `readings.filter(...).reduce(...)` per frame.                                       |
| StatusNotification frame                            |     100k / 1M sessions + reservations |                       3.91 / **40.88 ms** |                       6.69 / 55.82 ms | Two full `Map.values()` scans per frame.                                                 |
| `/sessions/:id/live`                                |                           1M readings |                               **9.41 ms** |                              12.89 ms | Full `readings.filter`; `readingsFor` is 0.3 µs (≈31,000× faster at p50).                |
| `/sessions/active/:ref`                             |                           1M sessions |               22.35 ms miss / 6.46 ms hit |                                     — | Full session scan.                                                                       |
| `/stations`                                         |          100 / 500 / 1k / 2k stations | 15.98 / 125.72 / **1,033.4 / 3,863.0 ms** | 20.05 / 181.33 / 1,124.7 / 4,645.5 ms | All stations/CPs/connectors built before the 20-row slice.                               |
| `/sessions` admin list                              |                           1M sessions |                              **1,741 ms** |                            1,807.5 ms | `localeCompare` sort of all sessions before the 20-row page.                             |
| `/reservations`                                     |                       1M reservations |                                   36.5 ms |                               53.0 ms | Unpaginated handler; JSON payload is the larger cost (estimated).                        |
| `/invoices`                                         |                           1M invoices |                                   29.6 ms |                               35.7 ms | Unpaginated handler; JSON payload is the larger cost (estimated).                        |
| `/stations/:id/analytics`                           | 2k / 5k / 10k / 20k sessions+invoices |         59 / 370.7 / 870 / **6,762.6 ms** |                                     — | O(S×I): a full invoice array is materialised and `find`-ed for each session.             |
| `hourlyStationKwh`                                  |                    100k / 1M sessions |                     91.45 / **986.75 ms** |                  138.78 / 1,149.50 ms | Full session scan per `/ai/forecast`.                                                    |
| Carbon `summarize`                                  |          100k / 1M in-window sessions |                        934 / **5,172 ms** |                                     — | Synthetic upper bound: every row matches the window; filter+sort dominates.              |
| `expireStale`                                       |                100k / 1M reservations |                          12.57 / 45.57 ms |                                     — | Full reservation scan; no `(status, start_at)` index.                                    |
| First `recordTick` after restart                    |                    250k / 1M readings |                       6.85 / **19.13 ms** |                                     — | One full scan per session on first sight.                                                |
| Profile pair (`activeProfileFor` + `scheduledKwAt`) |                1k / 10k / 100k pushes |               0.049 / 0.132 / **2.80 ms** |               0.161 / 0.202 / 4.08 ms | Called twice per MeterValues frame when a profile is in force.                           |
| Hydrated reading memory                             |                          200,000 rows |                         **317 B/reading** |                                     — | Includes `readings`, duplicate `ticks`, and `_seqSeen`; 10M rows ≈ **2.95 GiB (~3 GB)**. |

### 2.3 Database checks (measured, small data)

| Check                                         | Result                                                                                                    | Reading                                                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Oracle `expire_stale` plan (34 reservations)  | `INDEX SKIP SCAN IX_RES_USER_STATUS`; access on `status`, filter on `start_at`                            | No `(status, start_at)` index exists (`db/oracle/V001__core_schema.sql:359-373`). At scale the sweep is O(BOOKED), not a time range.                                       |
| Oracle overlap insert plan (34 rows)          | `INDEX SKIP SCAN IX_RES_USER_STATUS`; the optimizer prefers it to `ix_res_conn_start` at this cardinality | The schema does have `ix_res_conn_start(connector_ref, start_at)` (`V001:362`); the audit did **not** measure this at 1M. The expire path is the clear missing-index case. |
| Oracle `MAX(meter_kwh)`                       | **PK range scan**, not a full table scan                                                                  | The per-tick monotonic check is not the bottleneck.                                                                                                                        |
| Timescale `loadCurve`, 30-day fleet, warm     | **17.2 ms**                                                                                               | 14,231 ticks; nested loop on `ix_tick_conn_ts`; decompresses 2 chunks.                                                                                                     |
| Timescale `loadCurve`, station-filtered, warm | **4.8 ms**                                                                                                | Same plan, smaller range.                                                                                                                                                  |
| Timescale `loadCurve`, first cold run         | **304 ms**                                                                                                | Cold decompression/first touch; not a steady-state number.                                                                                                                 |
| Caggs present                                 | `tick_1m`, `tick_1h`, `state_1m`, `enforcement_5m`                                                        | All 4 exist. The API **never references** them: the only mention of `tick_1m`/`tick_1h` in `apps/` is a comment at `apps/api/src/db/timescale.js:10`.                      |
| Retention/compression                         | `meter_tick` 90-day retention, 7-day compression                                                          | `db/timescale/T001__hypertables.sql:27-32`.                                                                                                                                |
| Repo's own 1.2M-row cagg receipt              | raw 24 h **41.6 ms**, `tick_1h` **0.74 ms** (≈56×)                                                        | `docs/perf.md:69-85`; measured on the project's EPYC/Linux/Node20 machine, not this one.                                                                                   |

### 2.4 What the baseline says

- The **clean** store is not slow: 149k ticks/s in-process, 44 API tests in 2 s, and a 14k-row Timescale read in 17 ms.
- The slowdowns are **data-volume thresholds**, not constant overheads: 20k acked outbox rows, 1M readings, 1k stations, 20k sessions with invoices.
- The system's own 100-charger / 5 s target reaches those thresholds quickly: 20 ticks/s means 20k events in ~17 minutes and 1M readings in ~14 hours. With an active control profile, a MeterValues frame also emits an `ENFORCEMENT_TICK`, so the outbox rate is ~40 events/s and 20k is reached in ~8 minutes.

---

## 3. Prioritized findings

Effort is engineering hours, not elapsed time. Dependencies are real prerequisites, not soft ordering.

| ID        | Finding                                                                                                                                                                                                           | Sev    | Evidence (file:line)                                                                                                                   | Impact (measured unless marked est.)                                                                                                                                               | Effort | Depends on                       | Target |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | -------------------------------- | ------ |
| **PF-01** | `emitOutbox` calls `pruneOutbox()` on every emit once the queue passes the 20k soft cap; prune filters and sorts all acked rows                                                                                   | **P0** | `store.js:279-291`, `299-325`; ack path `routes.js:1238`                                                                               | 149,226 → **106 ticks/s** at 20k acked; **43 ticks/s** at 50k; prune p50 **22.56 ms** at 50k                                                                                       |    6 h | none                             | Day 1  |
| **PF-02** | Unacked outbox rows are never dropped; soft/hard caps only shed acked rows, so a sink outage grows memory without bound                                                                                           | **P1** | `store.js:75-78`, `294-325`                                                                                                            | 40 events/s ≈ 3.46M events/day; **~1.4 GB/day est.** at 400 B/event; emit at 50k unacked costs 1.46 ms                                                                             |   12 h | PF-01                            | Week 1 |
| **PF-03** | Gateway full scans: StatusNotification scans every session and reservation; MeterValues power-only scans every reading; first frame per session scans all readings for `MAX(seq)`                                 | **P0** | `gateway.js:441-446`, `562-564`, `604-609`                                                                                             | MeterValues **5.87 ms** at 1M readings (4.34 ms at 250k); StatusNotification **40.88 ms** at 1M sessions/reservations                                                              |    8 h | none                             | Day 1  |
| **PF-04** | Discovery and list endpoints materialise/sort the whole domain before pagination; reservations/invoices are unpaginated                                                                                           | **P1** | `routes.js:243-264`, `288-292`, `436-443`, `644`, `679-694`                                                                            | `/stations` **1,033 ms** at 1k/20k, **3,863 ms** at 2k/40k; `/sessions` **1,741 ms** at 1M; `/reservations` 36.5 ms + huge JSON                                                    |   16 h | none                             | Week 2 |
| **PF-05** | Live/active session reads scan all readings or all sessions instead of using `readingsFor`/a connector index                                                                                                      | **P1** | `routes.js:514-516`, `545`; `store.js:402-416`                                                                                         | `/sessions/:id/live` **9.41 ms** at 1M; `/sessions/active/:ref` 22.35 ms miss at 1M; `readingsFor` 0.3 µs                                                                          |    2 h | none                             | Day 1  |
| **PF-06** | Boot hydration loads all `meter_reading` into `readings` **and** duplicates into `ticks` + `_seqSeen`/`_maxMeter`; server binds only after hydration                                                              | **P1** | `oracle.js:342-382`, `530-556`; `server.js:156-162`                                                                                    | **317 B/reading**; 10M rows ≈ **2.95 GiB (~3 GB)**; 1M reads ≈ 317 MB; boot time grows with rows (est.)                                                                            |   24 h | PF-02; retention decision        | Week 2 |
| **PF-07** | Carbon summary filters/sorts all sessions before its 2k limit; station detail calls it on every request                                                                                                           | **P1** | `carbon/intensity.js:475-499`; `carbon-routes.js:43`; `routes.js:862-867`                                                              | **934 ms** at 100k, **5,172 ms** at 1M in-window sessions (synthetic upper bound)                                                                                                  |   12 h | PF-06 for memory, not for rollup | Week 2 |
| **PF-08** | Timescale reads always hit raw `meter_tick`; caggs are unused; read pool is max 4 with a 2.5 s fail-fast                                                                                                          | **P1** | `timescale.js:27-39`, `54-74`, `82-98`; `T002__caggs.sql:11-53`                                                                        | 17.2 ms at 14k ticks warm; repo receipt: raw 41.6 ms vs `tick_1h` 0.74 ms at 1.2M rows; 4 connections shared by all reads                                                          |   12 h | none                             | Week 2 |
| **PF-09** | Worker drains exactly one 500-event batch per 2 s cycle; theoretical ceiling 250 events/s                                                                                                                         | **P1** | `worker/index.js:180-195`; `relay-timescale.js:330-402`; `routes.js:1182`                                                              | 100 chargers × 5 s ≈ 20 ticks/s + enforcement ≈ 40 events/s (ok); 1k chargers ≈ 400/s → **150/s backlog**; 2k ≈ 800/s → 550/s backlog                                              |    8 h | PF-01/PF-02 for queue health     | Week 2 |
| **PF-10** | Oracle expire sweep has no `(status, start_at)` index; every meter tick is a package call + `COMMIT` round trip                                                                                                   | **P2** | `V001:359-373`; `V003:147-175`, `267-292`; `oracle.js:1375-1398`                                                                       | `expireStale` 12.57 ms at 100k, **45.57 ms** at 1M; per-tick commit ~1–3 ms est.; fine at 40/s, not at 1k stations                                                                 |   16 h | Oracle migration `V013`          | Day 30 |
| **PF-11** | `/internal/outbox`, `/health`, `/health/deep` and `/metrics` recompute queue depth/age with full scans                                                                                                            | **P2** | `routes.js:1178-1193`, `1275-1277`, `1334`; `observability.js:19-21`                                                                   | `outboxLag` 10.50 ms at 50k; `/internal/outbox` **23.23 ms** at 50k per 2 s poll; 3 health/metrics callers multiply it                                                             |    4 h | PF-01 counters                   | Day 30 |
| **PF-12** | `recordProfilePush` scans all pushes despite writing `_pushKey`; `activeProfileFor` scans all pushes; `enforcementSample` calls both twice per frame                                                              | **P2** | `store.js:1749-1776`, `1793-1802`; `gateway.js:210-222`                                                                                | 0.049 / 0.132 / **2.80 ms** per pair at 1k / 10k / 100k pushes; at 100k and 40 frames/s ≈ 112 ms/s (11% of a core)                                                                 |    4 h | none                             | Day 30 |
| **PF-13** | `/ai/forecast` builds 240 h of per-station history by scanning every session; `/ai/anomalies` scans all sessions and readings                                                                                     | **P2** | `store.js:1589-1614`; `extended.js:443-451`, `471-480`                                                                                 | `hourlyStationKwh` **91.45 ms** at 100k, **986.75 ms** at 1M sessions per forecast; anomalies scan is O(S+R)                                                                       |    8 h | Timescale hourly rollup          | Day 30 |
| **PF-14** | First `recordTick` for a session seeds `_seqSeen`/`_maxMeter` with two full `readings.filter` scans instead of `readingsFor`                                                                                      | **P2** | `store.js:1072-1081`                                                                                                                   | **6.85 ms** at 250k, **19.13 ms** at 1M on first tick; second tick 0.04 ms                                                                                                         |    1 h | none                             | Day 3  |
| **PF-15** | Auxiliary memory is unbounded: `audit` keeps every row (only the read slices 200), `seqByTx` only deletes on StopTransaction, `global.__ocppTickCursor` keeps the map alive, `_seqSeen` is per-session forever    | **P2** | `store.js:267-277`; `routes.js:997-1001`; `gateway.js:324-325`, `635`                                                                  | Estimated: 200 MB per 1M audit rows; tens of MB for abandoned cursors/Seqs at 1M sessions; grows with uptime                                                                       |    8 h | none                             | Day 30 |
| **PF-16** | CI load/coverage gates are weak or absent: coverage is informational, load is nightly only, k6 checks pending count not age, expected 409s count as failures, and several suites are omitted from the quality job | **P1** | `.github/codecov.yml:9-16`; `.github/workflows/load.yml:3-8`; `test/load/k6-smoke.js:60-62`; `.github/workflows/ci.yml:48-63`, `92-98` | No PR can fail on p95 or coverage; the nightly smoke can pass with a 4,999-event backlog and no age bound; carbon/wallet/control-aes/oracle-adapter are not in the PR quality list |   16 h | CI capacity + k6                 | Week 2 |
| **PF-17** | `/stations/:id/analytics` does `sessions.map(s => [...invoices.values()].find(...))` — O(S×I), and allocates the invoice array per session                                                                        | **P1** | `routes.js:862-867`                                                                                                                    | **59 ms** at 2k, **370.7 ms** at 5k, **870 ms** at 10k, **6,762.6 ms** at 20k (single runs; 400M pairs at 20k)                                                                     |    6 h | none                             | Day 1  |

**Effort rollup:** 163 engineering hours for the 17 findings (≈4 engineer-weeks). The test build-out in §7 adds an estimated 40 h beyond that, mostly for the property/chaos/soak harnesses.

---

## 4. Detailed analysis — P0

### PF-01 · The outbox prune is on the hot emit path, and it is O(N log N)

**What happens.** Every `emitOutbox` appends one event, then checks `if (s.outbox.length > OUTBOX_SOFT_CAP) s.pruneOutbox()`. The soft cap is 20,000; the hard cap is 50,000 (`store.js:75-78`). `pruneOutbox` builds an array of **all acked rows**, sorts it by `event_id`, computes overflow, then walks the entire queue twice to drop rows and compact in place (`store.js:299-325`). Crucially, acked rows younger than the 24 h retention are **not** removed at the soft cap; they stay in the queue, so the depth stays above 20k and the prune runs on **every subsequent emit**. The ack route also calls `pruneOutbox()` on every ack batch (`routes.js:1238`), so the same scan happens on the relay's 2 s cycle.

**Measured.** With a clean queue, `recordTick` runs at **149,226 ticks/s**. Starting at 19,999 acked rows, the first emit crosses the soft cap and the remaining 499 pay the prune, so that 500-tick run averages 183/s. At 20,000 it drops to **106/s**; at 50,000 it is **43/s**. `pruneOutbox` itself is 5.73 ms p50 at 20k and **22.56 ms p50 / 28.65 ms p95** at 50k. The 50k point is 3,470× slower than clean. This is not a micro-optimisation: at 100 chargers × 5 s, the outbox reaches 20k in ~17 minutes (or ~8 minutes when every tick also emits an `ENFORCEMENT_TICK`), and 50k in ~42 minutes (~21 minutes with enforcement). From then on, every meter frame blocks the event loop for 20+ ms.

**Why it matters.** A 22 ms synchronous block per tick delays OCPP heartbeats, StatusNotification, ack deadlines and HTTP reads. At 40 events/s, 22 ms × 40 = 880 ms/s — the process spends ~88% of a core in `pruneOutbox` and cannot keep up. This is a **P0** under the policy: the collapse is measured, and it is reachable at the project's own 100-charger target within the first hour.

**Fix.** Make emit O(1):

1. Remove `pruneOutbox()` from `emitOutbox`; never sort on emit.
2. Maintain an acked FIFO (or a min-heap by `processed_at`) and a running `ackedCount`.
3. Run retention/overflow pruning on a timer (e.g. every 60 s) or when `ackedCount` crosses a high-water mark, not per event.
4. At the hard cap, shed from the acked FIFO head only; log a counter/alert.
5. Keep the durable Oracle prune on the same timer, not on every ack.
6. Add a regression test that emits 100k events with 50k acked rows and asserts p99 emit latency <1 ms and no full-array sort.

**Validation.** `recordTick` with 50k acked should return to ≥5,000/s (target; clean is 149k/s); `pruneOutbox` p99 <50 ms when it does run; `/metrics` exposes prune duration and shed count.

### PF-03 · Gateway frames scan the entire domain

**What happens.** Three gateway paths use full scans:

- **StatusNotification** (`gateway.js:441-446`): when a charger reports `Available`, the gateway scans `[...store.sessions.values()]` for an active session on that connector and `[...store.reservations.values()]` for a BOOKED reservation. Both arrays are materialised on every frame.
- **MeterValues, energy frame** (`gateway.js:562-564`): the first frame for a session computes `MAX(seq_no)` with `store.readings.filter(...).reduce(...)`.
- **MeterValues, power-only frame** (`gateway.js:604-609`): every frame computes the last register with `store.readings.filter(...).reduce(...)`.

**Measured.** Power-only MeterValues: **4.34 ms p50 at 250k readings, 5.87 ms p50 / 7.80 ms p95 at 1M**. StatusNotification: **3.91 ms at 100k sessions+reservations, 40.88 ms p50 / 55.82 ms p95 at 1M**. The MeterValues path is the P0 half because readings grow at the tick rate: 100 chargers × 5 s = 20 frames/s → 1M readings in ~14 hours. At 5.87 ms/frame and 20 frames/s the gateway spends ~117 ms/s (12% of a core) filtering; at 7M readings (~4 days) it is ~41 ms/frame and >80% of a core. That is a measured trajectory to event-loop saturation at the stated target.

**Why it matters.** The gateway is single-process and shares the event loop with HTTP and the store. A 40 ms StatusNotification is a 40 ms stall for every other socket; a 5.9 ms filter per MeterValues is a tax that grows linearly with uptime. The scans are avoidable with indexes the store already has or can maintain in O(1).

**Fix.**

1. Use `store.readingsFor(sid)` (already O(1) after the first index build, `store.js:402-416`) for both `MAX(seq_no)` and last-register lookups. Maintain `_maxSeq` per session alongside `_maxMeter`.
2. Maintain `activeSessionByConnector: Map<connector_ref, session_id>` and `bookedReservationByConnector: Map<connector_ref, reservation_id>`; update them in `startSession`, `transition`, `createReservation`, `cancelReservation`, `expireStale`. StatusNotification then does two map lookups.
3. Keep the maps in sync during hydration and add an invariant test (map value matches a full scan after random operations).
4. For power-only frames, use the session's last reading from `readingsFor` rather than filtering.

**Validation.** MeterValues p95 <2 ms at 1M readings; StatusNotification p95 <2 ms at 1M sessions; a 100-charger, 1-hour soak shows no frame >10 ms and no heartbeat timeout.

---

## 5. Detailed analysis — P1

### PF-02 · Sink-down outbox is unbounded by design

**What happens.** The comment at `store.js:294-305` is explicit: acked events age out after 24 h; **unacked events are never dropped** because the relay's at-least-once guarantee depends on them. That is correct for durability, but the only durable store is Oracle's `outbox_event` table, and the in-process queue is the relay's source. If Timescale is down for hours, `pending` grows at the emit rate. The soft/hard caps do not help: `shed` is built from `acked` only (`store.js:305-307`), so a queue of unacked rows can exceed the hard cap indefinitely. Worse, once over the soft cap, `emitOutbox` calls `pruneOutbox` on every emit even when there are zero acked rows; the filter/sort is empty, but the two queue walks are still O(depth) (1.46 ms p50 at 50k, 2.10 ms p95).

**Measured/estimated.** At 40 events/s (100 chargers with an active profile), a 24 h outage accumulates **~3.46M events**. At an estimated 400 B/event (event object + strings + Map key), that is **~1.4 GB/day**, plus V8 overhead. A multi-day outage will OOM the API, and the relay then has to drain a queue that no longer fits in memory. `emitOutbox` at 50k unacked is 1.46 ms p50; at 500k it is estimated ~15 ms, i.e. another event-loop cliff.

**Fix.** Choose an explicit overload policy and make it visible:

- **Preferred:** keep the durable Oracle outbox as the source of truth and bound the in-memory queue. When `pending > OUTBOX_MAX_PENDING`, stop acknowledging/accepting new ticks with a defined backpressure response (503/`Retry-After` for HTTP; OCPP `InternalError` for MeterValues is harsh, so prefer dropping the local cache entry only after the durable insert succeeds).
- **Alternative:** spool unacked events to a local append-only file/SQLite when over the cap, and have the relay read from the spool. This preserves at-least-once without unbounded heap.
- Add `OUTBOX_MAX_PENDING` (default 100k), `outbox_shed_total`, and an alert on `outbox_oldest_age_seconds` (not depth).
- Do not call prune at all when `ackedCount === 0`; the current code still walks the queue.

**Validation.** A 24 h sink-down chaos test at 40 events/s: RSS growth <100 MB, zero unacked events lost, recovery drains exactly once, and the API stays responsive (p95 <300 ms for `/health` and `/stations`).

### PF-04 · Discovery and list endpoints compute the whole domain, then paginate

**What happens.**

- `/stations` (`routes.js:243-264`) starts with all ACTIVE stations, then for each station filters all CPS, and for each CP filters all connectors and calls `store.standards.find` per connector. Only after building every row does it apply `std`/`minKw`/radius and `slice((p-1)*20, p*20)` (`routes.js:288-292`). The cost is O(stations × cps + cps × connectors + connectors × standards).
- `/reservations` (`routes.js:436-443`) returns every row after optional filters; there is no page/cursor.
- `/sessions` (`routes.js:644`) sorts **all** sessions with `localeCompare` before slicing 20. `localeCompare` is expensive for ISO strings; a direct `<`/`>` comparison is much cheaper.
- `/invoices` (`routes.js:679-694`) returns every invoice, unpaginated.

**Measured.** `/stations` p50: **15.98 ms** at 100 stations/2k connectors, **125.72 ms** at 500/10k, **1,033.4 ms** at 1k/20k, **3,863.0 ms** at 2k/40k (p95 4,645.5 ms). `/sessions` at 1M: **1,741 ms** (p95 1,807 ms). `/reservations` 36.5 ms and `/invoices` 29.6 ms at 1M for the handler alone; serialising 1M rows adds seconds and hundreds of MB (estimated).

**Why it matters.** NFR-03 is p95 <300 ms. At 1k stations the discovery endpoint is already 3.4× over budget before JSON serialisation. The unpaginated lists are worse: they are an availability risk (memory/bandwidth) even when the handler is fast.

**Fix.**

- Build read indexes at write time: `cpsByStation`, `connectorsByCp`, `standardById`; never filter a full Map per parent.
- Apply filters and pagination **before** materialising connectors where possible; for discovery, page stations first, then hydrate only the page's connectors.
- Replace `localeCompare` with `a.started_at < b.started_at` (and use epoch millis in the store).
- Add keyset pagination to `/reservations` and `/invoices` (same shape as `/sessions`), cap `limit` at 100, and add a date/status filter default.
- Add `Cache-Control: private, max-age=5` for discovery if freshness allows; do not add a cache to hide the O(N) build.

**Validation.** `/stations` p95 <300 ms at 1k/20k and <800 ms at 2k/40k; `/sessions` p95 <300 ms at 1M; `/reservations` and `/invoices` responses <100 rows by default; no endpoint returns >1 MB without an explicit export path.

### PF-05 · Live/active session reads ignore the existing index

**What happens.** `/sessions/:id/live` does `store.readings.filter(x => x.session_id === s.session_id)` (`routes.js:545`) even though `store.readingsFor(sid)` already maintains a per-session index (`store.js:402-416`). `/sessions/active/:ref` scans all sessions with `[...store.sessions.values()].find(...)` (`routes.js:514-516`).

**Measured.** Live at 1M readings: **9.41 ms p50 / 12.89 ms p95**. `readingsFor`: **0.3 µs p50 / 0.4 µs p95** — roughly **31,000×** faster at p50. Active-session miss at 1M sessions: **22.35 ms**; hit 6.46 ms.

**Fix.** Use `readingsFor(sid)` and maintain `activeSessionByConnector` (shared with PF-03). Two-line changes in the routes, plus the map lifecycle in the store. This is the cheapest high-value fix in the audit (2 h).

**Validation.** Live p95 <5 ms at 1M readings; active lookup p95 <1 ms at 1M sessions; a test that drops the index and asserts the route still uses `readingsFor` (spy or instrumentation).

### PF-06 · Hydration is unbounded, duplicated and on the boot path

**What happens.** `hydrate` selects **all** `meter_reading` rows and pushes each into `local.readings`, then builds a second `local.ticks` projection with the same timestamp/energy/power, and adds every `seq_no` to a per-session `Set` (`oracle.js:342-382`). It also hydrates all `outbox_event` rows (`oracle.js:530-556`). `server.listen` is wrapped so it waits for `_oracleReady` before binding (`server.js:156-162`); a large hydration therefore delays readiness, not just the first request. There is no Oracle retention policy for `meter_reading`/`charging_session`.

**Measured.** 200k readings cost **60.37 MB** of heap in the harness, **317 B/reading** including both projections and `_seqSeen`; 10M rows project to **2.95 GiB (~3 GB)**. At 100 chargers × 5 s, 1M readings arrive in ~14 hours and 10M in ~6 days. Boot time is not measured end-to-end, but the adapter loops over every row and creates three objects per row; it will grow linearly (estimated).

**Why it matters.** Memory is the hard ceiling on a single VM. A 3 GB cache plus V8 overhead plus the outbox plus HTTP buffers will exceed a small production box; the process also has no way to evict old sessions because the store assumes the Maps are complete. The duplicate `ticks` projection is pure waste: it can be a view over `readings` or a single object with both shapes.

**Fix.**

1. **Bound hydration by a product decision:** active sessions + last N days of readings (e.g. 30 days), with lazy per-session loads for older detail. Document the retention semantics and expose `hydrated_through`.
2. Drop the duplicate `ticks` array; make telemetry fallback read `readings` (or store one canonical row and project on read).
3. Replace `Set<seq_no>` per session with a compact interval/bitmap, or rely on the DB's `(session_id, seq_no)` PK and keep only `maxSeq` in memory.
4. Start the HTTP server with a readiness gate (`/health` 503 until hydration completes) so liveness probes do not kill a hydrating process; do not make the port unavailable for minutes.
5. Add an Oracle retention/archival job for `meter_reading` and completed sessions, aligned with the Timescale 90-day policy.

**Validation.** 1M rows: hydrate <2 s and <400 MB; 10M rows: <30 s and <1.5 GB; `/health` reports `hydrating` with progress; boot does not block the event loop for >50 ms slices.

### PF-07 · Carbon summary sorts all sessions; station detail pays it on every request

**What happens.** `summarize` materialises all sessions, filters by state/window/station, **sorts by end time**, then slices to the limit (`carbon/intensity.js:488-499`). The sort is the dominant cost at 1M rows; the limit is applied after it. `stationPayload` calls `summarize` for the station card (`carbon-routes.js:43`), so a station detail page pays this on every load.

**Measured.** 100k in-window sessions: **934 ms**; 1M: **5,172 ms** (synthetic upper bound — every session matches the window). At 1k stations × 10 sessions/day × 30 days ≈ 300k rows, a linear projection from the measured 100k run is ~2.8 s, a clear NFR-03 breach for a card that looks like a simple read.

**Fix.** Add a `carbon_daily` rollup keyed `(station_id, day, region)` with energy/carbon/baseline/sessions, updated on session close (or by a 5-minute job). `summarize` reads the rollup for day-granular windows and falls back to raw only for ad-hoc sub-day windows. Apply `limit` before sorting by using a top-K heap (or SQL `ORDER BY ... LIMIT`); never sort all rows just to take 2,000. For station detail, cache the card for 30–60 s.

**Validation.** `summarize` p95 <300 ms at 300k rows and <1 s at 1M; station card p95 <300 ms at 1k stations; receipt totals match the raw path within 0.1%.

### PF-08 · Timescale caggs are built but unused; the read pool is four connections

**What happens.** `loadCurve` always queries raw `meter_tick` (`timescale.js:61`) and `heatmap` does the same (`:87`). The repo has `tick_1m`, `tick_1h` and enriched views, and `docs/perf.md` measured a **56×** win for `tick_1h` at 1.2M rows. The API's only reference to the caggs is a comment (`timescale.js:10`). The read pool is `max: 4` (`timescale.js:33`) with a 2.5 s fail-fast; every telemetry/AI read shares it.

**Measured.** At 14,231 ticks, `loadCurve` is 17.2 ms fleet / 4.8 ms station (warm) and 304 ms cold. That is fine today. The repo's own 1.2M-row receipt is the scale evidence: raw 24 h **41.6 ms**, `tick_1h` **0.74 ms**. At 10M ticks and a 30-day window, raw decompression is estimated at seconds, and four connections will queue under 50 VUs.

**Fix.**

- Route `bucket=1h` to `tick_1h`, `bucket=1m/5m` to `tick_1m` when the range is older than the raw retention threshold; keep raw for short real-time windows.
- Add `statement_timeout` (e.g. 5 s) and a query tag so slow reads are visible.
- Increase the read pool to 8–12, or split telemetry reads from AI reads; keep the 2.5 s fail-fast so a degraded DB does not hang the API.
- Add an `EXPLAIN` test that asserts the cagg is used for a 30-day 1h query; fail if the plan hits raw `meter_tick`.
- Add a 15 s cache for the fleet load curve if the dashboard polls faster than that.

**Validation.** 30-day 1h load curve p95 <300 ms at 10M ticks; pool wait p95 <5 ms at 50 VUs; no sequential scan on `meter_tick` for dashboard queries.

### PF-09 · The relay's throughput ceiling is 250 events/s

**What happens.** The worker loop calls `relayOnce()` once, then sleeps 2 s (`worker/index.js:180-195`). `relayOnce` fetches at most 500 events (`/internal/outbox` default limit 500, `routes.js:1182`), writes one batch, acks, and returns. There is no “drain until empty” loop. The ceiling is 500 / 2 s = **250 events/s**, regardless of how fast Timescale is.

**Measured/estimated.** At 100 chargers × 5 s, 20 ticks/s plus enforcement ticks ≈ **40 events/s**, so the relay has ~6× headroom. At 1k chargers it is ~400 events/s → **150 events/s backlog**, and `outbox_oldest_age_s` grows without bound. At 2k it is ~800/s → 550/s backlog. The existing relay tests prove correctness, not throughput.

**Fix.** Drain in a bounded loop: fetch → write → ack → immediately fetch again, up to N batches or until `pending === 0`; sleep 250 ms when caught up, 0 when behind. Raise the batch to 1,000. Keep ack-after-commit and the poison/quarantine path unchanged. Add `relay_batches_total`, `relay_events_total`, `relay_lag_seconds` metrics and a test that feeds 10k events and asserts drain time <10 s.

**Validation.** Sustained drain ≥1,000 events/s; `outbox_oldest_age_s` p95 <5 s at 400 events/s; no duplicate rows after a mid-drain kill (existing idempotency tests extended).

### PF-16 · CI cannot fail on the regressions this audit found

**What happens.**

- Coverage is **informational** for both project and patch (`.github/codecov.yml:9-16`) and the upload uses `fail_ci_if_error: false` (`.github/workflows/ci.yml:92-98`).
- Load/soak is scheduled nightly only and is not required for a PR (`.github/workflows/load.yml:3-8`).
- The k6 teardown checks `x.json('outbox_lag') < 5000` (`test/load/k6-smoke.js:62`). `outbox_lag` is the **pending count**, not seconds; a 4,999-event backlog passes the “lag < 5s” label. The age signal is `outbox_oldest_age_s` and is never asserted.
- The smoke scenario picks the first AVAILABLE connector (`k6-smoke.js:41`) and reserves it; it rarely exercises contention, and `http_req_failed` counts expected **409** responses as failures under k6's default callback, so a contention run can fail for the wrong reason.
- The PR `quality` job invokes a hand-picked list (`ci.yml:48-63`) and omits `carbon.js`, `wallet.js`, `control-aes.js` and `oracle-adapter.js` (the root `npm test` includes them, but the quality job does not).

**Why it matters.** Every finding above could regress without a red build. The repo's “receipts, not claims” culture is strong in docs but not enforced by the pipeline for performance or coverage.

**Fix.**

1. Add a **1-minute PR load smoke** (10 VUs) with thresholds; keep the 10-minute/soak nightly.
2. Fix the k6 assertion to `outbox_oldest_age_s < 30` (and remove the misleading `outbox_lag` name); use `http.setResponseCallback(http.expectedStatuses(201, 409))` for the reserve call.
3. Add a **contention scenario** that targets one connector with 50 VUs and asserts exactly one 201 and the rest 409, not a generic error-rate threshold.
4. Make patch coverage a **diff gate** (e.g. 80% on changed lines in `apps/api/src/db`, `ocpp`, `routes`) while keeping project coverage informational; wire `fail_ci_if_error: true` for the upload or use a local `c8 check-coverage` step.
5. Add the omitted suites to `quality` (or replace the hand-picked list with `npm test` once the DB-backed suites are separated).
6. Add a microbench regression job (PF-01/PF-03/PF-17 harnesses) that fails if p50 regresses >20% from a committed baseline.

**Validation.** A deliberate 30% regression in `pruneOutbox` or `/stations` turns CI red; a PR that drops patch coverage below 80% on a critical directory is blocked; the nightly load job publishes p95, error rate and outbox age as artifacts.

### PF-17 · Station analytics is O(sessions × invoices)

**What happens.** For each completed session on the station, the route builds a **new array of every invoice** and calls `.find` on it (`routes.js:865-867`). With `S` sessions and `I` invoices, that is O(S×I) comparisons and S array allocations. At 20k sessions and 20k invoices, 400M pairs.

**Measured.** Single runs: **59 ms** at 2k, **370.7 ms** at 5k, **870 ms** at 10k, **6,762.6 ms** at 20k. The trend is superlinear (the 10k→20k step is ~7.8×, though single runs are GC-sensitive), and the code performs 400M `find` comparisons at 20k. At 1k stations × 20 sessions/day, 20k sessions accumulate in **one day**, so a station analytics page can take 6.8 s after a day of operation.

**Fix.** Build `invoiceBySession` once per request (O(I)), or maintain it in the store; then map sessions in O(S). Filter sessions by station via `cpsByStation`/`connectorRef` index (PF-04), not a full scan. Add a date window and pagination to the analytics response. If the query is expected to be frequent, precompute station daily aggregates.

**Validation.** `/stations/:id/analytics` p95 <300 ms at 20k sessions; a test at 20k asserts no `[...invoices.values()]` inside the session loop (or a timing bound).

---

## 6. Detailed analysis — P2

### PF-10 · Oracle expire index and per-tick commit

`expire_stale` scans reservations by `status = 'BOOKED' AND start_at < cutoff` (`V003:147-175`). The schema has `ix_res_user_status(user_id, status)` and `ix_res_conn_start(connector_ref, start_at)`, but no `(status, start_at)` (`V001:359-373`). At 34 rows the CBO chooses `INDEX SKIP SCAN IX_RES_USER_STATUS` and filters `start_at`; at scale that is a scan of BOOKED rows, not a range seek. Measured sweep: 12.57 ms at 100k, **45.57 ms at 1M**. Add `CREATE INDEX ix_res_status_start ON reservation(status, start_at)` and a regression test that asserts the plan uses it. The per-tick path calls `charge_session_pkg.record_meter_tick` and then `conn.commit()` for every frame (`oracle.js:1375-1398`). At 40 events/s this is fine; at 1k stations (~400 events/s with enforcement) it is 400 commits/s and 8 pool connections, sensitive to storage fsync. Consider group commit (50–100 ms) with the OCPP ack sent only after the group commits, or a batched writer with a bounded queue. 16 h, P2.

### PF-11 · Health/metrics recompute the queue shape

`/health`, `/health/deep`, `/metrics` and `/internal/outbox` all call `outboxLag()` or filter the outbox (`routes.js:1178-1193`, `1275-1277`, `1334`; `observability.js:19-21`). Measured `outboxLag` is 3.68 ms at 20k and **10.50 ms at 50k**; `/internal/outbox` is 8.75/23.23 ms at 20k/50k and does two full filters (one for `pending`, one inside `outboxLag`). At a 15 s Prometheus scrape and a 2 s relay poll, this is ~1% CPU at 50k — moderate, but it becomes 10% at 500k and it is trivial to make O(1). Maintain `pending`, `oldestCreatedAt`, `ackedCount`, `deadLettersOpen` in `emitOutbox`/ack/prune; back them with a min-heap or FIFO for oldest. 4 h, P2.

### PF-12 · Profile-push scans on every enforcement sample

`recordProfilePush` writes `_pushKey` but then dedupes with a full `[...profilePushes.values()].find` (`store.js:1749-1768`). `activeProfileFor` scans all pushes for the CP (`:1793-1802`), and `enforcementSample` calls `scheduledKwAt` (which calls `activeProfileFor`) and then `activeProfileFor` again (`gateway.js:210-222`). Measured pair: 0.049 ms at 1k, 0.132 ms at 10k, **2.80 ms at 100k pushes**. At 100k pushes and 40 frames/s that is ~112 ms/s (11% of a core); at 1M pushes it is >100%. Use `_pushKey` for O(1) dedupe, maintain `latestPushByCp`, and pass the resolved push into `scheduledKwAt` so each frame resolves once. 4 h, P2.

### PF-13 · Forecast/anomaly input assembly is O(all sessions)

`hourlyStationKwh` loops every session for the station (`store.js:1599`), even though it only needs a 240 h window. Measured: **91.45 ms** at 100k sessions, **986.75 ms** at 1M per `/ai/forecast`. `/ai/anomalies` materialises all sessions for the station and filters all readings (`extended.js:471-480`). The AI calls themselves are async with a 3 s `AbortSignal.timeout` and degrade to 503 (`extended.js:377-390`); they are not event-loop blocking, but they hold an HTTP socket for up to 3 s. Add a per-station hourly kWh rollup (or read `tick_1h`), filter by window before iterating, and add a small LRU for the 240 h history. Add a concurrency cap/circuit breaker around the sidecar so a slow AI process cannot exhaust sockets. 8 h, P2.

### PF-14 · First-tick scan

`recordTick` seeds `_seqSeen` with `s.readings.filter(...)` and `_maxMeter` with a second filter (`store.js:1072-1081`). Measured: **6.85 ms** at 250k readings, **19.13 ms** at 1M for the first tick; the second tick is 0.04 ms. This happens once per active session per process (and for every active session after a restart), so it is a restart-latency/event-loop issue, not steady-state throughput. Use `readingsFor(sid)` once, derive both the seq set and the max meter from that array, or hydrate both maps. 1 h, P2.

### PF-15 · Auxiliary memory retention

`audit` grows without bound (`store.js:267-277`); the route reads only the last 200 (`routes.js:997-1001`), but every login success/failure and every transition stays in memory. `seqByTx` is deleted only on `StopTransaction` (`gateway.js:635`), so an abandoned socket/session leaves an entry; `global.__ocppTickCursor` keeps the map reachable process-wide (`gateway.js:324-325`); `_seqSeen` is per-session forever. At 1M audit rows, ~200 MB estimated; at 1M abandoned sessions, tens of MB for cursors plus the `_seqSeen` Sets. Cap `audit` at a ring (e.g. 10k) while Oracle remains the durable audit log; delete `seqByTx` on socket close/timeout; remove the global test seam in production (or guard it behind `NODE_ENV=test`); clear `_seqSeen` for sessions past retention. 8 h, P2.

---

## 7. Test strategy

### 7.1 What exists and what it proves

The repo has unusually good **correctness** coverage for a project this size: 44 API tests, 19 security tests, 8 rate-limit tests, 14 relay tests, 14 wallet tests, 8 carbon tests, 6 control-AES tests, 10 AI contract tests, 2 race tests, SQL invariants, OpenAPI drift and an authenticated UI E2E. The gaps are **scale, properties and failure modes**, not happy-path correctness.

| Finding | Missing test today                                                                           |
| ------- | -------------------------------------------------------------------------------------------- |
| PF-01   | No test emits above the 20k soft cap and asserts emit latency/complexity.                    |
| PF-02   | No multi-hour sink-down test with a memory bound and zero-loss assertion.                    |
| PF-03   | No frame-level benchmark at 100k/1M sessions; no assertion that Status/MeterValues are O(1). |
| PF-04   | No 1k-station discovery fixture; no unpaginated-list guard.                                  |
| PF-05   | No test that live/active reads use `readingsFor`/the connector index.                        |
| PF-06   | No boot-time or hydration-memory budget; no 10M-row fixture.                                 |
| PF-07   | No carbon summary at 100k/1M; no station-card latency test.                                  |
| PF-08   | No cagg-vs-raw plan assertion; load is nightly only.                                         |
| PF-09   | No drain-rate test above 250 events/s.                                                       |
| PF-10   | No plan assertion for `expire_stale`; no commit-latency budget.                              |
| PF-11   | No scale test for `/health`, `/metrics`, `/internal/outbox`.                                 |
| PF-12   | No 100k-push enforcement benchmark.                                                          |
| PF-13   | No forecast input benchmark at 1M sessions.                                                  |
| PF-14   | No restart-with-active-sessions tick-latency test.                                           |
| PF-15   | No heap soak over 24 h; no abandoned-socket test.                                            |
| PF-16   | Coverage/load are not PR gates; k6 assertion is vacuous.                                     |
| PF-17   | No station analytics at 20k sessions.                                                        |

### 7.2 Test layers, commands and acceptance thresholds

| Layer             | Suites / command                                                                                                                                                                     | Cadence                        | Acceptance threshold                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**          | `npm run test -w apps/api`; `node apps/worker/test/relay.test.js`; `node apps/api/test/{security,ratelimit,carbon,wallet,control,control-aes,ai}.js`                                 | Every PR                       | 100% pass; <60 s total; no unhandled rejection                                                                                                                            |
| **Integration**   | `npm run test:race -w apps/api`; `ORACLE_HOST=localhost node apps/api/test/oracle-adapter.js`; `node test/sql/run-invariants.js`; `node scripts/check-openapi.js`                    | Every PR + nightly DB job      | 0 failures; 0 missing OpenAPI paths; hot SQL plans contain no `TABLE ACCESS FULL`                                                                                         |
| **Property/fuzz** | **Add** `test/property/*.test.js` with `fast-check`; command `npm run test:property`                                                                                                 | PR 10k cases; nightly 1M       | 0 counterexamples; replay/idempotency/overlap/monotonicity invariants hold; malformed OCPP frames never crash                                                             |
| **Load**          | `k6 run test/load/k6-smoke.js`; `k6 run bench/k6-discovery.js`; **add** `test/load/k6-ingest.js`                                                                                     | PR 1-min smoke; nightly 10-min | API p95 <300 ms, p99 <800 ms; errors <1% excluding expected 409; `outbox_oldest_age_s` p95 <5 s, max <30 s; 0 dropped ticks                                               |
| **Soak**          | **Add** `node test/load/soak-fleet.js --chargers 100 --interval 5000 --duration 24h`                                                                                                 | Weekly / pre-release           | RSS growth <5% after warm-up; p95 stable within 20%; outbox depth <soft cap; heap <1.5 GB; no timer/map growth                                                            |
| **Chaos**         | Existing relay chaos tests + **add** `test/chaos/{timescale-down,oracle-down,ack-partition,clock-skew}.test.js`; use `docker pause volthub-timescale` / `docker stop volthub-oracle` | Nightly                        | 0 lost events (emitted = distinct inserted after recovery); 0 duplicates; queue drains to 0; API recovers without restart                                                 |
| **Security**      | `npm run test:security`; existing `xlayer`, `ocpp-remote`, `gateway-close`; **add** route×role×scope authz matrix; `npm audit`                                                       | Every PR                       | 0 high/critical CVEs; 100% routes covered by 401/403/IDOR matrix; oversized/bad-auth OCPP frames rejected                                                                 |
| **A11y**          | **Add** `@axe-core/playwright` to `apps/web/test/e2e.mjs`; command `npm run test:a11y -w apps/web`                                                                                   | Every PR (web)                 | 0 serious/critical axe violations on login, dashboard, station, live session, admin; keyboard-only flow; focus visible; contrast ≥4.5:1; `prefers-reduced-motion` honored |

### 7.3 Property tests to add (concrete)

1. **Reservation overlap.** Generate two random intervals on the same connector; after `createReservation`, assert no two `BOOKED`/`CONVERTED` rows overlap; run 100k cases and compare the local store with Oracle for a 1k-case subset.
2. **Meter idempotency/monotonicity.** Generate a random permutation/replay of `(seq, kwh)`; assert the final set of readings is identical, duplicates are `{deduped:true}`, regressions are `METER_REGRESSION`, and non-finite inputs are `TICK_REJECTED`.
3. **Outbox prune safety.** Generate a mix of acked/unacked events and a clock; assert `pruneOutbox` never removes an unacked event, never exceeds the hard cap of acked retention, and preserves order for survivors.
4. **OCPP frame parser.** Fuzz JSON shapes and `sampledValue` arrays; assert no uncaught exception, every frame gets exactly one CALLRESULT/CALLERROR, and invalid values are rejected before a sequence number is spent.
5. **Carbon receipt conservation.** Generate sessions with random overlap windows; assert the sum of hourly allocations equals session energy within 1e-6 and the receipt is deterministic for the same inputs.
6. **Status map invariant.** After random create/cancel/start/stop/expire operations, assert `activeSessionByConnector` and `bookedReservationByConnector` match a full scan (the property that makes PF-03 safe).

### 7.4 Load profiles and thresholds

| Scenario               | Profile                                                                   | Threshold                                         |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| Discovery              | 50 VUs, 10 min, `GET /stations?lat&lng&radius`                            | p95 <300 ms, p99 <800 ms, errors <1%              |
| Reservation contention | 50 VUs, same connector/window, 2 min                                      | exactly one 201; all others 409; p95 <500 ms      |
| Live session           | 20 VUs polling `/sessions/:id/live` every 1 s, 1M readings                | p95 <50 ms, p99 <150 ms                           |
| MeterValues ingest     | 100 chargers × 5 s × 60 min; measure gateway frame latency and outbox age | frame p95 <10 ms; outbox age p95 <5 s; 0 drops    |
| Station analytics      | 20k sessions/20k invoices, 10 VUs                                         | p95 <300 ms                                       |
| Carbon summary         | 300k sessions, 10 VUs                                                     | p95 <300 ms                                       |
| Worker drain           | 10k preloaded events, sink healthy                                        | drain <10 s (≥1,000/s)                            |
| Sink down              | 40 events/s for 24 h, Timescale paused                                    | RSS growth <100 MB; 0 loss; recovery exactly once |

### 7.5 A11y test details

The existing E2E is Playwright/chromium and already has authenticated flows (`apps/web/test/e2e.mjs`). Add `@axe-core/playwright` and run `AxeBuilder` after each page is hydrated (wait for the React props key, as the current login helper does). Fail on `serious`/`critical`; publish the violation list as an artifact. Add a keyboard-only path: Tab to the station selector, change station, open a session, open/close the mobile drawer, and assert focus returns to the trigger. This closes the a11y gap the companion product audit found without changing application code.

---

## 8. Remediation plan

### 8.1 0–3 days — stop the collapse (≈31 h)

| Order | Finding       | Work                                                                |  Hours |
| ----: | ------------- | ------------------------------------------------------------------- | -----: |
|     1 | PF-01         | Remove prune from emit; acked FIFO + timed prune; regression at 50k |      6 |
|     2 | PF-03         | `readingsFor` + `_maxSeq`; connector session/reservation maps       |      8 |
|     3 | PF-05         | Live/active routes use the indexes                                  |      2 |
|     4 | PF-14         | First-tick seed via `readingsFor`                                   |      1 |
|     5 | PF-17         | `invoiceBySession` map + station index                              |      6 |
|     6 | PF-16 (quick) | Fix k6 age assertion/expected 409s; add omitted suites to quality   |      4 |
|     7 | PF-11         | O(1) queue counters for health/metrics (optional in this window)    |      4 |
|       |               | **Total**                                                           | **31** |

Exit criteria: 50k-acked `recordTick` ≥5,000/s; MeterValues p95 <2 ms at 1M; `/stations/:id/analytics` p95 <300 ms at 20k; CI fails on the k6 age threshold.

### 8.2 2 weeks — meet NFR-03 at 1k stations (≈84 h)

| Order | Finding | Work                                                   |  Hours |
| ----: | ------- | ------------------------------------------------------ | -----: |
|     1 | PF-02   | Bounded outbox + backpressure/spool + alert            |     12 |
|     2 | PF-04   | Discovery indexes + keyset pagination + epoch sort     |     16 |
|     3 | PF-06   | Bounded hydration + drop duplicate `ticks` + retention |     24 |
|     4 | PF-07   | Carbon daily rollup + top-K + station cache            |     12 |
|     5 | PF-08   | Cagg routing + pool/timeout + plan test                |     12 |
|     6 | PF-09   | Drain loop + 1,000 batch + metrics                     |      8 |
|       |         | **Total**                                              | **84** |

Exit criteria: `/stations` p95 <300 ms at 1k/20k; `/sessions` p95 <300 ms at 1M; carbon p95 <300 ms at 300k; relay drains 400 events/s with outbox age <5 s; 24 h sink-down loses zero events and stays under +100 MB.

### 8.3 30 days — remove the long tail and make it stay fixed (≈48 h)

| Finding      | Work                                                        |  Hours |
| ------------ | ----------------------------------------------------------- | -----: |
| PF-10        | Oracle `(status,start_at)` index + group-commit evaluation  |     16 |
| PF-12        | `_pushKey` + `latestPushByCp` + single resolve per frame    |      4 |
| PF-13        | Hourly station rollup + AI input window + concurrency cap   |      8 |
| PF-15        | Audit ring + cursor cleanup + remove global seam            |      8 |
| PF-16 (full) | PR load smoke + patch coverage gate + microbench regression |     12 |
| **Total**    |                                                             | **48** |

Plus the test build-out (§7): property harness ~12 h, chaos harness ~12 h, soak harness ~8 h, a11y harness ~8 h — **+40 h**, bringing the whole programme to ~203 h (≈5 engineer-weeks).

### 8.4 Dependency notes

- **PF-01 before PF-02/PF-09:** a bounded/draining relay is pointless while every emit pays an O(N log N) prune. Land PF-01 first.
- **PF-03 and PF-05 share the connector index:** build `activeSessionByConnector` once and use it in both the gateway and the REST route.
- **PF-04 and PF-17 share station/CP/connector indexes:** do them in the same change to avoid two migrations through the same code.
- **PF-06 needs a product retention decision:** “how much history must be in memory?” is not an engineering choice; document it in an ADR before changing hydration.
- **PF-08 depends on the cagg refresh policy:** confirm `tick_1h` is materialised through the query window before routing dashboards to it; otherwise the first query pays the refresh.
- **PF-16 needs CI minutes:** a 1-minute PR load smoke and a nightly soak are cheap; a 10-minute PR soak is not. Keep the split explicit.

---

## 9. Not a bottleneck (checked, not reported)

These were suspected and cleared; they should not be “fixed” again.

| Item                                    | Evidence                                                  | Verdict                                                                    |
| --------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| `readingsFor` per-session index         | `store.js:402-416`; 0.3 µs p50                            | Fast; use it more (PF-03/PF-05), do not replace it.                        |
| Oracle `MAX(meter_kwh)` monotonic check | `EXPLAIN`: PK range scan, not full table                  | Not the per-tick bottleneck.                                               |
| Worker Timescale pool churn             | `relay-timescale.js:33-48` shares one pool per process    | Already fixed; do not report pool churn.                                   |
| Store mutex cleanup                     | `store.js:42-64` deletes idle mutexes                     | Already fixed; no leak found.                                              |
| Argon2 on the event loop                | `store.js:419` async/thread-pool path                     | Not blocking; login/register are off-loop.                                 |
| OCPP ack sweeper timer                  | `gateway.js:311-322` `unref` + `clearInterval` on close   | No timer leak.                                                             |
| Rate-limit map growth                   | `security.js:121-125` sweeps every 60 s                   | Bounded; no leak found.                                                    |
| `/metrics` p95 computation              | `observability.js:14-18` sorts 500 samples                | <0.1 ms; trivial.                                                          |
| OCPP JSON parse                         | Per-frame `JSON.parse` is required by the protocol        | Not dominant vs the full scans; no action.                                 |
| Oracle durable outbox prune index       | `ix_outbox_cursor(processed_at, created_at)` (`V001:366`) | The durable delete is indexed; the in-memory prune is the problem (PF-01). |
| Timescale raw query plan at small scale | `ix_tick_conn_ts` nested loop, 17.2 ms at 14k rows        | Fine today; the issue is bypassing caggs at scale (PF-08).                 |

---

## 10. Appendix

### A. Reproducible harnesses (read-only, outside the repo)

All harnesses are under `C:\Users\Devesh tiwari\AppData\Local\Temp\opencode\` and write nothing into the repository:

| File                    | What it measures                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit-bench.js`        | 50k/250k/1M live scan, prune, outbox lag, discovery, enforcement pair, StatusNotification, hourly kWh, hydration memory, expire/first tick (first pass) |
| `audit-bench2.js`       | Isolated first tick, expire sweep, emit past cap, `/internal/outbox`, MeterValues, `readingsFor`                                                        |
| `audit-bench3.js`       | `recordTick` throughput at 0 / 19,999 / 20,000 / 50,000 acked outbox rows                                                                               |
| `audit-bench4.js`       | Carbon `summarize` at 100k/1M                                                                                                                           |
| `audit-bench5.js`       | Discovery and list endpoints at 1k/2k stations, 1M sessions/reservations/invoices                                                                       |
| `audit-bench6.js`       | Exact `/stations/:id/analytics` invoice-join pattern at 2k/5k/10k/20k                                                                                   |
| `audit-bench*.out.json` | Raw results for the runs above                                                                                                                          |

Run one with, for example:

```powershell
node "C:\Users\Devesh tiwari\AppData\Local\Temp\opencode\audit-bench3.js" "C:\Users\Devesh tiwari\AppData\Local\Temp\opencode\VoltHub-CSMS-fresh"
```

### B. Commands run for the baseline

```powershell
node apps/api/test/run.js
node apps/api/test/ratelimit.js
node apps/api/test/security.js
node apps/api/test/race.js
node apps/worker/test/relay.test.js
node apps/api/test/carbon.js
node apps/api/test/wallet.js
node apps/api/test/control-aes.js
node apps/api/test/ai.js
node scripts/check-openapi.js
docker exec volthub-timescale psql -U volthub -d volthub -c "EXPLAIN (ANALYZE, BUFFERS) ..."
docker exec volthub-oracle sqlplus -S volthub/... <<< "EXPLAIN PLAN ...; DBMS_XPLAN.DISPLAY"
```

### C. Limitations

1. **No k6/soak run.** k6 is not installed on this machine (`npm run test:load` skips when absent), so the NFR-03/04 end-to-end thresholds are not re-measured here. The microbench and DB numbers isolate the code paths; they do not replace a full-stack load run.
2. **Small databases.** Oracle had 1,260 readings and 34 reservations; Timescale had 14,231 ticks. Oracle scale impacts (PF-10) are plan/schema-based, not measured at 1M. Timescale scale impacts use the repo's own 1.2M-row receipt (`docs/perf.md`) plus the measured 14k-row plan.
3. **Synthetic carbon.** The 1M carbon number assumes every session is inside the window; real windows are smaller. It is an upper bound, labelled as such.
4. **Node/OS mismatch.** Node 24 on Windows vs CI Node 20/22 on Linux. Absolute latencies differ; the algorithmic cliffs (20k prune, 1M scan, 20k quadratic join) are structural.
5. **Single process.** The store is a single-VM read cache by design; multi-instance behaviour (shared Oracle, multiple API replicas) is out of scope. The outbox/relay already assumes one writer.
6. **Working tree.** The repo was already dirty at `ce9160e` (including uncommitted `carbon` routes and schema files). Results reflect the current tree, not a clean checkout. No user changes were reverted.
7. **A11y.** No automated axe run exists; this report specifies the test but does not claim a measured WCAG result.

### D. Crosswalk to the prior review

`docs/comprehensive-review-2026-10-24.md` already flagged the main structural issues:

| Prior ID                          | This audit                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| B-26 (unbounded hydration/outbox) | PF-02, PF-06 (now measured: 317 B/reading, 2.95 GiB (~3 GB) at 10M; 149k → 43 ticks/s) |
| B-46 (unbounded arrays)           | PF-02, PF-15                                                                           |
| B-47 (hot-path scans)             | PF-03, PF-05, PF-17                                                                    |
| B-50 (outbox O(n))                | PF-01 (now measured: 149k → 43 ticks/s)                                                |
| B-58 (load gates)                 | PF-16 (now concrete: wrong k6 signal, informational coverage, omitted suites)          |

This audit does not claim to rediscover those; it adds reproducible measurements, a severity/effort model, and a test strategy that would have caught each one.

---

**Repository hygiene:** this report is the only file added by this audit under `docs/reviews/`. The pre-existing working-tree changes (including the new `carbon` surface) were left untouched; nothing was staged, committed or reverted.
