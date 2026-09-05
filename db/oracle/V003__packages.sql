-- ============================================================================
-- VoltHub CSMS — V003 PL/SQL packages (Oracle 23ai)
-- RESERVATION_PKG / CHARGE_SESSION_PKG / BILLING_PKG / TARIFF_PKG /
-- MAINTENANCE_PKG / AUDIT_PKG / SEED_PKG
-- Error bands: -205xx reservations, -206xx sessions, -207xx billing,
--              -208xx guards, -209xx tariffs/maintenance
-- ============================================================================

-- ============================ AUDIT_PKG =====================================
CREATE OR REPLACE PACKAGE audit_pkg AUTHID DEFINER AS
  PROCEDURE log(p_actor IN NUMBER, p_entity IN VARCHAR2, p_entity_id IN VARCHAR2,
                p_action IN VARCHAR2, p_old IN CLOB DEFAULT NULL, p_new IN CLOB DEFAULT NULL);
END audit_pkg;
/
CREATE OR REPLACE PACKAGE BODY audit_pkg AS
  PROCEDURE log(p_actor IN NUMBER, p_entity IN VARCHAR2, p_entity_id IN VARCHAR2,
                p_action IN VARCHAR2, p_old IN CLOB DEFAULT NULL, p_new IN CLOB DEFAULT NULL) IS
    PRAGMA AUTONOMOUS_TRANSACTION;
  BEGIN
    INSERT INTO audit_log (actor_user_id, entity_name, entity_id, action, old_value, new_value)
    VALUES (p_actor, p_entity, p_entity_id, p_action, p_old, p_new);
    COMMIT;
  END;
END audit_pkg;
/

-- ========================= RESERVATION_PKG ==================================
CREATE OR REPLACE PACKAGE reservation_pkg AS
  PROCEDURE create_reservation(p_user IN NUMBER, p_vehicle IN NUMBER,
    p_cp IN NUMBER, p_conn IN NUMBER, p_start IN TIMESTAMP, p_end IN TIMESTAMP,
    p_res_id OUT NUMBER);
  PROCEDURE cancel_reservation(p_res_id IN NUMBER, p_actor IN NUMBER);
  PROCEDURE expire_stale(p_rows OUT NUMBER);
END reservation_pkg;
/
CREATE OR REPLACE PACKAGE BODY reservation_pkg AS
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
    INSERT INTO reservation (connector_ref, user_id, vehicle_id, start_at, end_at, status)
    VALUES (v_ref, p_user, p_vehicle, p_start, p_end, 'BOOKED')
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

-- ======================== CHARGE_SESSION_PKG ================================
CREATE OR REPLACE PACKAGE charge_session_pkg AS
  PROCEDURE transition(p_session IN NUMBER, p_to IN VARCHAR2, p_reason IN VARCHAR2 DEFAULT NULL);
  PROCEDURE start_session(p_user IN NUMBER, p_vehicle IN NUMBER, p_cp IN NUMBER, p_conn IN NUMBER,
    p_plan IN NUMBER, p_res IN NUMBER DEFAULT NULL, p_idtag IN VARCHAR2 DEFAULT NULL, p_sid OUT NUMBER);
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
    UPDATE connector SET status = p_to, last_state_change_at = SYSTIMESTAMP
     WHERE cp_id = v_cp AND connector_no = v_conn;
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
    audit_pkg.log(NULL, 'CHARGING_SESSION', TO_CHAR(p_session), 'TRANSITION', v_from, p_to);
  END;

  PROCEDURE start_session(p_user IN NUMBER, p_vehicle IN NUMBER, p_cp IN NUMBER, p_conn IN NUMBER,
    p_plan IN NUMBER, p_res IN NUMBER DEFAULT NULL, p_idtag IN VARCHAR2 DEFAULT NULL, p_sid OUT NUMBER) IS
    v_ref VARCHAR2(72) := p_cp || ':' || p_conn;
    v_cstat VARCHAR2(16);
  BEGIN
    SELECT status INTO v_cstat FROM connector WHERE cp_id = p_cp AND connector_no = p_conn FOR UPDATE;
    IF v_cstat NOT IN ('AVAILABLE','RESERVED') THEN
      RAISE_APPLICATION_ERROR(-20502, 'NOT_BOOKABLE: connector ' || v_ref || ' is ' || v_cstat);
    END IF;
    INSERT INTO charging_session (user_id, vehicle_id, reservation_id, connector_ref,
      tariff_plan_id, id_tag, state, billing_state, started_at, start_meter_kwh)
    VALUES (p_user, p_vehicle, p_res, v_ref, p_plan, p_idtag, 'PREPARING', 'UNBILLED', SYSTIMESTAMP, 0)
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
    v_end NUMBER;
  BEGIN
    SELECT NVL(MAX(meter_kwh),0) INTO v_end FROM meter_reading WHERE session_id = p_session;
    UPDATE charging_session SET end_meter_kwh = v_end WHERE session_id = p_session;
    transition(p_session, 'COMPLETED', p_reason);
  END;
