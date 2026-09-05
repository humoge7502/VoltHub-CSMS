-- ============================================================================
-- VoltHub CSMS — V006 FK-native connector linkage (Oracle 23ai)
-- Implements ADR-0006 (D-01): packages insert (cp_id, connector_no) natively;
-- connector_ref stays as a package-computed display handle; the V005 sync
-- triggers are retired; D-02 tariff minute modeling lands as VIRTUAL columns.
-- Idempotent-ish: every DDL/DROP tolerates re-runs (fresh volumes + migrate.sh).
-- Run: sql volthub/<pwd>@localhost/freepdb1 @V006__fk_native.sql
-- ============================================================================

-- ---- 0. Safety backfill (re-run V005 derivation so the pair is complete) ----
UPDATE reservation
   SET cp_id = TO_NUMBER(REGEXP_SUBSTR(connector_ref, '^[^:]+')),
       connector_no = TO_NUMBER(REGEXP_SUBSTR(connector_ref, '[^:]+$'))
 WHERE (cp_id IS NULL OR connector_no IS NULL)
   AND REGEXP_LIKE(connector_ref, '^[0-9]+:[0-9]+$');
UPDATE charging_session
   SET cp_id = TO_NUMBER(REGEXP_SUBSTR(connector_ref, '^[^:]+')),
       connector_no = TO_NUMBER(REGEXP_SUBSTR(connector_ref, '[^:]+$'))
 WHERE (cp_id IS NULL OR connector_no IS NULL)
   AND REGEXP_LIKE(connector_ref, '^[0-9]+:[0-9]+$');
COMMIT;

