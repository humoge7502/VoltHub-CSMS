# Part XIII — DA3 Technology Comparison and Recommendation

> Masterplan sections 23–24. The DA3 brief demands a modern database with a _genuine purpose_, comparative analysis, and justification against functional and non-functional requirements. This file is that analysis. The winner is **TimescaleDB**; the loser analyses are kept because defending rejections is half the marks.

---

## 23. DA3 Technology Comparison

### 23.1 The workload being served (the only fair basis)

From the research (Sections 2.3, 3.5): VoltHub's DA3 extension targets the **telemetry slice** — per-connector meter ticks (kWh, kW, V, A) every 5 seconds in simulation, connector state transitions, and derived analytics (load curves, utilization, fault time [7][9]). Its properties: **append-heavy writes, time-ordered, immutable once written, read as time-window aggregates, shrunk with age**. Oracle keeps the OLTP core; the DA3 question is _which engine serves this slice best_.

### 23.2 Decision criteria and weights

| #   | Criterion                                    | Weight | Why it matters here                      |
| --- | -------------------------------------------- | ------ | ---------------------------------------- |
| C1  | Fit to telemetry workload                    | 20%    | the actual job                           |
| C2  | Query capability for analytics               | 15%    | DA3 requires technology-specific queries |
| C3  | Genuine-need defensibility (not duplication) | 15%    | the brief's explicit bar                 |
| C4  | Integration cost with existing stack         | 10%    | 3-person team                            |
| C5  | Learning value / course continuity           | 10%    | BACSE202 is SQL-centric                  |
| C6  | Operational complexity (local + demo)        | 10%    | must run on laptops                      |
| C7  | Scalability headroom (honest)                | 5%     | talking point, not requirement           |
| C8  | Ecosystem/docs maturity                      | 5%     |                                          |
| C9  | Demo impact                                  | 5%     | live charts sell it                      |
| C10 | Recruiter signal                             | 5%     | real-world usage                         |

### 23.3 The matrix (scores 1–5; weighted total /5)

| Criterion (wt)               | TimescaleDB                                              | InfluxDB 3                                       | Cassandra/ Scylla                           | Neo4j                      | OpenSearch                   | CockroachDB/ Yugabyte        | TiDB/ SingleStore | Vector DBs                |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------- | -------------------------- | ---------------------------- | ---------------------------- | ----------------- | ------------------------- |
| C1 telemetry fit (.20)       | **5** — hypertables built for this [19]                  | 5 — purpose-built TSDB [20]                      | 3 — wide-partition modeling, manual buckets | 1                          | 3 — doc-store w/ date math   | 2                            | 4 — HTAP claims   | 1                         |
| C2 analytics queries (.15)   | **5** — full SQL, window fns, time_bucket, gap-fill [19] | 3 — SQL exists but younger; no joins to metadata | 2 — partition-key confined                  | 3 — Cypher graphy          | 4 — aggregations DSL         | 4 — SQL but OLTP-tuned       | 4                 | 2 — ANN-centric           |
| C3 genuine need (.15)        | **5** — OLTP/OLAP split with industry precedent [7][8]   | 4                                                | 2 — "we'd need write scale" is fiction here | 2 — topology is decorative | 3 — search is real but small | 2 — niche at this scale [27] | 2                 | 1 — no embedding workload |
| C4 integration (.10)         | **5** — Postgres wire protocol, `pg` driver              | 3 — HTTP/Flight clients                          | 2                                           | 3                          | 3                            | 5                            | 3                 | 3                         |
| C5 learning/continuity (.10) | **5** — SQL throughout; contrasts storage engines        | 3 — new query surface                            | 3 — CQL is a lesson in denormalization      | 3                          | 3                            | 4                            | 3                 | 3                         |
| C6 ops complexity (.10)      | **5** — one container, one file DB                       | 4                                                | 1 — JVM cluster, ≥3 nodes to be honest      | 4                          | 2 — JVM + heap tuning        | 3 — 3+ nodes                 | 2 — TiKV cluster  | 3                         |
| C7 scale headroom (.05)      | 4 — proven billions-row hypertables                      | 5                                                | 5                                           | 3                          | 4                            | 5                            | 5                 | 4                         |
| C8 ecosystem (.05)           | **5** — Postgres ecosystem                               | 4                                                | 4                                           | 4                          | 5                            | 4                            | 3                 | 3                         |
| C9 demo impact (.05)         | **5** — live cagg charts, compression stats on screen    | 4                                                | 2                                           | 3                          | 3                            | 2                            | 3                 | 2                         |
| C10 recruiter signal (.05)   | 5 — "time-series DBs" is a hot, honest line              | 5                                                | 4                                           | 4                          | 4                            | 4                            | 3                 | 4                         |
| **Weighted total**           | **4.90**                                                 | 3.95                                             | 2.55                                        | 2.65                       | 3.10                         | 3.15                         | 3.10              | 2.25                      |

