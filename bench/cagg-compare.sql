-- bench/cagg-compare.sql — experiment 4 (run after ≥1M ticks seeded).
-- Report medians of EXPLAIN (ANALYZE, BUFFERS) + hardware spec in docs/perf.md.
\timing on
-- Raw hypertable scan: 24 h load curve for one station.
EXPLAIN (ANALYZE, BUFFERS)
SELECT time_bucket('5 minutes', ts) AS bucket, AVG(power_kw), MAX(power_kw)
  FROM meter_tick WHERE ts > now() - INTERVAL '24 hours' GROUP BY 1 ORDER BY 1;
-- 1-minute cagg (hierarchical).
EXPLAIN (ANALYZE, BUFFERS)
SELECT bucket, avg_kw, peak_kw FROM tick_1m
 WHERE bucket > now() - INTERVAL '24 hours' ORDER BY 1;
-- 1-hour cagg.
EXPLAIN (ANALYZE, BUFFERS)
SELECT bucket, avg_kw, peak_kw FROM tick_1h
 WHERE bucket > now() - INTERVAL '24 hours' ORDER BY 1;
-- Compression ratio (measured, not asserted).
SELECT pg_size_pretty(before_compression_total_bytes) AS before,
       pg_size_pretty(after_compression_total_bytes) AS after
  FROM hypertable_compression_stats('meter_tick');
