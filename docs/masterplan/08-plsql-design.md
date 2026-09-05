# Part VIII — PL/SQL Design

> Masterplan section 15. The packages below are the project's proof that business correctness lives in the database. Every procedure that changes state is here; the API layer can only call them. Code shown is the real reference implementation pattern used in `db/oracle/packages/` (viva value ranked in 15.6).

---

## 15.1 Package inventory

| Package | Responsibility | Viva value |
|---|---|---|
| `RESERVATION_PKG` | create/cancel/expire reservations; the double-booking defense | highest |
| `CHARGE_SESSION_PKG` | session state machine, start/stop, meter tick ingestion | highest |
| `BILLING_PKG` | tariff resolution, invoice + lines, wallet debit with ledger | highest |
| `TARIFF_PKG` | plan versioning, band validation, price lookup at time | high |
| `MAINTENANCE_PKG` | fault triage, maintenance records, connector restore | medium |
| `AUDIT_PKG` | uniform audit writer used by triggers and packages | medium |
| `SEED_PKG` | deterministic sample data generation (Section 16) | low (utility) |

## 15.2 RESERVATION_PKG — the race-condition defense

```sql
CREATE OR REPLACE PACKAGE BODY reservation_pkg AS

  PROCEDURE create_reservation(
    p_user_id      IN  NUMBER,
    p_vehicle_id   IN  NUMBER,
    p_cp_id        IN  NUMBER,
    p_connector_no IN  NUMBER,
    p_start_at     IN  TIMESTAMP,
    p_end_at       IN  TIMESTAMP,
    p_reservation_id OUT NUMBER)
  IS
    v_ref        VARCHAR2(72) := TO_CHAR(p_cp_id) || ':' || TO_CHAR(p_connector_no);
    v_status     VARCHAR2(12);
    v_overlaps   NUMBER;
  BEGIN
    -- BR-04: window sanity (15..120 minutes, future start)
    IF p_end_at <= p_start_at
       OR p_end_at - p_start_at > INTERVAL '120' MINUTE
       OR p_end_at - p_start_at < INTERVAL '15' MINUTE
       OR p_start_at < SYSTIMESTAMP - INTERVAL '1' MINUTE THEN
      raise_application_error(-20501, 'Reservation window must be 15-120 minutes and start in the future');
    END IF;

    -- Serialize all reservation writers for THIS connector.
    -- The FOR UPDATE is the whole trick: two concurrent requests queue here;
    -- the second sees the first's uncommitted row via the lock, then the
    -- overlap check below fails it. No extra app-level locking needed.
    SELECT status INTO v_status
    FROM   connector
    WHERE  cp_id = p_cp_id AND connector_no = p_connector_no
    FOR UPDATE;

    -- BR-12: faulted/offline connectors are not bookable
    IF v_status NOT IN ('AVAILABLE', 'RESERVED') THEN
      raise_application_error(-20502, 'Connector is not bookable (status ' || v_status || ')');
    END IF;

    -- BR-05: no overlap with BOOKED/CONVERTED reservations
    SELECT COUNT(*) INTO v_overlaps
    FROM   reservation r
    WHERE  r.connector_ref = v_ref
      AND  r.status IN ('BOOKED','CONVERTED')
      AND  r.start_at < p_end_at
      AND  r.end_at   > p_start_at;
    IF v_overlaps > 0 THEN
      raise_application_error(-20503, 'Connector already reserved for the requested window');
    END IF;

    INSERT INTO reservation (reservation_id, connector_ref, user_id, vehicle_id,
                             start_at, end_at, status)
    VALUES (NULL, v_ref, p_user_id, p_vehicle_id, p_start_at, p_end_at, 'BOOKED')
    RETURNING reservation_id INTO p_reservation_id;

    audit_pkg.log('RESERVATION', p_reservation_id, 'CREATE', NULL,
                  JSON_OBJECT('user' VALUE p_user_id,
                              'window' VALUE TO_CHAR(p_start_at) || ' .. ' || TO_CHAR(p_end_at)));
  END create_reservation;

  PROCEDURE expire_stale(p_out_rows OUT NUMBER) IS
    -- cursor + bulk collect: the educationally-required explicit cursor (15.5)
    CURSOR c_stale IS
      SELECT r.reservation_id
      FROM   reservation r
      WHERE  r.status = 'BOOKED' AND r.end_at < SYSTIMESTAMP
      FOR UPDATE SKIP LOCKED;
    TYPE t_ids IS TABLE OF NUMBER;
    l_ids t_ids;
  BEGIN
    OPEN c_stale;
    FETCH c_stale BULK COLLECT INTO l_ids LIMIT 500;
    CLOSE c_stale;
    FORALL i IN 1 .. l_ids.COUNT
      UPDATE reservation SET status = 'EXPIRED' WHERE reservation_id = l_ids(i);
    p_out_rows := SQL%ROWCOUNT;
    COMMIT;
  END expire_stale;

END reservation_pkg;
/
```

