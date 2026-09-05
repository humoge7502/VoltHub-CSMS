-- ============================================================================
-- VoltHub CSMS — TimescaleDB T002 continuous aggregates (PG16)
-- ============================================================================
-- cagg constraints (verified on a real Timescale service, P2V-01/02): a
-- continuous aggregate may query exactly ONE hypertable — no joins, no
-- correlated subqueries, no ordered-set aggregates (MODE()). station_map is
-- Oracle-owned metadata, so station enrichment happens at query time through
-- the v_*_enriched views below (joins against a cagg are fine in plain SQL).

-- 1-minute rollup: energy delta (LAST-FIRST), avg/max kW per connector.
CREATE MATERIALIZED VIEW IF NOT EXISTS tick_1m
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', ts) AS bucket,
       connector_ref,
       LAST(meter_kwh, ts) - FIRST(meter_kwh, ts) AS delta_kwh,
       AVG(power_kw) AS avg_kw,
       MAX(power_kw) AS peak_kw,
       COUNT(*) AS ticks
FROM meter_tick
GROUP BY bucket, connector_ref
WITH NO DATA;
SELECT add_continuous_aggregate_policy('tick_1m',
  start_offset => INTERVAL '3 hours', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE);

-- 1-hour rollup over 1-minute cagg (hierarchical: cagg over cagg), per connector.
-- NB: GROUP BY must name the time_bucket EXPRESSION — plain `bucket` would resolve
-- to tick_1m's minute-level bucket column (output-alias collision) and Timescale
-- rejects the cagg ("must include a valid time bucket function").
CREATE MATERIALIZED VIEW IF NOT EXISTS tick_1h
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', bucket) AS bucket,
       connector_ref,
       SUM(delta_kwh) AS energy_kwh,
       AVG(avg_kw) AS avg_kw,
       MAX(peak_kw) AS peak_kw,
       SUM(ticks) AS ticks
FROM tick_1m
GROUP BY time_bucket('1 hour', bucket), connector_ref
WITH NO DATA;
SELECT add_continuous_aggregate_policy('tick_1h',
  start_offset => INTERVAL '1 day', end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE);

-- Station-enriched cagg reads (plain views: joins against caggs are allowed).
CREATE OR REPLACE VIEW v_tick_1m_enriched AS
SELECT c.bucket, c.connector_ref, m.station_id, m.station_name,
       c.delta_kwh, c.avg_kw, c.peak_kw, c.ticks
FROM tick_1m c LEFT JOIN station_map m USING (connector_ref);
CREATE OR REPLACE VIEW v_tick_1h_enriched AS
SELECT c.bucket, c.connector_ref, m.station_id, m.station_name,
       c.energy_kwh, c.avg_kw, c.peak_kw, c.ticks
FROM tick_1h c LEFT JOIN station_map m USING (connector_ref);

-- State rollup: transition counts per state per minute per connector.
-- P2V-02 fallback: MODE() WITHIN GROUP (ordered-set) is rejected inside caggs,
-- so dominant_state is derived at query time from these counts (see v_state_1m).
CREATE MATERIALIZED VIEW IF NOT EXISTS state_1m
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', ts) AS bucket,
       connector_ref,
       COUNT(*) AS events,
       COUNT(*) FILTER (WHERE to_state = 'AVAILABLE')   AS avail_events,
       COUNT(*) FILTER (WHERE to_state = 'OCCUPIED')    AS occ_events,
       COUNT(*) FILTER (WHERE to_state = 'RESERVED')    AS res_events,
       COUNT(*) FILTER (WHERE to_state = 'FAULTED')     AS fault_events,
       COUNT(*) FILTER (WHERE to_state = 'UNAVAILABLE') AS unavail_events,
       COUNT(*) FILTER (WHERE to_state = 'OFFLINE')     AS offline_events
FROM connector_state_event
GROUP BY bucket, connector_ref
WITH NO DATA;
SELECT add_continuous_aggregate_policy('state_1m',
  start_offset => INTERVAL '3 hours', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE);

-- Dominant-state read model over state_1m (P2V-02 fallback). A minute's
-- dominant state = most frequent transition target; ties resolve by a fixed
-- priority (fault/offline first — conservative), NULL when none of the known
-- states moved (mirrors MODE() over an empty set).
CREATE OR REPLACE VIEW v_state_1m AS
WITH w AS (
  SELECT bucket, connector_ref, events,
         avail_events, occ_events, res_events,
         fault_events, unavail_events, offline_events,
         GREATEST(avail_events, occ_events, res_events,
                  fault_events, unavail_events, offline_events) AS mx
  FROM state_1m)
SELECT bucket, connector_ref, events,
       avail_events, occ_events, res_events,
       fault_events, unavail_events, offline_events,
       CASE
         WHEN events > 0 AND mx > 0 AND fault_events = mx     THEN 'FAULTED'
         WHEN events > 0 AND mx > 0 AND offline_events = mx   THEN 'OFFLINE'
         WHEN events > 0 AND mx > 0 AND occ_events = mx       THEN 'OCCUPIED'
         WHEN events > 0 AND mx > 0 AND res_events = mx       THEN 'RESERVED'
         WHEN events > 0 AND mx > 0 AND unavail_events = mx   THEN 'UNAVAILABLE'
         WHEN events > 0 AND mx > 0 AND avail_events = mx     THEN 'AVAILABLE'
         ELSE NULL
       END AS dominant_state
FROM w;

-- Enriched tick view over the raw hypertable (ticks x station metadata).
CREATE OR REPLACE VIEW v_tick_enriched AS
SELECT t.ts, t.session_id, t.connector_ref, m.station_id, m.station_name,
       t.meter_kwh, t.power_kw
FROM meter_tick t LEFT JOIN station_map m USING (connector_ref);
