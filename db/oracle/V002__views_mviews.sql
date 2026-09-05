-- ============================================================================
-- VoltHub CSMS — V002 views + materialized views (Oracle 23ai)
-- ============================================================================

-- Live connector feed: one row per connector with station context.
CREATE OR REPLACE VIEW v_connector_live AS
SELECT s.station_id, s.name AS station_name, s.city, s.latitude, s.longitude,
       s.status AS station_status,
       cp.cp_id, cp.ocpp_identity, cp.status AS cp_status,
       c.connector_no,
       cp.cp_id || ':' || c.connector_no AS connector_ref,
       c.max_power_kw, st.code AS standard_code, st.display_name AS standard_name,
       c.status AS connector_status, c.last_state_change_at
FROM connector c
JOIN charge_point cp ON cp.cp_id = c.cp_id
JOIN station s ON s.station_id = cp.station_id
JOIN connector_standard st ON st.standard_id = c.standard_id;

-- Station rollup (derived on read — NOT stored, per §12.6).
CREATE OR REPLACE VIEW v_station_summary AS
SELECT s.station_id, s.name AS station_name, s.city,
       COUNT(*) AS connector_count,
       SUM(CASE WHEN c.status = 'AVAILABLE' THEN 1 ELSE 0 END) AS available_count,
       (SELECT ROUND(AVG(r.rating),2) FROM review r
         JOIN charging_session cs ON cs.session_id = r.session_id
         JOIN charge_point cp2 ON cs.connector_ref LIKE cp2.cp_id || ':%'
        WHERE cp2.station_id = s.station_id) AS avg_rating,
       (SELECT COUNT(*) FROM charging_session cs2
         JOIN charge_point cp3 ON cs2.connector_ref LIKE cp3.cp_id || ':%'
        WHERE cp3.station_id = s.station_id) AS total_sessions
FROM station s
JOIN charge_point cp ON cp.station_id = s.station_id
JOIN connector c ON c.cp_id = cp.cp_id
GROUP BY s.station_id, s.name, s.city;

-- Daily revenue/energy MV: FAST-on-commit impossible (join+aggregate),
-- so COMPLETE refresh every 15 min via scheduler job below.
CREATE MATERIALIZED VIEW mv_station_daily
BUILD IMMEDIATE
REFRESH COMPLETE ON DEMAND
AS
SELECT cp.station_id,
       s.name AS station_name,
       TRUNC(cs.started_at) AS day,
       COUNT(*) AS sessions,
       ROUND(NVL(SUM(cs.energy_kwh),0),3) AS energy_kwh,
       ROUND(NVL(SUM(CASE WHEN i.status IN ('PAID','DUE') THEN i.total ELSE 0 END),0),2) AS revenue
FROM charging_session cs
JOIN charge_point cp ON cs.connector_ref LIKE cp.cp_id || ':%'
JOIN station s ON s.station_id = cp.station_id
LEFT JOIN invoice i ON i.session_id = cs.session_id
WHERE cs.state = 'COMPLETED'
GROUP BY cp.station_id, s.name, TRUNC(cs.started_at);

CREATE INDEX ix_mvsd ON mv_station_daily(station_id, day);

BEGIN
  DBMS_SCHEDULER.create_job(
    job_name   => 'refresh_mv_station_daily',
    job_type   => 'PLSQL_BLOCK',
    job_action => 'BEGIN DBMS_MVIEW.REFRESH(''MV_STATION_DAILY'',''C''); END;',
    start_date => SYSTIMESTAMP,
    repeat_interval => 'FREQ=MINUTELY; INTERVAL=15',
    enabled    => TRUE,
    comments   => 'Refresh station daily revenue MV every 15 minutes');
EXCEPTION WHEN OTHERS THEN
  IF SQLCODE != -27477 THEN RAISE; END IF; -- job already exists
END;
/
COMMIT;