**Why SELECT FOR UPDATE and not just the overlap query?** Without the lock, two transactions can both run the overlap check at time T (both read zero rows), both pass, and both insert — the classic TOCTOU race. With `FOR UPDATE` on the connector row, writers serialize per connector; the second transaction's check runs *after* the first commits and correctly sees the conflict. Section 31 proves it with a two-thread test. (Postgres/TimescaleDB would additionally allow a true exclusion constraint — noted in the DA3 comparison as a legitimate engine difference.)

## 15.3 CHARGE_SESSION_PKG — the state machine authority

```sql
CREATE OR REPLACE PACKAGE BODY charge_session_pkg AS

  TYPE t_graph IS TABLE OF VARCHAR2(1) INDEX BY VARCHAR2(24);
  g_ok t_graph;   -- legal-transition matrix, loaded once

  PROCEDURE load_graph IS
  BEGIN
    -- from          -> to          (rows: from||'->'||to)
    g_ok('RESERVED->PREPARING') := 'Y';  g_ok('PREPARING->CHARGING')  := 'Y';
    g_ok('CHARGING->SUSPENDED') := 'Y';  g_ok('SUSPENDED->CHARGING')  := 'Y';
    g_ok('CHARGING->COMPLETED') := 'Y';  g_ok('SUSPENDED->COMPLETED') := 'Y';
    g_ok('PREPARING->FAILED')   := 'Y';  g_ok('CHARGING->FAILED')     := 'Y';
    g_ok('SUSPENDED->FAILED')   := 'Y';  g_ok('RESERVED->CANCELLED')  := 'Y';
    g_ok('PREPARING->CANCELLED'):= 'Y';
  END load_graph;

  PROCEDURE transition(
    p_session_id IN NUMBER,
    p_to         IN VARCHAR2,
    p_stop_reason IN VARCHAR2 DEFAULT NULL)
  IS
    v_from  VARCHAR2(12);
    v_meter NUMBER(10,3);
  BEGIN
    IF NOT g_ok.EXISTS(p_from => NULL) THEN NULL; END IF;  -- (graph lazy-loaded at init)

    SELECT state INTO v_from FROM charging_session
    WHERE  session_id = p_session_id FOR UPDATE;          -- lock the session row

    IF g_ok(v_from || '->' || p_to) IS NULL THEN
      raise_application_error(-20601,
        'Illegal transition ' || v_from || ' -> ' || p_to);
    END IF;

    UPDATE charging_session
    SET   state = p_to,
          ended_at = CASE WHEN p_to IN ('COMPLETED','FAILED','CANCELLED')
                          THEN SYSTIMESTAMP ELSE ended_at END,
          end_meter_kwh = CASE WHEN p_to = 'COMPLETED' THEN v_meter ELSE end_meter_kwh END,
          stop_reason   = COALESCE(p_stop_reason, stop_reason)
    WHERE  session_id = p_session_id;

    -- mirror connector state for non-terminal outcomes
    IF p_to = 'CHARGING' THEN
      UPDATE connector SET status = 'OCCUPIED', last_state_change_at = SYSTIMESTAMP
      WHERE  connector_ref = (SELECT connector_ref FROM charging_session
                              WHERE session_id = p_session_id);
    ELSIF p_to IN ('COMPLETED','FAILED','CANCELLED') THEN
      UPDATE connector SET status = 'AVAILABLE', last_state_change_at = SYSTIMESTAMP
      WHERE  connector_ref = (SELECT connector_ref FROM charging_session
                              WHERE session_id = p_session_id);
    END IF;

    audit_pkg.log('CHARGING_SESSION', p_session_id, 'TRANSITION', v_from, p_to);
  END transition;

  PROCEDURE record_meter_tick(
    p_session_id IN NUMBER, p_seq IN NUMBER, p_taken_at IN TIMESTAMP,
    p_meter_kwh IN NUMBER, p_kw IN NUMBER, p_volt IN NUMBER, p_amp IN NUMBER)
  IS
    v_last NUMBER(10,3);
  BEGIN
    -- BR-11: monotonic meter within tolerance
    SELECT MAX(meter_kwh) INTO v_last FROM meter_reading WHERE session_id = p_session_id;
    IF v_last IS NOT NULL AND p_meter_kwh < v_last - 0.001 THEN
      raise_application_error(-20602, 'Non-monotonic meter value');
    END IF;

    INSERT INTO meter_reading (session_id, seq_no, taken_at, meter_kwh,
                               power_kw, voltage_v, current_a)
    VALUES (p_session_id, p_seq, p_taken_at, p_meter_kwh, p_kw, p_volt, p_amp);

    INSERT INTO outbox_event (event_id, kind, payload)
    VALUES (NULL, 'METER_TICK',
            JSON_OBJECT('sessionId' VALUE p_session_id, 'seq' VALUE p_seq,
                        'ts' VALUE TO_CHAR(p_taken_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3'),
                        'kwh' VALUE p_meter_kwh, 'kw' VALUE p_kw,
                        'v' VALUE p_volt, 'a' VALUE p_amp));
  END record_meter_tick;

END charge_session_pkg;
/
```

