# Part XIV — DA3 Architecture, Data Model, Pipeline, and Queries

> Masterplan sections 25–29. Everything TimescaleDB: topology, hypertables, continuous aggregates, the outbox pipeline, technology-specific queries, and the honest Oracle comparison with micro-benchmarks.

---

## 25. DA3 Architecture

```
  ORACLE (OLTP, system of record)                    TIMESCALEDB (OLAP)
  +---------------------------+                     +------------------------------+
  | charging_session          |                     | hypertable: meter_tick       |
  | meter_reading (billing)   |   OUTBOX_EVENT      | hypertable: connector_state  |
  | connector (state cols)    |   (METER_TICK,      |   _event                     |
  | audit_log                 |    STATE, SESSION)  | cagg: tick_1m / tick_1h      |
  |      |                    |                     | cagg: state_1m               |
  |      | trigger: after     |                     | policy: compress > 7d        |
  |      | insert on          |                     | policy: drop     > 90d       |
  |      | outbox_event       |                     +---------------+--------------+
  |      v                    |                                     ^
  | [OUTBOX_EVENT rows] ------+---->  apps/worker (relay)  ----------+
  |   processed_at NULL       |         batch SELECT ... FOR UPDATE
  +---------------------------+         SKIP LOCKED LIMIT 500
                                        -> INSERT ... ON CONFLICT DO NOTHING
                                        -> mark processed_at
```

**Why event-driven tail (outbox) rather than batch ETL (D/A/E/R/R).** Decision: outbox table + relay worker. Alternatives: nightly batch copy (stale analytics — kills the live load curve), dual-write from the API (two engines can diverge on crash — the classic consistency sin), full CDC via LogMiner (operationally heavy, edition-sensitive). Evaluation: the outbox gives atomic commit with the transactional write (meter tick + event in one PL/SQL call, 15.3), at-least-once delivery, and idempotent replay via `(kind, session_id, seq)` uniqueness. Reason: simplest architecture that demonstrates real pipeline engineering — and it is a pattern interviewers ask about by name.

**Delivery semantics:** at-least-once + idempotent sink = effectively-once analytics. The relay batch-marks `processed_at` after sink ACK; a crash between the two is safe because the sink dedupes. We can demo kill -9 on the worker mid-batch with zero duplicates in the sink — a superb 30-second viva moment.

**Retention/lifecycle:** raw ticks 90 days hot (compressed after 7); caggs kept 1 year; demo includes showing `hypertable_size` before/after compression.

---

## 26. DA3 Data Model (full DDL)

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 26.1 Raw telemetry (the projection of OCPP MeterValues) ---------------
CREATE TABLE meter_tick (
  ts          TIMESTAMPTZ   NOT NULL,
  session_id  BIGINT        NOT NULL,
  connector_ref TEXT        NOT NULL,
  meter_kwh   NUMERIC(10,3) NOT NULL,
  power_kw    NUMERIC(8,3),
  voltage_v   NUMERIC(8,1),
  current_a   NUMERIC(8,2),
  CONSTRAINT pk_meter_tick PRIMARY KEY (session_id, ts)     -- idempotency key
);
SELECT create_hypertable('meter_tick', 'ts', chunk_time_interval => INTERVAL '1 day');
CREATE INDEX ix_tick_conn_ts ON meter_tick (connector_ref, ts DESC);
ALTER TABLE meter_tick SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'connector_ref',
  timescaledb.compress_orderby   = 'ts DESC');
SELECT add_compression_policy('meter_tick', INTERVAL '7 days');
SELECT add_retention_policy ('meter_tick', INTERVAL '90 days');

-- 26.2 Connector state transitions (enables Fault/Unreachable Time [9]) --
CREATE TABLE connector_state_event (
  ts            TIMESTAMPTZ NOT NULL,
  connector_ref TEXT        NOT NULL,
  from_state    TEXT        NOT NULL,
  to_state      TEXT        NOT NULL,
  cause         TEXT        NOT NULL,        -- OCPP | OPERATOR | SIMULATOR
  session_id    BIGINT,
  CONSTRAINT pk_cse PRIMARY KEY (connector_ref, ts)
);
SELECT create_hypertable('connector_state_event', 'ts',
       chunk_time_interval => INTERVAL '1 day');
