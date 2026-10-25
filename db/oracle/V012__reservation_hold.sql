-- V012 — F-05 (review 2026-10-25): a connector's RESERVED hold is DERIVED from the
-- BOOKED windows on it, never from "the window being cancelled was the only one".
--
-- create_reservation rejects overlapping windows but allows several future ones on the
-- same connector (e.g. 10:00-10:30 and 11:00-11:30). Both V003/V006 released the
-- connector unconditionally on cancel/expire, so cancelling the first window turned the
-- connector AVAILABLE while the second was still BOOKED — another driver could start a
-- session and occupy the charger when the booked window arrived. The local store had
-- the same defect, so both engines agreed on the wrong answer (ADR-0005 parity is only
-- valuable when the shared rule is right).
--
-- Also fixes the matching end-of-session case in charge_session_pkg.transition: when a
-- converted booking completes while another BOOKED window remains, the connector must
-- return to RESERVED, not AVAILABLE.
--
-- Full spec/body replacements, carrying every prior fix forward (BUG-053 lesson):
--   reservation_pkg  <- V006 (FK-native inserts, cancel guard, expiry release)
--   charge_session_pkg <- V011 (FK-native inserts, B2G-013 ownership, V010 meter start,
--                         V011 stop_session meter stop + regression guard)

CREATE OR REPLACE PACKAGE BODY reservation_pkg AS
  -- One connector write path. The p_owner argument is the guard identity's owner name,
  -- so set_status() opens CLIENT_IDENTIFIER for exactly the UPDATE and clears it again
  -- (BUG-052). Caller must already have serialized the connector (FOR UPDATE or mutex).
  PROCEDURE release_hold_if_free(p_owner IN VARCHAR2, p_cp IN NUMBER, p_conn IN NUMBER,
    p_res_id IN NUMBER) IS
    v_ref VARCHAR2(72) := p_cp || ':' || p_conn;
    v_cstat VARCHAR2(16);
    v_booked NUMBER;
  BEGIN
    SELECT status INTO v_cstat FROM connector WHERE cp_id = p_cp AND connector_no = p_conn FOR UPDATE;
    IF v_cstat != 'RESERVED' THEN RETURN; END IF;
    SELECT COUNT(*) INTO v_booked FROM reservation WHERE connector_ref = v_ref AND status = 'BOOKED';
    IF v_booked > 0 THEN RETURN; END IF;  -- another window still owns the hold
    guard_pkg.set_status(p_owner, p_cp, p_conn, 'AVAILABLE', 'RESERVED');
    INSERT INTO outbox_event (kind, dedupe_key, payload) VALUES (
      'CONNECTOR_STATE', 'connstate:' || v_ref || ':' || p_res_id || ':release',
      JSON_OBJECT('connector_ref' VALUE v_ref, 'from' VALUE 'RESERVED',
                  'to' VALUE 'AVAILABLE', 'cause' VALUE 'RESERVATION',
                  'reservation_id' VALUE p_res_id));
  END;

  PROCEDURE create_reservation(p_user IN NUMBER, p_vehicle IN NUMBER,
    p_cp IN NUMBER, p_conn IN NUMBER, p_start IN TIMESTAMP, p_end IN TIMESTAMP,
    p_res_id OUT NUMBER) IS
    v_status VARCHAR2(16);
    v_mins NUMBER;
    v_overlap NUMBER;
    v_ref VARCHAR2(72);
  BEGIN
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
    -- from-state: only announce a real transition; re-booking an already-held
    -- connector keeps RESERVED and the 'from' value is truthful either way.
    guard_pkg.set_status('reservation_pkg.create_reservation', p_cp, p_conn, 'RESERVED');
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
    release_hold_if_free('reservation_pkg.cancel_reservation', v_cp, v_conn, p_res_id);
    audit_pkg.log(p_actor, 'RESERVATION', TO_CHAR(p_res_id), 'CANCEL', v_status, 'CANCELLED');
  END;

  PROCEDURE expire_stale(p_rows OUT NUMBER) IS
    CURSOR c_stale IS SELECT reservation_id, connector_ref FROM reservation
      WHERE status = 'BOOKED' AND start_at < SYSTIMESTAMP - INTERVAL '15' MINUTE
      FOR UPDATE SKIP LOCKED;
    TYPE t_ids IS TABLE OF NUMBER;
    TYPE t_refs IS TABLE OF VARCHAR2(72);
    v_ids t_ids;
    v_refs t_refs;
  BEGIN
    OPEN c_stale; FETCH c_stale BULK COLLECT INTO v_ids, v_refs LIMIT 500; CLOSE c_stale;
    p_rows := NVL(v_ids.COUNT, 0);
    IF p_rows > 0 THEN
      FORALL i IN 1..v_ids.COUNT
        UPDATE reservation SET status = 'EXPIRED' WHERE reservation_id = v_ids(i);
      -- BUG-050/053: expiry must release the hold it owned; F-05: but only if no other
      -- BOOKED window remains on that connector.
      FOR i IN 1..v_ids.COUNT LOOP
        release_hold_if_free('reservation_pkg.expire_stale',
          TO_NUMBER(REGEXP_SUBSTR(v_refs(i), '^[^:]+')),
          TO_NUMBER(REGEXP_SUBSTR(v_refs(i), '[^:]+$')),
          v_ids(i));
      END LOOP;
      COMMIT;
    END IF;
  END;