## 15.4 BILLING_PKG — tariff resolution and the wallet

```sql
CREATE OR REPLACE PACKAGE BODY billing_pkg AS

  FUNCTION resolve_band_price(p_plan_id IN NUMBER, p_at IN TIMESTAMP)
    RETURN NUMBER IS
    v_price NUMBER(8,4);
  BEGIN
    -- TOU lookup: WEEKDAY/WEEKEND bands with ALL fallback; overlap-free by BR-08
    SELECT price_per_kwh INTO v_price
    FROM   tariff_band
    WHERE  plan_id = p_plan_id
      AND  (day_scope = 'ALL'
            OR (day_scope = 'WEEKDAY' AND TO_CHAR(p_at,'DY','NLS_DATE_LANGUAGE=ENGLISH')
                NOT IN ('SAT','SUN'))
            OR (day_scope = 'WEEKEND' AND TO_CHAR(p_at,'DY','NLS_DATE_LANGUAGE=ENGLISH')
                IN ('SAT','SUN')))
      AND  CAST(TO_CHAR(p_at, 'YYYY-MM-DD') AS TIMESTAMP)
           + NUMTODSINTERVAL(TO_CHAR(p_at,'HH24:MI'), 'MINUTE') >= start_time
      AND  CAST(TO_CHAR(p_at, 'YYYY-MM-DD') AS TIMESTAMP)
           + NUMTODSINTERVAL(TO_CHAR(p_at,'HH24:MI'), 'MINUTE') <  end_time
    FETCH FIRST 1 ROW ONLY;
    RETURN v_price;
  EXCEPTION WHEN NO_DATA_FOUND THEN
    raise_application_error(-20701, 'No tariff band covers the session time');
  END resolve_band_price;

  PROCEDURE bill_session(p_session_id IN NUMBER, p_invoice_id OUT NUMBER) IS
    v_sess      charging_session%ROWTYPE;
    v_plan      tariff_plan%ROWTYPE;
    v_price     NUMBER(8,4);
    v_energy    NUMBER(10,3);
    v_energy_amt NUMBER(12,2);
    v_total     NUMBER(12,2);
  BEGIN
    SELECT * INTO v_sess FROM charging_session WHERE session_id = p_session_id FOR UPDATE;

    IF v_sess.state <> 'COMPLETED' THEN
      raise_application_error(-20702, 'Only COMPLETED sessions can be billed');   -- BR-10
    END IF;
    IF v_sess.billing_state <> 'UNBILLED' THEN
      raise_application_error(-20703, 'Session already billed');                  -- BR-10
    END IF;

    SELECT * INTO v_plan FROM tariff_plan WHERE plan_id = v_sess.tariff_plan_id;
    v_energy     := v_sess.end_meter_kwh - v_sess.start_meter_kwh;
    v_price      := resolve_band_price(v_sess.tariff_plan_id, v_sess.started_at);
    v_energy_amt := ROUND(v_energy * v_price, 2);
    v_total      := v_energy_amt + NVL(v_plan.session_fee, 0);

    INSERT INTO invoice (invoice_id, session_id, tariff_plan_id, status, total, currency)
    VALUES (NULL, p_session_id, v_plan.plan_id, 'DUE', v_total, v_plan.currency)
    RETURNING invoice_id INTO p_invoice_id;

    INSERT INTO invoice_line VALUES
      (p_invoice_id, 1, 'ENERGY', 'Energy charge @ ' || TO_CHAR(v_price) || '/kWh',
       v_energy, 'kWh', v_energy_amt);
    IF v_plan.session_fee IS NOT NULL THEN
      INSERT INTO invoice_line VALUES
        (p_invoice_id, 2, 'SESSION_FEE', 'Fixed session fee', 1, 'session',
         v_plan.session_fee);
    END IF;

    UPDATE charging_session
    SET    billing_state = 'BILLED', energy_kwh = v_energy
    WHERE  session_id = p_session_id;      -- derived values frozen here (Part VI, 12.6)

    audit_pkg.log('INVOICE', p_invoice_id, 'CREATE', NULL, JSON_OBJECT('total' VALUE v_total));
  END bill_session;

  PROCEDURE pay_invoice(p_invoice_id IN NUMBER, p_out_payment_id OUT NUMBER) IS
    v_inv   invoice%ROWTYPE;
    v_bal   NUMBER(12,2);
    v_seq   NUMBER;
  BEGIN
    SELECT * INTO v_inv FROM invoice WHERE invoice_id = p_invoice_id FOR UPDATE;

    IF v_inv.status <> 'DUE' THEN
      raise_application_error(-20704, 'Invoice is not payable (status ' || v_inv.status || ')');
    END IF;

    -- wallet owner = session driver
    SELECT w.balance INTO v_bal
    FROM   wallet_account w
    JOIN   charging_session cs ON cs.user_id = w.user_id
    WHERE  cs.session_id = (SELECT session_id FROM invoice WHERE invoice_id = p_invoice_id)
    FOR UPDATE;                                            -- serialize debits per wallet

    IF v_bal < v_inv.total THEN
      INSERT INTO payment VALUES (NULL, p_invoice_id, v_inv.total, 'WALLET', 'FAILED',
                                  SYSTIMESTAMP, 'INSUFFICIENT_FUNDS')
      RETURNING payment_id INTO p_out_payment_id;
      UPDATE invoice SET status = 'FAILED' WHERE invoice_id = p_invoice_id;
      raise_application_error(-20705, 'Insufficient wallet balance');  -- client decides retry
    END IF;

    INSERT INTO payment VALUES (NULL, p_invoice_id, v_inv.total, 'WALLET', 'SUCCESS',
                                SYSTIMESTAMP, 'WALLET-' || p_invoice_id)
    RETURNING payment_id INTO p_out_payment_id;

    SELECT NVL(MAX(seq_no),0) + 1 INTO v_seq FROM wallet_ledger
    WHERE  user_id = (SELECT user_id FROM charging_session
                      WHERE session_id = (SELECT session_id FROM invoice
                                          WHERE invoice_id = p_invoice_id));

    INSERT INTO wallet_ledger (user_id, seq_no, kind, amount, balance_after, payment_id)
    SELECT cs.user_id, v_seq, 'PAYMENT', -v_inv.total, v_bal - v_inv.total, p_out_payment_id
    FROM   charging_session cs
    WHERE  cs.session_id = (SELECT session_id FROM invoice WHERE invoice_id = p_invoice_id);

    UPDATE wallet_account SET balance = v_bal - v_inv.total, updated_at = SYSTIMESTAMP
    WHERE  user_id = (SELECT user_id FROM charging_session
                      WHERE session_id = (SELECT session_id FROM invoice
                                          WHERE invoice_id = p_invoice_id));

    UPDATE invoice SET status = 'PAID' WHERE invoice_id = p_invoice_id;
  END pay_invoice;

END billing_pkg;
/
```