-- ---- 1. Native inserts: reservation_pkg.create_reservation writes the FK pair ----
-- (Full body replacement; identical to V003 except the INSERT lists
-- (connector_ref, cp_id, connector_no, ...) with (v_ref, p_cp, p_conn, ...).
-- connector_ref remains the package-computed display handle 'cpId:connNo'.)
CREATE OR REPLACE PACKAGE BODY reservation_pkg AS
  PROCEDURE create_reservation(p_user IN NUMBER, p_vehicle IN NUMBER,
    p_cp IN NUMBER, p_conn IN NUMBER, p_start IN TIMESTAMP, p_end IN TIMESTAMP,
    p_res_id OUT NUMBER) IS
    v_status VARCHAR2(16);
    v_mins NUMBER;
    v_overlap NUMBER;
    v_ref VARCHAR2(72);
  BEGIN
    -- V004 guard: mark package-owned connector writes so trg_connector_guard allow-lists them.
    BEGIN DBMS_SESSION.SET_IDENTIFIER('pkg:reservation_pkg.create_reservation'); EXCEPTION WHEN OTHERS THEN NULL; END;
    -- BR-04: 15-120 min window, future start
    v_mins := (CAST(p_end AS DATE) - CAST(p_start AS DATE)) * 24 * 60;
    IF p_end <= p_start OR v_mins < 15 OR v_mins > 120 OR p_start < SYSTIMESTAMP - INTERVAL '1' MINUTE THEN
      RAISE_APPLICATION_ERROR(-20501, 'INVALID_WINDOW: reservation must be 15-120 min in the future');
    END IF;
    v_ref := p_cp || ':' || p_conn;
    -- Serialize per-connector writers (TOCTOU defense for R1)
    SELECT status INTO v_status FROM connector WHERE cp_id = p_cp AND connector_no = p_conn FOR UPDATE;
    -- BR-12: faulted/unbookable
    IF v_status NOT IN ('AVAILABLE','RESERVED') THEN
      RAISE_APPLICATION_ERROR(-20502, 'NOT_BOOKABLE: connector ' || v_ref || ' is ' || v_status);
    END IF;
    -- BR-05: overlap check (Oracle has no exclusion constraint)
    SELECT COUNT(*) INTO v_overlap FROM reservation
     WHERE connector_ref = v_ref AND status IN ('BOOKED','CONVERTED')
       AND start_at < p_end AND end_at > p_start;
    IF v_overlap > 0 THEN
      RAISE_APPLICATION_ERROR(-20503, 'OVERLAP: connector ' || v_ref || ' already booked in window');
    END IF;
    -- V006 (ADR-0006): FK pair written natively; the FK constraint (V005) validates
    -- the row at INSERT time instead of a trigger deriving it afterwards.
    INSERT INTO reservation (connector_ref, cp_id, connector_no, user_id, vehicle_id, start_at, end_at, status)
    VALUES (v_ref, p_cp, p_conn, p_user, p_vehicle, p_start, p_end, 'BOOKED')
    RETURNING reservation_id INTO p_res_id;
    UPDATE connector SET status = 'RESERVED', last_state_change_at = SYSTIMESTAMP
     WHERE cp_id = p_cp AND connector_no = p_conn;
    INSERT INTO outbox_event (kind, dedupe_key, payload) VALUES (
      'CONNECTOR_STATE', 'connstate:' || v_ref || ':' || p_res_id,
      JSON_OBJECT('connector_ref' VALUE v_ref, 'from' VALUE v_status,
                  'to' VALUE 'RESERVED', 'cause' VALUE 'RESERVATION',
                  'reservation_id' VALUE p_res_id));
    audit_pkg.log(p_user, 'RESERVATION', TO_CHAR(p_res_id), 'CREATE',
      NULL, JSON_OBJECT('connector_ref' VALUE v_ref, 'start' VALUE TO_CHAR(p_start,'YYYY-MM-DD HH24:MI')));
  END;

  PROCEDURE cancel_reservation(p_res_id IN NUMBER, p_actor IN NUMBER) IS
    v_ref VARCHAR2(72); v_status VARCHAR2(16);
    v_cp NUMBER; v_conn NUMBER;
  BEGIN
    SELECT connector_ref, status INTO v_ref, v_status FROM reservation
     WHERE reservation_id = p_res_id FOR UPDATE;
    IF v_status NOT IN ('BOOKED') THEN
      RAISE_APPLICATION_ERROR(-20504, 'CANCEL_CONFLICT: reservation not BOOKED');
    END IF;
    UPDATE reservation SET status = 'CANCELLED' WHERE reservation_id = p_res_id;
    v_cp := TO_NUMBER(REGEXP_SUBSTR(v_ref, '^[^:]+'));
    v_conn := TO_NUMBER(REGEXP_SUBSTR(v_ref, '[^:]+$'));
    UPDATE connector SET status = 'AVAILABLE', last_state_change_at = SYSTIMESTAMP
     WHERE cp_id = v_cp AND connector_no = v_conn AND status = 'RESERVED';
    audit_pkg.log(p_actor, 'RESERVATION', TO_CHAR(p_res_id), 'CANCEL', v_status, 'CANCELLED');
  END;

  PROCEDURE expire_stale(p_rows OUT NUMBER) IS
    CURSOR c_stale IS SELECT reservation_id FROM reservation
      WHERE status = 'BOOKED' AND start_at < SYSTIMESTAMP - INTERVAL '15' MINUTE
      FOR UPDATE SKIP LOCKED;
    TYPE t_ids IS TABLE OF NUMBER;
    v_ids t_ids;
  BEGIN
    OPEN c_stale; FETCH c_stale BULK COLLECT INTO v_ids LIMIT 500; CLOSE c_stale;
    p_rows := NVL(v_ids.COUNT, 0);
    IF p_rows > 0 THEN
      FORALL i IN 1..v_ids.COUNT
        UPDATE reservation SET status = 'EXPIRED' WHERE reservation_id = v_ids(i);
      COMMIT;
    END IF;
  END;
END reservation_pkg;
/

