-- ============================================================================
-- VoltHub CSMS — TimescaleDB T001 hypertables (PG16 + timescaledb)
-- Projection only: Oracle stays system of record. Run after extension.
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS meter_tick (
  ts TIMESTAMPTZ NOT NULL,
  session_id INTEGER NOT NULL,
  connector_ref TEXT NOT NULL,
  meter_kwh DOUBLE PRECISION NOT NULL,
  power_kw DOUBLE PRECISION,
  voltage_v DOUBLE PRECISION,
  current_a DOUBLE PRECISION,
  PRIMARY KEY (session_id, ts)
);
SELECT create_hypertable('meter_tick', 'ts', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS ix_tick_conn_ts ON meter_tick (connector_ref, ts DESC);
ALTER TABLE meter_tick SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'connector_ref',
  timescaledb.compress_orderby = 'ts DESC');
SELECT add_compression_policy('meter_tick', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('meter_tick', INTERVAL '90 days', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS connector_state_event (
  ts TIMESTAMPTZ NOT NULL,
  connector_ref TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  cause TEXT NOT NULL DEFAULT 'OCPP',
  session_id INTEGER,
  PRIMARY KEY (connector_ref, ts)
);
SELECT create_hypertable('connector_state_event', 'ts', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
SELECT add_retention_policy('connector_state_event', INTERVAL '180 days', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS session_metric (
  ts TIMESTAMPTZ NOT NULL,
  session_id INTEGER NOT NULL,
  station_id INTEGER,
  energy_kwh DOUBLE PRECISION,
  duration_s INTEGER,
  peak_kw DOUBLE PRECISION,
  PRIMARY KEY (session_id, ts)
);
SELECT create_hypertable('session_metric', 'ts', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);

-- Station map: enrichment join for ticks (metadata lives in Oracle).
CREATE TABLE IF NOT EXISTS station_map (
  connector_ref TEXT PRIMARY KEY,
  station_id INTEGER NOT NULL,
  station_name TEXT NOT NULL,
  standard_code TEXT NOT NULL,
  max_power_kw DOUBLE PRECISION NOT NULL
);