END charge_session_pkg;
/

-- ============================ TARIFF_PKG ====================================
CREATE OR REPLACE PACKAGE tariff_pkg AS
  FUNCTION resolve_band_price(p_plan IN NUMBER, p_at IN TIMESTAMP) RETURN NUMBER;
  PROCEDURE create_version(p_group IN NUMBER, p_name IN VARCHAR2, p_session_fee IN NUMBER,
    p_idle_fee IN NUMBER, p_active_from IN TIMESTAMP, p_by IN NUMBER, p_new_plan OUT NUMBER);
END tariff_pkg;
/
CREATE OR REPLACE PACKAGE BODY tariff_pkg AS
  FUNCTION resolve_band_price(p_plan IN NUMBER, p_at IN TIMESTAMP) RETURN NUMBER IS
    v_price NUMBER; v_dow VARCHAR2(3);
  BEGIN
    v_dow := TO_CHAR(p_at, 'DY', 'NLS_DATE_LANGUAGE=AMERICAN');
    SELECT price_per_kwh INTO v_price FROM tariff_band
     WHERE plan_id = p_plan
       AND (day_scope = 'ALL' OR (day_scope='WEEKDAY' AND v_dow NOT IN ('SAT','SUN'))
            OR (day_scope='WEEKEND' AND v_dow IN ('SAT','SUN')))
       AND CAST(p_at AS DATE) - TRUNC(CAST(p_at AS DATE))
           BETWEEN (CAST(start_time AS DATE) - TRUNC(CAST(start_time AS DATE)))
           AND (CAST(end_time AS DATE) - TRUNC(CAST(end_time AS DATE)))
     FETCH FIRST 1 ROW ONLY;
    RETURN v_price;
  EXCEPTION WHEN NO_DATA_FOUND THEN
    RAISE_APPLICATION_ERROR(-20701, 'NO_TARIFF_BAND for plan ' || p_plan);
  END;

  PROCEDURE create_version(p_group IN NUMBER, p_name IN VARCHAR2, p_session_fee IN NUMBER,
    p_idle_fee IN NUMBER, p_active_from IN TIMESTAMP, p_by IN NUMBER, p_new_plan OUT NUMBER) IS
    v_max NUMBER; v_prev NUMBER;
  BEGIN
    SELECT NVL(MAX(version_no),0), MAX(plan_id) INTO v_max, v_prev FROM tariff_plan WHERE group_id = p_group;
    INSERT INTO tariff_plan (group_id, version_no, name, session_fee, idle_fee_per_30min,
      active_from, supersedes_plan_id, created_by)
    VALUES (p_group, v_max+1, p_name, p_session_fee, p_idle_fee, p_active_from, v_prev, p_by)
    RETURNING plan_id INTO p_new_plan;
    IF v_prev IS NOT NULL THEN
      UPDATE tariff_plan SET active_to = p_active_from WHERE plan_id = v_prev AND active_to IS NULL;
    END IF;
    audit_pkg.log(p_by, 'TARIFF_PLAN', TO_CHAR(p_new_plan), 'VERSION', TO_CHAR(v_prev), p_name);
  END;
END tariff_pkg;
/

-- ============================ BILLING_PKG ===================================
CREATE OR REPLACE PACKAGE billing_pkg AS
  PROCEDURE bill_session(p_session IN NUMBER, p_invoice OUT NUMBER);
  PROCEDURE pay_invoice(p_invoice IN NUMBER, p_user IN NUMBER, p_payment OUT NUMBER);