-- ---- 2. Native inserts: charge_session_pkg.start_session writes the FK pair ----
-- (Full body replacement; identical to V003 incl. B2G-013 ownership except the
-- INSERT lists (..., connector_ref, cp_id, connector_no, ...) natively.)
CREATE OR REPLACE PACKAGE BODY charge_session_pkg AS
  FUNCTION is_legal(p_from IN VARCHAR2, p_to IN VARCHAR2) RETURN BOOLEAN IS
  BEGIN
    IF p_from='RESERVED' AND p_to IN ('PREPARING','CANCELLED') THEN RETURN TRUE; END IF;
    IF p_from='PREPARING' AND p_to IN ('CHARGING','FAILED','CANCELLED') THEN RETURN TRUE; END IF;
    IF p_from='CHARGING' AND p_to IN ('SUSPENDED','COMPLETED','FAILED') THEN RETURN TRUE; END IF;
    IF p_from='SUSPENDED' AND p_to IN ('CHARGING','COMPLETED','FAILED') THEN RETURN TRUE; END IF;
    RETURN FALSE;
  END;

  PROCEDURE set_connector(p_ref IN VARCHAR2, p_to IN VARCHAR2) IS
    v_cp NUMBER := TO_NUMBER(REGEXP_SUBSTR(p_ref, '^[^:]+'));
    v_conn NUMBER := TO_NUMBER(REGEXP_SUBSTR(p_ref, '[^:]+$'));
  BEGIN
    UPDATE connector SET status = p_to, last_state_change_at = SYSTIMESTAMP
     WHERE cp_id = v_cp AND connector_no = v_conn;
  END;

  PROCEDURE transition(p_session IN NUMBER, p_to IN VARCHAR2, p_reason IN VARCHAR2 DEFAULT NULL) IS
    v_from VARCHAR2(16); v_ref VARCHAR2(72); v_end NUMBER;
  BEGIN
    BEGIN DBMS_SESSION.SET_IDENTIFIER('pkg:charge_session_pkg.transition'); EXCEPTION WHEN OTHERS THEN NULL; END;
    SELECT state, connector_ref INTO v_from, v_ref FROM charging_session
     WHERE session_id = p_session FOR UPDATE;
    IF NOT is_legal(v_from, p_to) THEN
      RAISE_APPLICATION_ERROR(-20601, 'ILLEGAL_TRANSITION: ' || v_from || ' -> ' || p_to);
    END IF;
    UPDATE charging_session SET state = p_to, stop_reason = NVL(p_reason, stop_reason),
      ended_at = CASE WHEN p_to IN ('COMPLETED','FAILED','CANCELLED') THEN SYSTIMESTAMP ELSE ended_at END
     WHERE session_id = p_session;
    IF p_to = 'CHARGING' THEN set_connector(v_ref, 'OCCUPIED'); END IF;
    IF p_to IN ('COMPLETED','FAILED','CANCELLED') THEN set_connector(v_ref, 'AVAILABLE'); END IF;
    INSERT INTO outbox_event (kind, dedupe_key, payload) VALUES (
      'SESSION_EVENT', 'sess:' || p_session || ':' || p_to || ':' || TO_CHAR(SYSTIMESTAMP,'YYYYMMDDHH24MISSFF'),
      JSON_OBJECT('session_id' VALUE p_session, 'from' VALUE v_from, 'to' VALUE p_to));
    -- BUG-014: audit row comes from trg_session_audit (covers billing_state too). No explicit
    -- audit_pkg.log here — the old call doubled every transition row.
  END;

  PROCEDURE start_session(p_user IN NUMBER, p_vehicle IN NUMBER, p_cp IN NUMBER, p_conn IN NUMBER,
    p_plan IN NUMBER, p_res IN NUMBER DEFAULT NULL, p_idtag IN VARCHAR2 DEFAULT NULL, p_sid OUT NUMBER) IS
    v_ref VARCHAR2(72) := p_cp || ':' || p_conn;
    v_cstat VARCHAR2(16);
    v_ruser NUMBER; v_rref VARCHAR2(72); v_rstat VARCHAR2(16);
  BEGIN
    BEGIN DBMS_SESSION.SET_IDENTIFIER('pkg:charge_session_pkg.start_session'); EXCEPTION WHEN OTHERS THEN NULL; END;
    SELECT status INTO v_cstat FROM connector WHERE cp_id = p_cp AND connector_no = p_conn FOR UPDATE;
    IF v_cstat NOT IN ('AVAILABLE','RESERVED') THEN
      RAISE_APPLICATION_ERROR(-20502, 'NOT_BOOKABLE: connector ' || v_ref || ' is ' || v_cstat);
    END IF;
    -- B2G-013: reservation ownership (mirrors JS store.startSession): reservation must
    -- belong to caller, target this connector, and be BOOKED. Else -20505 -> 409.
    IF p_res IS NOT NULL THEN
      BEGIN
        SELECT user_id, connector_ref, status INTO v_ruser, v_rref, v_rstat FROM reservation
         WHERE reservation_id = p_res FOR UPDATE;
      EXCEPTION WHEN NO_DATA_FOUND THEN
        RAISE_APPLICATION_ERROR(-20505, 'RESERVATION_MISMATCH: reservation not found');
      END;
      IF v_ruser != p_user OR v_rref != v_ref OR v_rstat != 'BOOKED' THEN
        RAISE_APPLICATION_ERROR(-20505, 'RESERVATION_MISMATCH: reservation does not belong to caller/connector or not BOOKED');
      END IF;
    END IF;
    -- V006 (ADR-0006): FK pair written natively alongside the display handle.
    INSERT INTO charging_session (user_id, vehicle_id, reservation_id, connector_ref, cp_id, connector_no,
      tariff_plan_id, id_tag, state, billing_state, started_at, start_meter_kwh)
    VALUES (p_user, p_vehicle, p_res, v_ref, p_cp, p_conn, p_plan, p_idtag, 'PREPARING', 'UNBILLED', SYSTIMESTAMP, 0)
    RETURNING session_id INTO p_sid;
    IF p_res IS NOT NULL THEN
      UPDATE reservation SET status = 'CONVERTED' WHERE reservation_id = p_res;
    END IF;
    set_connector(v_ref, 'OCCUPIED');
    audit_pkg.log(p_user, 'CHARGING_SESSION', TO_CHAR(p_sid), 'START', NULL,
      JSON_OBJECT('connector_ref' VALUE v_ref));
  END;

  PROCEDURE record_meter_tick(p_session IN NUMBER, p_seq IN NUMBER, p_at IN TIMESTAMP,
    p_kwh IN NUMBER, p_kw IN NUMBER DEFAULT NULL, p_v IN NUMBER DEFAULT NULL, p_a IN NUMBER DEFAULT NULL) IS
    v_last NUMBER; v_state VARCHAR2(16); v_ref VARCHAR2(72); v_uid NUMBER;
  BEGIN
    SELECT state, connector_ref, user_id INTO v_state, v_ref, v_uid FROM charging_session
     WHERE session_id = p_session FOR UPDATE;
    IF v_state NOT IN ('PREPARING','CHARGING','SUSPENDED') THEN
      RAISE_APPLICATION_ERROR(-20603, 'TICK_REJECTED: session not active');
    END IF;
    SELECT NVL(MAX(meter_kwh), -1) INTO v_last FROM meter_reading WHERE session_id = p_session;
    IF p_kwh < v_last - 0.001 THEN -- BR-11 monotonic
      RAISE_APPLICATION_ERROR(-20602, 'METER_REGRESSION');
    END IF;
    INSERT INTO meter_reading (session_id, seq_no, taken_at, meter_kwh, power_kw, voltage_v, current_a, source)
    VALUES (p_session, p_seq, p_at, p_kwh, p_kw, p_v, p_a, 'OCPP');
    IF v_state = 'PREPARING' AND p_seq >= 1 THEN
      UPDATE charging_session SET state = 'CHARGING' WHERE session_id = p_session;
    END IF;
    INSERT INTO outbox_event (kind, dedupe_key, payload) VALUES (
      'METER_TICK', 'tick:' || p_session || ':' || p_seq,
      JSON_OBJECT('session_id' VALUE p_session, 'seq' VALUE p_seq,
        'connector_ref' VALUE v_ref, 'meter_kwh' VALUE p_kwh,
        'power_kw' VALUE p_kw, 'ts' VALUE TO_CHAR(p_at,'YYYY-MM-DD"T"HH24:MI:SS')));
  EXCEPTION WHEN DUP_VAL_ON_INDEX THEN
    NULL; -- idempotent replay safe
  END;

  PROCEDURE stop_session(p_session IN NUMBER, p_reason IN VARCHAR2 DEFAULT 'REMOTE_STOP') IS
    v_end NUMBER; v_state VARCHAR2(16);
  BEGIN
    SELECT NVL(MAX(meter_kwh),0) INTO v_end FROM meter_reading WHERE session_id = p_session;
    UPDATE charging_session SET end_meter_kwh = v_end WHERE session_id = p_session;
    -- BUG-007: mirror the JS contract — a no-energy remote stop is a CANCEL, not a completion.
    SELECT state INTO v_state FROM charging_session WHERE session_id = p_session;
    IF v_state = 'PREPARING' THEN
      transition(p_session, 'CANCELLED', p_reason);
    ELSE
      transition(p_session, 'COMPLETED', p_reason);
    END IF;
  END;
