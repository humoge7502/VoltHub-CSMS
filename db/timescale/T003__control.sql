-- ============================================================================
-- VoltHub CSMS — TimescaleDB T003 control telemetry (FC-HCC, blueprint P.1)
-- meter_tick_enforcement: scheduled vs actual kW per CP at control cadence —
-- the compliance-verification source that closes the actuation loop (H.2.5).
-- Lives in Timescale (not Oracle) per the two-engine split: high-frequency,
-- analytics-first, retention-managed. Oracle owns decisions + certificates.
-- ============================================================================
CREATE TABLE IF NOT EXISTS meter_tick_enforcement (
  ts            TIMESTAMPTZ NOT NULL,
  cp_id         INTEGER NOT NULL,
  session_id    INTEGER,
  decision_id   BIGINT,
  scheduled_kw  DOUBLE PRECISION NOT NULL,
  actual_kw     DOUBLE PRECISION,
  deviation_kw  DOUBLE PRECISION,          -- actual - scheduled (sign matters)
  dedupe_key    TEXT,
  PRIMARY KEY (cp_id, ts, scheduled_kw)
);
SELECT create_hypertable('meter_tick_enforcement', 'ts',
  chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS ix_enf_cp_ts ON meter_tick_enforcement (cp_id, ts DESC);
ALTER TABLE meter_tick_enforcement SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'cp_id',
  timescaledb.compress_orderby = 'ts DESC');
SELECT add_compression_policy('meter_tick_enforcement', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('meter_tick_enforcement', INTERVAL '90 days', if_not_exists => TRUE);

-- 5-minute compliance rollup: p95 deviation per CP (feeds PROFILE_COMPLIANCE
-- outbox events and Grafana control-plane panels).
CREATE MATERIALIZED VIEW IF NOT EXISTS enforcement_5m
WITH (timescaledb.continuous) AS
SELECT time_bucket('5 minutes', ts) AS bucket,
       cp_id,
       AVG(scheduled_kw) AS avg_scheduled_kw,
       AVG(actual_kw) AS avg_actual_kw,
       MAX(ABS(deviation_kw)) AS max_deviation_kw,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY ABS(deviation_kw)) AS deviation_kw_p95,
       COUNT(*) AS samples
FROM meter_tick_enforcement
GROUP BY bucket, cp_id
WITH NO DATA;
SELECT add_continuous_aggregate_policy('enforcement_5m',
  start_offset => INTERVAL '3 hours', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '5 minutes', if_not_exists => TRUE);