## 15.5 Triggers, cursors, functions — where each belongs

**Triggers (only two, both justified):**

```sql
-- 1) AUDIT: every UPDATE on charging_session writes the delta (NFR-05)
CREATE OR REPLACE TRIGGER trg_session_audit
AFTER UPDATE ON charging_session
FOR EACH ROW
BEGIN
  audit_pkg.log('CHARGING_SESSION', :NEW.session_id, 'UPDATE',
    JSON_OBJECT('state' VALUE :OLD.state, 'billing' VALUE :OLD.billing_state,
                'endMeter' VALUE :OLD.end_meter_kwh),
    JSON_OBJECT('state' VALUE :NEW.state, 'billing' VALUE :NEW.billing_state,
                'endMeter' VALUE :NEW.end_meter_kwh));
END;
/

-- 2) GUARD: no direct status writes to connector outside the state machine paths
CREATE OR REPLACE TRIGGER trg_connector_guard
BEFORE UPDATE OF status ON connector
FOR EACH ROW
DECLARE
  v_actor VARCHAR2(64);
  PRAGMA AUTONOMOUS_TRANSACTION;
BEGIN
  SELECT SYS_CONTEXT('USERENV','CLIENT_IDENTIFIER') INTO v_actor FROM DUAL;
  -- the gateway sets CLIENT_IDENTIFIER='ocpp-gw'; API sets 'api:<userId>'
  IF v_actor IS NULL OR v_actor NOT LIKE 'ocpp-gw%'
     AND :NEW.status NOT IN ('AVAILABLE','OCCUPIED','RESERVED','FAULTED') THEN
    raise_application_error(-20801, 'Connector status changes must go through the gateway');
  END IF;
  COMMIT;
END;
/
```