END charge_session_pkg;
/

-- ---- 3. Retire the V005 shadow-column sync triggers (packages are now native) ----
BEGIN
  BEGIN EXECUTE IMMEDIATE 'DROP TRIGGER trg_res_cp_sync'; EXCEPTION WHEN OTHERS THEN
    IF SQLCODE != -4080 THEN RAISE; END IF; END;
  BEGIN EXECUTE IMMEDIATE 'DROP TRIGGER trg_sess_cp_sync'; EXCEPTION WHEN OTHERS THEN
    IF SQLCODE != -4080 THEN RAISE; END IF; END;
END;
/

-- ---- 4. Enforce the pair (tolerate legacy dirty rows: warn, don't fail migrate) ----
BEGIN
  BEGIN EXECUTE IMMEDIATE 'ALTER TABLE reservation MODIFY (cp_id NOT NULL)'; EXCEPTION WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('V006 note: reservation.cp_id has legacy NULLs — NOT NULL skipped (see invariant 11)'); END;
  BEGIN EXECUTE IMMEDIATE 'ALTER TABLE reservation MODIFY (connector_no NOT NULL)'; EXCEPTION WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('V006 note: reservation.connector_no has legacy NULLs — NOT NULL skipped'); END;
  BEGIN EXECUTE IMMEDIATE 'ALTER TABLE charging_session MODIFY (cp_id NOT NULL)'; EXCEPTION WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('V006 note: charging_session.cp_id has legacy NULLs — NOT NULL skipped'); END;
  BEGIN EXECUTE IMMEDIATE 'ALTER TABLE charging_session MODIFY (connector_no NOT NULL)'; EXCEPTION WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('V006 note: charging_session.connector_no has legacy NULLs — NOT NULL skipped'); END;
END;
/

-- ---- 5. D-02: minute-of-day modeling for tariff bands (TIMESTAMP date part is noise) ----
-- Half-open [start, end) stays the contract; start_minute/end_minute (0-1439) are the
-- viva-defensible uniqueness basis alongside the legacy TIMESTAMP unique slot.
BEGIN
  BEGIN EXECUTE IMMEDIATE 'ALTER TABLE tariff_band ADD (start_minute NUMBER(4) GENERATED ALWAYS AS (EXTRACT(HOUR FROM CAST(start_time AS TIMESTAMP))*60 + EXTRACT(MINUTE FROM CAST(start_time AS TIMESTAMP))) VIRTUAL)'; EXCEPTION WHEN OTHERS THEN
    IF SQLCODE != -01430 THEN RAISE; END IF; END;
  BEGIN EXECUTE IMMEDIATE 'ALTER TABLE tariff_band ADD (end_minute NUMBER(4) GENERATED ALWAYS AS (EXTRACT(HOUR FROM CAST(end_time AS TIMESTAMP))*60 + EXTRACT(MINUTE FROM CAST(end_time AS TIMESTAMP))) VIRTUAL)'; EXCEPTION WHEN OTHERS THEN
    IF SQLCODE != -01430 THEN RAISE; END IF; END;
  BEGIN EXECUTE IMMEDIATE 'ALTER TABLE tariff_band ADD CONSTRAINT ck_band_minute CHECK (start_minute BETWEEN 0 AND 1439 AND end_minute BETWEEN 0 AND 1439)'; EXCEPTION WHEN OTHERS THEN
    IF SQLCODE NOT IN (-02275, -02260) THEN RAISE; END IF; END;
  BEGIN EXECUTE IMMEDIATE 'CREATE UNIQUE INDEX uq_band_slot_minute ON tariff_band(plan_id, day_scope, start_minute)'; EXCEPTION WHEN OTHERS THEN
    IF SQLCODE != -00955 THEN RAISE; END IF; END;
END;
/
COMMENT ON COLUMN tariff_band.start_minute IS 'D-02: minute-of-day 0-1439 derived from start_time; half-open [start,end) billing';

-- ---- 6. audit_log payload CHECKs: audit_pkg.log writes plain text / NULL ----
-- Legacy V001 added `old_value/new_value CLOB CHECK (... IS JSON)` which rejects the
-- package audit payloads (plan names, 'DUE'/'PAID', fault codes) and NULL diffs, so
-- tariff/seed writes failed (ORA-02290) and Oracle ended up with plans:0. Fresh DBs
-- no longer create them (V001 updated) — drop them on any already-migrated DB.
-- NB: user_constraints.search_condition is LONG and cannot be filtered/compared —
-- resolve the CHECK constraints via user_cons_columns instead.
BEGIN
  FOR c IN (SELECT DISTINCT cc.constraint_name
            FROM user_cons_columns cc
            JOIN user_constraints uc
              ON uc.constraint_name = cc.constraint_name AND uc.table_name = 'AUDIT_LOG'
            WHERE cc.table_name = 'AUDIT_LOG'
              AND uc.constraint_type = 'C'
              AND cc.column_name IN ('OLD_VALUE', 'NEW_VALUE')) LOOP
    BEGIN
      EXECUTE IMMEDIATE 'ALTER TABLE audit_log DROP CONSTRAINT ' || c.constraint_name;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
END;
/
COMMIT;
