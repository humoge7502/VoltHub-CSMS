-- ============================================================================
-- VoltHub CSMS — TimescaleDB T002 continuous aggregates (PG16)
-- ============================================================================

-- 1-minute rollup: energy delta (LAST-FIRST), avg/max kW per station+connector.
CREATE MATERIALIZED VIEW IF NOT EXISTS tick_1m
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', ts) AS bucket,
       connector_ref,
       (SELECT station_id FROM station_map m WHERE m.connector_ref = t.connector_ref) AS station_id,
       LAST(meter_kwh, ts) - FIRST(meter_kwh, ts) AS delta_kwh,
       AVG(power_kw) AS avg_kw,
       MAX(power_kw) AS peak_kw,
       COUNT(*) AS ticks
FROM meter_tick t
GROUP BY bucket, connector_ref
WITH NO DATA;
SELECT add_continuous_aggregate_policy('tick_1m',
  start_offset => INTERVAL '3 hours', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE);

-- 1-hour rollup over 1-minute cagg (hierarchical).
CREATE MATERIALIZED VIEW IF NOT EXISTS tick_1h
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', bucket) AS bucket,
       station_id,
       SUM(delta_kwh) AS energy_kwh,
       AVG(avg_kw) AS avg_kw,
       MAX(peak_kw) AS peak_kw,
       SUM(ticks) AS ticks
FROM tick_1m
GROUP BY bucket, station_id
WITH NO DATA;
SELECT add_continuous_aggregate_policy('tick_1h',
  start_offset => INTERVAL '1 day', end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE);

-- State rollup: fault/offline counts + dominant state per minute.
CREATE MATERIALIZED VIEW IF NOT EXISTS state_1m
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', ts) AS bucket,
       connector_ref,
       COUNT(*) FILTER (WHERE to_state = 'FAULTED') AS fault_events,
       COUNT(*) FILTER (WHERE to_state = 'OFFLINE') AS offline_events,
       MODE() WITHIN GROUP (ORDER BY to_state) AS dominant_state,
       COUNT(*) AS events
FROM connector_state_event
GROUP BY bucket, connector_ref
WITH NO DATA;
SELECT add_continuous_aggregate_policy('state_1m',
  start_offset => INTERVAL '3 hours', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE);

-- Enriched tick view (ticks x station metadata).
CREATE OR REPLACE VIEW v_tick_enriched AS
SELECT t.ts, t.session_id, t.connector_ref, m.station_id, m.station_name,
       t.meter_kwh, t.power_kw
FROM meter_tick t LEFT JOIN station_map m USING (connector_ref);