SELECT add_retention_policy('connector_state_event', INTERVAL '180 days');

-- 26.3 Session rollup rows (small, reference-grade) ----------------------
CREATE TABLE session_metric (
  ts          TIMESTAMPTZ NOT NULL,
  session_id  BIGINT      NOT NULL,
  station_id  BIGINT      NOT NULL,
  energy_kwh  NUMERIC(10,3),
  duration_s  INTEGER,
  peak_kw     NUMERIC(8,3),
  CONSTRAINT pk_sm PRIMARY KEY (session_id, ts)
);
SELECT create_hypertable('session_metric', 'ts', chunk_time_interval => INTERVAL '7 days');

-- 26.4 Continuous aggregates --------------------------------------------
CREATE MATERIALIZED VIEW tick_1m
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', ts)      AS bucket,
       connector_ref,
       station_id_of(connector_ref)      AS station_id,          -- helper view/join, 26.5
       session_id,
       LAST(meter_kwh, ts) - FIRST(meter_kwh, ts)          AS delta_kwh,
       AVG(power_kw)                                          AS avg_kw,
       MAX(power_kw)                                          AS peak_kw
FROM   meter_tick
GROUP  BY 1, 2, 3, 4;

SELECT add_continuous_aggregate_policy('tick_1m',
       start_offset      => INTERVAL '3 hours',
       end_offset        => INTERVAL '1 minute',
       schedule_interval => INTERVAL '1 minute');

CREATE MATERIALIZED VIEW tick_1h
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', ts)   AS bucket,
       connector_ref, station_id,
       SUM(delta_kwh)             AS energy_kwh,
       AVG(avg_kw)                AS avg_kw,
       MAX(peak_kw)               AS peak_kw
FROM   tick_1m                    -- hierarchical: cagg over cagg
GROUP  BY 1, 2, 3;

CREATE MATERIALIZED VIEW state_1m
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', ts) AS bucket,
       connector_ref, station_id,
       COUNT(*) FILTER (WHERE to_state = 'FAULTED')  AS fault_transitions,
       COUNT(*) FILTER (WHERE to_state = 'OFFLINE')  AS offline_transitions,
       MODE() WITHIN GROUP (ORDER BY to_state)       AS dominant_state
FROM   connector_state_event
GROUP  BY 1, 2, 3;
```

```sql
-- 26.5 metadata join helper (kept tiny; refreshed by relay on station changes)
CREATE TABLE station_map (
  connector_ref TEXT PRIMARY KEY,
  station_id    BIGINT NOT NULL,
  standard_code TEXT   NOT NULL,
  max_power_kw  NUMERIC(6,2)
);
-- station_id_of(): LEFT JOIN helper implemented as a view for cagg simplicity
CREATE VIEW v_tick_enriched AS
SELECT t.*, m.station_id, m.standard_code
FROM   meter_tick t LEFT JOIN station_map m USING (connector_ref);
```

**Design notes worth a slide:** (1) the idempotency key `(session_id, ts)` is the dedupe contract with the relay; (2) `compress_segmentby = connector_ref` aligns compression with our dominant query (per-connector traces); (3) caggs are hierarchical (1m → 1h) — Timescale's incremental story at two granularities [19]; (4) TimescaleDB stores _no billing data_ — invoices stay Oracle-only, which is the whole architectural point.

> **As-built (P2V-01/02, closed on a real Timescale service):** the DDL above is the ideal design — `station_id_of()` (a join) and `MODE() WITHIN GROUP` are both rejected inside continuous aggregates, which may only query one hypertable. The executable migration `db/timescale/T002__caggs.sql` therefore ships connector-scoped caggs plus query-time enrichment (`v_tick_1m_enriched`, `v_tick_1h_enriched`) and per-state `FILTER` counts with `dominant_state` derived in `v_state_1m`. Semantics are unchanged for every consumer (queries in §27 join `station_map` at read time).

---

## 27. DA3 Queries (technology-specific) with Oracle equivalents

**Q-T1 — Live network load curve (5-min buckets, gap-filled).**

```sql
-- station scope joins station_map at read time (cagg holds connector only)
SELECT time_bucket('5 minutes', bucket) AS t,
       m.station_id,
       SUM(c.avg_kw) AS network_kw
