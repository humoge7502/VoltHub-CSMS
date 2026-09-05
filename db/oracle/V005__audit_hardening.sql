-- ============================================================================
-- VoltHub CSMS — V005 audit hardening (Oracle 23ai)
-- BUG-003 (guard allow-list is in V004), BUG-007/008/014 (package fixes in V003),
-- BUG-008 data canonicalization, BUG-019 privilege hardening, SEC-003 credentials,
-- §6.2 sargable connector FK columns. Idempotent-ish: guards tolerate re-runs.
-- Run: sql volthub/<pwd>@localhost/freepdb1 @V005__audit_hardening.sql
-- ============================================================================

-- ---- BUG-019: ensure the app user can create the V002 job + MV on lean images ----
BEGIN
  BEGIN EXECUTE IMMEDIATE 'GRANT CREATE JOB TO volthub'; EXCEPTION WHEN OTHERS THEN
    IF SQLCODE NOT IN (-01926, -01031) THEN RAISE; END IF; END;
  BEGIN EXECUTE IMMEDIATE 'GRANT CREATE MATERIALIZED VIEW TO volthub'; EXCEPTION WHEN OTHERS THEN
    IF SQLCODE NOT IN (-01926, -01031) THEN RAISE; END IF; END;
END;
/

-- ---- SEC-003: per-charge-point OCPP Basic secret (Security Profile 1) ----
BEGIN
  BEGIN EXECUTE IMMEDIATE 'ALTER TABLE charge_point ADD (auth_secret VARCHAR2(128))'; EXCEPTION WHEN OTHERS THEN
    IF SQLCODE != -01430 THEN RAISE; END IF; END; -- column already exists
END;
/
-- Demo default for pre-existing rows (production provisions random per-CP secrets).
UPDATE charge_point SET auth_secret = 'dev-' || ocpp_identity WHERE auth_secret IS NULL;
COMMIT;

-- ---- BUG-008: canonicalize midnight-closing bands (TIMESTAMP cannot hold 24:00) ----
-- Half-open [start, end) is the contract (V003 tariff_pkg + JS resolver). Any band whose
-- end_time lands exactly on midnight is clamped to 23:59:59 so edge ticks price in the new band.
UPDATE tariff_band
   SET end_time = end_time - INTERVAL '1' SECOND
 WHERE EXTRACT(HOUR FROM CAST(end_time AS TIMESTAMP)) = 0
   AND EXTRACT(MINUTE FROM CAST(end_time AS TIMESTAMP)) = 0
   AND EXTRACT(SECOND FROM CAST(end_time AS TIMESTAMP)) = 0;
COMMIT;

-- ---- §6.2: sargable connector FK columns (encoded connector_ref kept as display handle) ----
-- reservation / charging_session / fault keep connector_ref for compatibility; the new
-- (cp_id, connector_no) pair is the integrity + join path (indexed, FK-backed).
BEGIN
  BEGIN EXECUTE IMMEDIATE 'ALTER TABLE reservation ADD (cp_id NUMBER, connector_no NUMBER(2))'; EXCEPTION WHEN OTHERS THEN
    IF SQLCODE != -01430 THEN RAISE; END IF; END;
  BEGIN EXECUTE IMMEDIATE 'ALTER TABLE charging_session ADD (cp_id NUMBER, connector_no NUMBER(2))'; EXCEPTION WHEN OTHERS THEN
    IF SQLCODE != -01430 THEN RAISE; END IF; END;
  BEGIN EXECUTE IMMEDIATE 'ALTER TABLE fault ADD (cp_no NUMBER(2))'; EXCEPTION WHEN OTHERS THEN
    IF SQLCODE != -01430 THEN RAISE; END IF; END;
END;
/
-- Backfill from the encoded handle where possible.
UPDATE reservation
   SET cp_id = TO_NUMBER(REGEXP_SUBSTR(connector_ref, '^[^:]+')),
       connector_no = TO_NUMBER(REGEXP_SUBSTR(connector_ref, '[^:]+$'))
 WHERE cp_id IS NULL AND REGEXP_LIKE(connector_ref, '^[0-9]+:[0-9]+$');
UPDATE charging_session
   SET cp_id = TO_NUMBER(REGEXP_SUBSTR(connector_ref, '^[^:]+')),
       connector_no = TO_NUMBER(REGEXP_SUBSTR(connector_ref, '[^:]+$'))
 WHERE cp_id IS NULL AND REGEXP_LIKE(connector_ref, '^[0-9]+:[0-9]+$');
COMMIT;
-- FKs + indexes (tolerate re-runs).
BEGIN
  BEGIN EXECUTE IMMEDIATE 'ALTER TABLE reservation ADD CONSTRAINT fk_res_connector FOREIGN KEY (cp_id, connector_no) REFERENCES connector(cp_id, connector_no)'; EXCEPTION WHEN OTHERS THEN
    IF SQLCODE NOT IN (-02275, -02260) THEN RAISE; END IF; END;
  BEGIN EXECUTE IMMEDIATE 'ALTER TABLE charging_session ADD CONSTRAINT fk_sess_connector FOREIGN KEY (cp_id, connector_no) REFERENCES connector(cp_id, connector_no)'; EXCEPTION WHEN OTHERS THEN
    IF SQLCODE NOT IN (-02275, -02260) THEN RAISE; END IF; END;
  BEGIN EXECUTE IMMEDIATE 'CREATE INDEX ix_res_cp ON reservation(cp_id, connector_no, start_at)'; EXCEPTION WHEN OTHERS THEN
    IF SQLCODE != -00955 THEN RAISE; END IF; END;
  BEGIN EXECUTE IMMEDIATE 'CREATE INDEX ix_sess_cp ON charging_session(cp_id, connector_no, state)'; EXCEPTION WHEN OTHERS THEN
    IF SQLCODE != -00955 THEN RAISE; END IF; END;
END;
/
-- Keep the pair in sync on future writes (packages still write connector_ref only).
CREATE OR REPLACE TRIGGER trg_res_cp_sync
BEFORE INSERT OR UPDATE OF connector_ref ON reservation FOR EACH ROW
BEGIN
  IF :NEW.connector_ref IS NOT NULL AND REGEXP_LIKE(:NEW.connector_ref, '^[0-9]+:[0-9]+$') THEN
    :NEW.cp_id := TO_NUMBER(REGEXP_SUBSTR(:NEW.connector_ref, '^[^:]+'));
    :NEW.connector_no := TO_NUMBER(REGEXP_SUBSTR(:NEW.connector_ref, '[^:]+$'));
  END IF;
END;
/
CREATE OR REPLACE TRIGGER trg_sess_cp_sync
BEFORE INSERT OR UPDATE OF connector_ref ON charging_session FOR EACH ROW
BEGIN
  IF :NEW.connector_ref IS NOT NULL AND REGEXP_LIKE(:NEW.connector_ref, '^[0-9]+:[0-9]+$') THEN
    :NEW.cp_id := TO_NUMBER(REGEXP_SUBSTR(:NEW.connector_ref, '^[^:]+'));
    :NEW.connector_no := TO_NUMBER(REGEXP_SUBSTR(:NEW.connector_ref, '[^:]+$'));
  END IF;
END;
/
COMMIT;
