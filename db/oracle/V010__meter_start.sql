-- V010 — BUG-054 (review 2026-10-24): start_session captures the charger's absolute
-- meter register (OCPP StartTransaction.meterStart, kWh) instead of hardcoding 0.
-- billing_pkg already prices energy as end_meter_kwh - start_meter_kwh, so persisting
-- the true start is what stops overbilling every charger whose register is non-zero
-- at plug-in. p_meter_start defaults to 0, so existing callers are unaffected.
-- Full spec+body replacement of charge_session_pkg, identical to V006's body except
-- the new parameter and the INSERT value (the BUG-053 lesson: replacements must carry
-- every prior fix forward — this one is copied from the current V006 body verbatim).

CREATE OR REPLACE PACKAGE charge_session_pkg AS
  PROCEDURE transition(p_session IN NUMBER, p_to IN VARCHAR2, p_reason IN VARCHAR2 DEFAULT NULL);
  PROCEDURE start_session(p_user IN NUMBER, p_vehicle IN NUMBER, p_cp IN NUMBER, p_conn IN NUMBER,
    p_plan IN NUMBER, p_res IN NUMBER DEFAULT NULL, p_idtag IN VARCHAR2 DEFAULT NULL,
    p_meter_start IN NUMBER DEFAULT 0, p_sid OUT NUMBER);
  PROCEDURE record_meter_tick(p_session IN NUMBER, p_seq IN NUMBER, p_at IN TIMESTAMP,
    p_kwh IN NUMBER, p_kw IN NUMBER DEFAULT NULL, p_v IN NUMBER DEFAULT NULL, p_a IN NUMBER DEFAULT NULL);
  PROCEDURE stop_session(p_session IN NUMBER, p_reason IN VARCHAR2 DEFAULT 'REMOTE_STOP');
END charge_session_pkg;
/

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
    -- Single choke point for charge_session_pkg connector writes (see guard_pkg, V003):
    -- the guard identity is opened and closed around this one statement.
    guard_pkg.set_status('charge_session_pkg.set_connector', v_cp, v_conn, p_to);
  END;

  PROCEDURE transition(p_session IN NUMBER, p_to IN VARCHAR2, p_reason IN VARCHAR2 DEFAULT NULL) IS
    v_from VARCHAR2(16); v_ref VARCHAR2(72); v_end NUMBER;
  BEGIN
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
    p_plan IN NUMBER, p_res IN NUMBER DEFAULT NULL, p_idtag IN VARCHAR2 DEFAULT NULL,
    p_meter_start IN NUMBER DEFAULT 0, p_sid OUT NUMBER) IS
    v_ref VARCHAR2(72) := p_cp || ':' || p_conn;
    v_cstat VARCHAR2(16);
    v_ruser NUMBER; v_rref VARCHAR2(72); v_rstat VARCHAR2(16);
  BEGIN
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
    -- V010 (BUG-054): start_meter_kwh is the caller's absolute register, clamped at 0
    -- (the column CHECKs >= 0); NaN/negative inputs fall back to 0.
    INSERT INTO charging_session (user_id, vehicle_id, reservation_id, connector_ref, cp_id, connector_no,
      tariff_plan_id, id_tag, state, billing_state, started_at, start_meter_kwh)
    VALUES (p_user, p_vehicle, p_res, v_ref, p_cp, p_conn, p_plan, p_idtag, 'PREPARING', 'UNBILLED', SYSTIMESTAMP,
      CASE WHEN p_meter_start IS NULL OR p_meter_start < 0 OR p_meter_start != p_meter_start THEN 0
           ELSE ROUND(p_meter_start, 3) END)
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

COMMENT ON COLUMN charging_session.start_meter_kwh IS 'V010: absolute register at plug-in (OCPP meterStart/1000); energy priced as end - start (BUG-054)';