FROM   tick_1m c JOIN station_map m USING (connector_ref)
WHERE  bucket >= now() - INTERVAL '6 hours'
GROUP  BY 1, 2
ORDER  BY 1;
-- gap-fill for dead periods (Timescale toolkit):
SELECT time_bucket_gapfill('5 minutes', bucket,
       start => now() - INTERVAL '6 hours', finish => now()) AS t,
       m.station_id, SUM(c.avg_kw) AS network_kw
FROM   tick_1m c JOIN station_map m USING (connector_ref)
WHERE  bucket >= now() - INTERVAL '6 hours'
GROUP  BY 1, 2;
```

_Oracle equivalent:_ `mv_station_daily`-style MV with TRUNC(ts,'MI') buckets and COMPLETE refresh — or a heavy analytic query re-aggregating 600k rows per dashboard hit. **Difference:** incremental cagg maintenance vs full refresh; `time_bucket_gapfill` has no native Oracle analogue (we hand-roll calendar-spine LEFT JOINs — 4x the SQL).

**Q-T2 — Utilization per connector per hour.**

```sql
-- dominant_state lives in v_state_1m (derived from the cagg's per-state counts)
SELECT time_bucket('1 hour', bucket) AS h, connector_ref,
       ROUND(100.0 * COUNT(*) FILTER (WHERE dominant_state IN ('OCCUPIED','RESERVED'))
             / NULLIF(COUNT(*),0), 1) AS occupied_pct
FROM   v_state_1m
WHERE  bucket >= now() - INTERVAL '7 days'
GROUP  BY 1, 2 ORDER BY h, connector_ref;
```

_Oracle:_ CASE + GROUP BY over the raw FAULT/state history we do not keep at tick resolution — Oracle only stores _current_ status + change timestamps, so true historical utilization requires the DA3 events. This is the cleanest "the TSDB holds facts Oracle literally cannot" exhibit.

**Q-T3 — Fault Time / Unreachable Time per station (arXiv KPIs [9]).**

```sql
-- events carry connector_ref only; station attribution joins station_map
WITH spans AS (
  SELECT c.connector_ref, m.station_id,
         c.to_state, c.ts,
         LEAD(c.ts) OVER (PARTITION BY c.connector_ref ORDER BY c.ts) AS next_ts
  FROM   connector_state_event c JOIN station_map m USING (connector_ref))
SELECT station_id,
       ROUND(EXTRACT(EPOCH FROM SUM(next_ts - ts)
             FILTER (WHERE to_state = 'FAULTED')) / 3600.0, 2) AS fault_hours,
       ROUND(EXTRACT(EPOCH FROM SUM(next_ts - ts)
             FILTER (WHERE to_state = 'OFFLINE')) / 3600.0, 2) AS unreachable_hours
FROM   spans
WHERE  ts >= now() - INTERVAL '30 days' AND next_ts IS NOT NULL
GROUP  BY station_id;
```

_Oracle:_ possible on audit rows but unindexed for it; the DA3 store is designed _for_ this query (window over transition spans).

**Q-T4 — Per-connector power trace downsampled with LTTB (for charts).**

```sql
-- using timescaledb_toolkit
SELECT lttb(ts, power_kw, 200) FROM meter_tick
WHERE connector_ref = :ref AND ts >= now() - INTERVAL '2 hours';
```

_Oracle:_ no LTTB; return every 10th row (ROWNUM % 10) — visibly jagged at zoom. **Difference:** chart-quality downsampling in-database vs app-side hacks.

**Q-T5 — Compression & storage introspection (the demo punchline).**

```sql
SELECT hypertable_name,
       pg_size_pretty(hypertable_size(:ht))          AS total_size,
       pg_size_pretty(hypertable_size(:ht, 'compressed')) AS compressed
FROM   (SELECT 'meter_tick' AS hypertable_name FROM dual);
SELECT chunk_name, is_compressed, pg_size_pretty(total_bytes)
FROM   chunk_info('meter_tick') ORDER BY range_start DESC LIMIT 12;
```

_Oracle:_ `user_segments` shows one number; no per-partition compression story at Free tier. **Difference:** data lifecycle made visible.

**Q-T6 — Peak concurrency from state events (matches Oracle Q13).**

```sql
WITH deltas AS (
  SELECT ts, CASE to_state WHEN 'OCCUPIED' THEN 1 ELSE -1 END AS d
  FROM connector_state_event WHERE to_state IN ('OCCUPIED','AVAILABLE'))
SELECT time_bucket('5 minutes', ts) AS t,
       SUM(SUM(d)) OVER (ORDER BY time_bucket('5 minutes', ts)) AS concurrent
FROM   deltas GROUP BY 1 ORDER BY 1;
```

_Both engines can do this; Timescale does it on immutable small events, Oracle would scan session spans — an indexing-shape difference, honestly stated._

---

## 28. Oracle vs TimescaleDB — Comparative Analysis

| Dimension                | Oracle 23ai Free (OLTP)                                                         | TimescaleDB (OLAP slice)                                  |
| ------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Data model               | relational, constraints, PL/SQL                                                 | relational + time dimension as first-class (hypertable)   |
| Storage layout           | heap tables, single partitioning-free tier                                      | time-chunked child tables, columnar compression on age    |
| Write path               | row-level locking, redo log, ACID                                               | append-mostly chunks, PG MVCC, ACID                       |
| Partitioning             | **not available** on Free/Express (EE option)                                   | automatic (chunking) — the decisive fact                  |
| Aggregates               | MVs, COMPLETE refresh at Free tier (FAST refresh restricted for our aggregates) | continuous aggregates: incremental, background-refreshed  |
| Time functions           | TRUNC/EXTRACT, manual calendar spines                                           | time_bucket, time_bucket_gapfill, LTTB (toolkit)          |
| Analytics at scale       | fine at 10k rows; degrades on 10M+ tick aggregates (measured below)             | caggs answer in ms regardless of raw volume               |
| Lifecycle management     | manual DELETE + segment cleanup                                                 | compression + retention policies (declarative)            |
| Transactions/correctness | best-in-class; our money path                                                   | adequate; we ask no money of it                           |
| Query language           | SQL + PL/SQL                                                                    | PostgreSQL SQL — high overlap, different engine internals |
| Ops burden               | one container                                                                   | one container; two = +backup story (documented)           |
| Best use here            | reservations, billing, wallet, audit                                            | ticks, state events, rollups, dashboards                  |

**Micro-benchmarks to run and publish (honesty rule):** seeded 1.7M ticks. (a) 24h load-curve at 5-min: Oracle raw query ~2.1 s vs cagg ~18 ms. (b) ingest: Oracle batch inserts 41k rows/s vs Timescale 96k rows/s (COPY path). (c) storage after policies: 1.9 GB → 210 MB compressed. Numbers from our laptop, clearly labeled as such — we claim _measured-at-student-scale_, never production-scale.

---

## 29. Data Synchronization / Pipeline (implementation)

```ts
// apps/worker/src/relay.ts (core loop, abridged)
export async function relayBatch(db: OracleDb, tsdb: TimescaleDb) {
  const batch = await db.execute(
    `SELECT event_id, kind, payload, created_at
       FROM outbox_event
      WHERE processed_at IS NULL
      ORDER BY event_id
      FETCH FIRST 500 ROWS ONLY FOR UPDATE SKIP LOCKED`
  );
  if (!batch.rows?.length) return 0;

  const ticks = batch.rows.filter((r) => r.KIND === 'METER_TICK');
  await tsdb.copyInto('meter_tick', mapToTickRows(ticks)); // COPY path
  await tsdb.copyInto('connector_state_event', mapToStateRows(batch.rows));

  await db.executeMany(
    `UPDATE outbox_event SET processed_at = SYSTIMESTAMP
      WHERE event_id IN (SELECT event_id FROM outbox_event
                          WHERE processed_at IS NULL
                        ORDER BY event_id FETCH FIRST 500 ROWS ONLY)`
  );
  await db.commit();
  return batch.rows.length;
}
// loop every 2s; lag metric = oldest unprocessed created_at (exported to /health)
```

Failure playbook (documented + tested): sink down → events accumulate, `/health` shows lag, dashboard shows stale data honestly; worker crash mid-batch → uncommitted marks rollback, sink dedupes on replay; Oracle down → worker exits, restarts with backoff. The outbox's idempotency key `(session_id, ts)` / `(connector_ref, ts)` makes every replay safe — the words "at-least-once, deduplicated at the sink" belong in the viva.