Reading notes: InfluxDB 3 is a genuinely strong second — it loses on **analytics SQL maturity and metadata joins** (correlating ticks with tariff bands and stations is our core query) and on **course continuity** (C5) [20][21]. Cassandra scores lowest on "genuine need": its superpowers (linear write scale, multi-DC) are exactly the ones we cannot honestly claim to need [27]. Neo4j's grid-topology story is decorative: our relationships are shallow (station→point→connector) and live happily as FKs. Vector DBs have no defensible workload here — "find similar charging sessions" would be a solution seeking a problem.

## 24. Recommended Modern Database — TimescaleDB

**Decision:** extend VoltHub (DA3) with **TimescaleDB** (PostgreSQL 16 + timescaledb extension) as the telemetry and analytics engine.

**Alternatives:** all eight columns of Section 23.3; additionally "do it all in Oracle" (evaluated below, the strongest counter-candidate) and "ClickHouse" (not on the university list; noted as the industry alternative for larger scales).

**Evaluation:**

1. _Fit:_ hypertables auto-chunk by time (default 7 days; we set 1 day) — inserts hit small, hot, indexed chunks instead of one growing heap; this is the mechanism Oracle Free cannot give us (Partitioning is an Enterprise- Edition option, absent from Free/Express editions) [19][28].
2. _Analytics:_ `time_bucket` + continuous aggregates give incrementally-maintained rollups (1-min, 1-hr) refreshed in the background [19]; Oracle MVs on Free refresh COMPLETE — full recomputation — while caggs materialize only the delta. Same concept, visibly better mechanism: a perfect comparative-analysis exhibit.
3. _Compression:_ native columnar compression on chunk age (10–20x typical [28]) plus retention policy = the data-lifecycle story Oracle lacks at this tier.
4. _Continuity:_ it speaks SQL — DA3's queries remain readable to a Database Systems examiner, and the _comparison_ (heap vs chunking, MV vs cagg, B-tree vs BRIN) becomes teachable rather than a syntax tour.
5. _Evidence of real-world fit:_ Timescale's own CSMS engineering guide describes exactly this architecture for exactly this protocol's data [7]; operators report the same 15–30s-telemetry-plus-billing split [8].

**Recommendation:** commit. Oracle remains the system of record; TimescaleDB receives a _projection_ of operational events via the outbox pipeline (Section 29) and owns all time-window analytics.

**Reason (the one-paragraph viva answer):** "Our charging sessions and billing must be ACID and relationally constrained — Oracle. Our meter ticks are 90%+ of row volume, immutable, time-ordered, and read as aggregates; a row-store OLTP engine is the wrong shape for them, and Oracle Free specifically denies us partitioning and incremental MV refresh. TimescaleDB chunks time, aggregates incrementally, compresses aged chunks, and expires them by policy — with SQL we can defend in a viva. The industry literature describes precisely this split for precisely this domain [7][8][22]. We are not duplicating tables: TimescaleDB holds only what time-series storage is for."

### 24.1 Honest counterarguments (pre-empted, with rebuttals)

| Challenge                                  | Rebuttal                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "It's just Postgres — modern enough?"      | The _extension_ adds a chunked hypertable layer, background workers, and columnar compression — engine-level architecture, not marketing. The university lists it by name. We also compare against vanilla PostgreSQL in the report (one table: raw vs hypertable ingest), which makes the answer concrete. |
| "Your volume is small; need?"              | Honest numbers in hand: ~600k meter rows seeded; we _demonstrate_ a 24h simulation generating ~1.7M ticks and show ingest lag + cagg query times vs the same aggregate on an unpartitioned Oracle/PG table. The claim is workload-shape fit, not big-data theatre.                                          |
| "Why not Kafka+ClickHouse like big CPOs?"  | Out of scope operationally (Section 45) and not on the approved list; the outbox+Timescale design is the _right-sized_ version of the same pattern [6].                                                                                                                                                     |
| "Two databases = two failures?"            | Yes — and we say it: the pipeline degrades gracefully (telemetry lags, billing unaffected; relay catches up idempotently). Availability trade-offs are part of the comparative analysis, not a hidden cost.                                                                                                 |
| "Why not InfluxDB since it's 'more TSDB'?" | 23.3: raw-ingest crown [21] vs our need for SQL analytics over _joined_ metadata; FDAP's youth; continuity (C5). We cite InfluxData's own comparison page for fairness [20].                                                                                                                                |

### 24.2 Academic-requirement mapping (DA3 rubric)

| DA3 requirement             | Where satisfied                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| schema/model design         | Part XIV hypertable + cagg DDL (26)                                                               |
| implementation              | Docker service + relay worker + migrations                                                        |
| sample dataset              | Section 16 volumes; 24h simulation burst                                                          |
| core operations             | insert (ingest), query (caggs), delete (retention), update-free by design (immutability argument) |
| technology-specific queries | time_bucket, gap-fill, LTTB, compression/retention introspection (27)                             |
| comparative analysis        | Section 28 table + measured micro-benchmarks                                                      |
| justification               | this file                                                                                         |