END reservation_pkg;
/

CREATE OR REPLACE PACKAGE charge_session_pkg AS
  PROCEDURE transition(p_session IN NUMBER, p_to IN VARCHAR2, p_reason IN VARCHAR2 DEFAULT NULL);
  PROCEDURE start_session(p_user IN NUMBER, p_vehicle IN NUMBER, p_cp IN NUMBER, p_conn IN NUMBER,
    p_plan IN NUMBER, p_res IN NUMBER DEFAULT NULL, p_idtag IN VARCHAR2 DEFAULT NULL,
    p_meter_start IN NUMBER DEFAULT 0, p_sid OUT NUMBER);
  PROCEDURE record_meter_tick(p_session IN NUMBER, p_seq IN NUMBER, p_at IN TIMESTAMP,
    p_kwh IN NUMBER, p_kw IN NUMBER DEFAULT NULL, p_v IN NUMBER DEFAULT NULL, p_a IN NUMBER DEFAULT NULL);
  PROCEDURE stop_session(p_session IN NUMBER, p_reason IN VARCHAR2 DEFAULT 'REMOTE_STOP',
    p_meter_stop IN NUMBER DEFAULT NULL);
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
    v_from VARCHAR2(16); v_ref VARCHAR2(72); v_booked NUMBER;
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
    IF p_to IN ('COMPLETED','FAILED','CANCELLED') THEN
      -- F-05: the connector is free only if no BOOKED window is waiting on it. A
      -- converted booking finishing while another future window remains must return
      -- the connector to RESERVED, otherwise the next driver can occupy the charger
      -- through that reserved window.
      SELECT COUNT(*) INTO v_booked FROM reservation
       WHERE connector_ref = v_ref AND status = 'BOOKED';
      IF v_booked > 0 THEN
        set_connector(v_ref, 'RESERVED');
      ELSE
        set_connector(v_ref, 'AVAILABLE');
      END IF;
    END IF;
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

  PROCEDURE stop_session(p_session IN NUMBER, p_reason IN VARCHAR2 DEFAULT 'REMOTE_STOP',
    p_meter_stop IN NUMBER DEFAULT NULL) IS
    v_end NUMBER; v_state VARCHAR2(16); v_ref VARCHAR2(72); v_start NUMBER;
  BEGIN
    SELECT state, connector_ref, NVL(start_meter_kwh,0) INTO v_state, v_ref, v_start
      FROM charging_session WHERE session_id = p_session FOR UPDATE;
    -- V011: the charger's meterStop is authoritative when supplied; otherwise use the
    -- highest recorded reading (remote stop / CP that never sent a final MeterValues).
    IF p_meter_stop IS NOT NULL THEN
      IF p_meter_stop + 0.001 < v_start THEN
        RAISE_APPLICATION_ERROR(-20602, 'METER_REGRESSION: stop meter is below start meter');
      END IF;
      v_end := p_meter_stop;
    ELSE
      SELECT NVL(MAX(meter_kwh), v_start) INTO v_end FROM meter_reading WHERE session_id = p_session;
    END IF;
    UPDATE charging_session SET end_meter_kwh = v_end WHERE session_id = p_session;
    -- BUG-007: mirror the JS contract — a no-energy remote stop is a CANCEL, not a completion.
    IF v_state = 'PREPARING' THEN
      transition(p_session, 'CANCELLED', p_reason);
    ELSE
      transition(p_session, 'COMPLETED', p_reason);
    END IF;
  END;
END charge_session_pkg;
/