END billing_pkg;
/
CREATE OR REPLACE PACKAGE BODY billing_pkg AS
  PROCEDURE bill_session(p_session IN NUMBER, p_invoice OUT NUMBER) IS
    v_state VARCHAR2(16); v_bill VARCHAR2(16); v_plan NUMBER;
    v_start NUMBER; v_end NUMBER; v_energy NUMBER; v_price NUMBER;
    v_fee NUMBER; v_energy_amt NUMBER; v_total NUMBER; v_started TIMESTAMP;
  BEGIN
    SELECT state, billing_state, tariff_plan_id, start_meter_kwh,
           NVL(end_meter_kwh, start_meter_kwh), started_at
      INTO v_state, v_bill, v_plan, v_start, v_end, v_started
      FROM charging_session WHERE session_id = p_session FOR UPDATE;
    IF v_state != 'COMPLETED' THEN
      RAISE_APPLICATION_ERROR(-20702, 'BILL_CONFLICT: session not COMPLETED');
    END IF;
    IF v_bill != 'UNBILLED' THEN
      RAISE_APPLICATION_ERROR(-20703, 'BILLING_CONFLICT: already ' || v_bill);
    END IF;
    v_energy := GREATEST(v_end - v_start, 0);
    v_price := tariff_pkg.resolve_band_price(v_plan, v_started);
    v_energy_amt := ROUND(v_energy * v_price, 2);
    SELECT session_fee INTO v_fee FROM tariff_plan WHERE plan_id = v_plan;
    v_total := v_energy_amt + NVL(v_fee, 0);
    INSERT INTO invoice (session_id, tariff_plan_id, status, total)
    VALUES (p_session, v_plan, 'DUE', v_total) RETURNING invoice_id INTO p_invoice;
    INSERT INTO invoice_line (invoice_id, line_no, kind, description, quantity, unit, unit_price, amount)
    VALUES (p_invoice, 1, 'ENERGY', 'Energy ' || v_energy || ' kWh @ Rs.' || v_price,
            v_energy, 'kWh', v_price, v_energy_amt);
    IF NVL(v_fee,0) > 0 THEN
      INSERT INTO invoice_line (invoice_id, line_no, kind, description, amount)
      VALUES (p_invoice, 2, 'SESSION_FEE', 'Session fee', v_fee);
    END IF;
    UPDATE charging_session SET billing_state = 'BILLED', energy_kwh = v_energy,
      end_meter_kwh = v_end WHERE session_id = p_session;
    audit_pkg.log(NULL, 'INVOICE', TO_CHAR(p_invoice), 'ISSUE', NULL,
      JSON_OBJECT('session' VALUE p_session, 'total' VALUE v_total));
  END;

  PROCEDURE pay_invoice(p_invoice IN NUMBER, p_user IN NUMBER, p_payment OUT NUMBER) IS
    v_total NUMBER; v_status VARCHAR2(16); v_bal NUMBER; v_seq NUMBER;
  BEGIN
    SELECT total, status INTO v_total, v_status FROM invoice WHERE invoice_id = p_invoice FOR UPDATE;
    IF v_status != 'DUE' THEN
      RAISE_APPLICATION_ERROR(-20704, 'PAY_CONFLICT: invoice ' || v_status);
    END IF;
    SELECT balance INTO v_bal FROM wallet_account WHERE user_id = p_user FOR UPDATE;
    IF v_bal < v_total THEN
      INSERT INTO payment (invoice_id, amount, method, status) VALUES (p_invoice, v_total, 'WALLET', 'FAILED')
      RETURNING payment_id INTO p_payment;
      UPDATE invoice SET status = 'FAILED' WHERE invoice_id = p_invoice;
      RAISE_APPLICATION_ERROR(-20705, 'INSUFFICIENT_FUNDS');
    END IF;
    SELECT NVL(MAX(seq_no),0)+1 INTO v_seq FROM wallet_ledger WHERE user_id = p_user;
    INSERT INTO payment (invoice_id, amount, method, status) VALUES (p_invoice, v_total, 'WALLET', 'SUCCESS')
    RETURNING payment_id INTO p_payment;
    INSERT INTO wallet_ledger (user_id, seq_no, kind, amount, balance_after, payment_id, note)
    VALUES (p_user, v_seq, 'PAYMENT', -v_total, v_bal - v_total, p_payment, 'Invoice ' || p_invoice);
    UPDATE wallet_account SET balance = v_bal - v_total, updated_at = SYSTIMESTAMP WHERE user_id = p_user;
    UPDATE invoice SET status = 'PAID' WHERE invoice_id = p_invoice;
    audit_pkg.log(p_user, 'INVOICE', TO_CHAR(p_invoice), 'PAY', 'DUE', 'PAID');
  END;
