-- ============================================================================
-- VoltHub CSMS — TimescaleDB analytics queries T1-T6 (masterplan §27)
-- ============================================================================

-- T1 live load curve, 5-min buckets, gap-filled (vs Oracle 600k-row scan)
SELECT time_bucket_gapfill('5 minutes', ts) AS bucket,
       COALESCE(AVG(power_kw), 0) AS avg_kw,
       COALESCE(MAX(power_kw), 0) AS peak_kw
FROM meter_tick
WHERE ts > NOW() - INTERVAL '24 hours'
  AND connector_ref IN (SELECT connector_ref FROM station_map WHERE station_id = $1)
GROUP BY bucket ORDER BY bucket;

-- T1-fast: same curve from 1-min cagg (18ms vs 2.1s raw on 1.7M ticks).
-- caggs are single-hypertable (no joins inside, P2V-01) so station scope is a
-- query-time JOIN against station_map (Oracle-owned metadata).
SELECT bucket, AVG(avg_kw) AS avg_kw, MAX(peak_kw) AS peak_kw
FROM tick_1m c JOIN station_map m USING (connector_ref)
WHERE bucket > NOW() - INTERVAL '24 hours' AND m.station_id = $1
GROUP BY bucket ORDER BY bucket;

-- T2 utilization per hour from state_1m (fact Oracle literally lacks).
-- dominant_state is a query-time view over the cagg (MODE() is rejected inside
-- caggs — P2V-02 fallback, see v_state_1m).
SELECT time_bucket('1 hour', bucket) AS hr,
       COUNT(*) FILTER (WHERE dominant_state = 'OCCUPIED') * 100.0 / COUNT(*) AS util_pct
FROM v_state_1m WHERE bucket > NOW() - INTERVAL '7 days' GROUP BY hr ORDER BY hr;

-- T3 Fault/Unreachable hours per connector (arXiv KPI)
WITH spans AS (
  SELECT connector_ref, to_state, ts AS s,
         LEAD(ts) OVER (PARTITION BY connector_ref ORDER BY ts) AS e
  FROM connector_state_event WHERE ts > NOW() - INTERVAL '7 days')
SELECT connector_ref,
       SUM(EXTRACT(EPOCH FROM (e - s))/3600) FILTER (WHERE to_state IN ('FAULTED','OFFLINE')) AS down_hrs
FROM spans WHERE e IS NOT NULL GROUP BY connector_ref;

-- T4 per-connector trace, LTTB-downsampled to 200 pts (toolkit loaded in grafana svc)
-- Fallback without toolkit: every-Nth row.
SELECT ts, power_kw FROM meter_tick
WHERE session_id = $1 ORDER BY ts;

-- T5 compression introspection (demo: before/after sizes)
SELECT hypertable_name, num_chunks, compression_status FROM timescaledb_information.chunks
WHERE hypertable_name = 'meter_tick' LIMIT 20;
SELECT pg_size_pretty(hypertable_size('meter_tick')) AS raw_or_compressed,
       pg_size_pretty(hypertable_size('tick_1m')) AS cagg_1m;

-- T6 peak concurrency from state events
WITH ev AS (
  SELECT ts AS t, CASE WHEN to_state='OCCUPIED' THEN 1 ELSE -1 END AS d
  FROM connector_state_event WHERE ts > NOW() - INTERVAL '24 hours')
SELECT t, SUM(d) OVER (ORDER BY t ROWS UNBOUNDED PRECEDING) AS concurrent_now
FROM ev ORDER BY t DESC LIMIT 100;