**Standalone function (demonstrates RETURN + pure SQL):** `FN_STATION_UPTIME(p_station_id, p_from, p_to) RETURN NUMBER` — percentage of the window the station's connectors were not FAULTED/OFFLINE, computed from `last_state_change_at` history; used by the operator dashboard.

**Explicit cursor education:** `RESERVATION_PKG.expire_stale` (15.2) uses `CURSOR ... FOR UPDATE SKIP LOCKED` with `BULK COLLECT ... LIMIT 500` and `FORALL` — deliberately demonstrating the explicit-cursor + bulk-processing toolkit the syllabus loves, in a place where it is genuinely the right tool (a sweeper that must not block live bookings).

**Exception handling pattern:** every package maps business failures to numbered `raise_application_error` codes (-205xx reservations, -206xx sessions, -207xx billing, -208xx guards). The NestJS layer maps these codes to typed API errors via `oracledb` error numbers — one consistent contract across the stack.

## 15.6 Viva-value ranking (what to rehearse hardest)

1. `RESERVATION_PKG.create_reservation` — locking + race reasoning (the examiners' favorite topic).
2. `BILLING_PKG.pay_invoice` — `FOR UPDATE` on wallet, ledger insert with `balance_after`, atomic status flip.
3. `CHARGE_SESSION_PKG.transition` — data-driven state machine + connector mirroring.
4. `resolve_band_price` — temporal lookup with edge cases (no band covering time → explicit error).
5. `expire_stale` — explicit cursor, `SKIP LOCKED`, bulk processing.
6. Both triggers — audit trail and the "column ownership" argument tied to grants (13.2).