END billing_pkg;
/

-- ========================== MAINTENANCE_PKG =================================
CREATE OR REPLACE PACKAGE maintenance_pkg AS
  PROCEDURE report_fault(p_ref IN VARCHAR2 DEFAULT NULL, p_cp IN NUMBER DEFAULT NULL,
    p_code IN VARCHAR2, p_sev IN VARCHAR2 DEFAULT 'WARN', p_src IN VARCHAR2 DEFAULT 'OCPP',
    p_desc IN VARCHAR2 DEFAULT NULL, p_by IN NUMBER DEFAULT NULL, p_fault OUT NUMBER);
  PROCEDURE resolve_maintenance(p_record IN NUMBER, p_resolution IN VARCHAR2);
END maintenance_pkg;
/
CREATE OR REPLACE PACKAGE BODY maintenance_pkg AS
  PROCEDURE report_fault(p_ref IN VARCHAR2 DEFAULT NULL, p_cp IN NUMBER DEFAULT NULL,
    p_code IN VARCHAR2, p_sev IN VARCHAR2 DEFAULT 'WARN', p_src IN VARCHAR2 DEFAULT 'OCPP',
    p_desc IN VARCHAR2 DEFAULT NULL, p_by IN NUMBER DEFAULT NULL, p_fault OUT NUMBER) IS
  BEGIN
    INSERT INTO fault (connector_ref, cp_id, error_code, severity, source, description, reported_by)
    VALUES (p_ref, p_cp, p_code, p_sev, p_src, p_desc, p_by) RETURNING fault_id INTO p_fault;
    IF p_ref IS NOT NULL THEN
      DECLARE v_cp NUMBER := TO_NUMBER(REGEXP_SUBSTR(p_ref, '^[^:]+'));
              v_cn NUMBER := TO_NUMBER(REGEXP_SUBSTR(p_ref, '[^:]+$'));
      BEGIN
        UPDATE connector SET status='FAULTED', last_state_change_at=SYSTIMESTAMP
         WHERE cp_id=v_cp AND connector_no=v_cn;
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;
    audit_pkg.log(p_by, 'FAULT', TO_CHAR(p_fault), 'REPORT', NULL, p_code);
  END;
  PROCEDURE resolve_maintenance(p_record IN NUMBER, p_resolution IN VARCHAR2) IS
    v_fault NUMBER; v_ref VARCHAR2(72);
  BEGIN
    UPDATE maintenance_record SET resolved_at = SYSTIMESTAMP, resolution = p_resolution
     WHERE record_id = p_record RETURNING fault_id INTO v_fault;
    UPDATE fault SET cleared_at = SYSTIMESTAMP WHERE fault_id = v_fault RETURNING connector_ref INTO v_ref;
    IF v_ref IS NOT NULL THEN
      DECLARE v_cp NUMBER := TO_NUMBER(REGEXP_SUBSTR(v_ref, '^[^:]+'));
              v_cn NUMBER := TO_NUMBER(REGEXP_SUBSTR(v_ref, '[^:]+$'));
      BEGIN
        UPDATE connector SET status='AVAILABLE', last_state_change_at=SYSTIMESTAMP
         WHERE cp_id=v_cp AND connector_no=v_cn AND status='FAULTED';
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;
    audit_pkg.log(NULL, 'MAINTENANCE_RECORD', TO_CHAR(p_record), 'RESOLVE', NULL, p_resolution);
  END;
END maintenance_pkg;
/

-- ============================== SEED_PKG ====================================
CREATE OR REPLACE PACKAGE seed_pkg AS
  PROCEDURE ensure_lookups;
END seed_pkg;
/
CREATE OR REPLACE PACKAGE BODY seed_pkg AS
  PROCEDURE ensure_lookups IS BEGIN NULL; END;
END seed_pkg;
/
COMMIT;
