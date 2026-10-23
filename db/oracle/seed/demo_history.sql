-- ============================================================================
-- VoltHub CSMS — demo history (optional, idempotent-by-guard)
--
-- The base seed (seed.sql) creates the *shape* of the system: users, stations,
-- hardware, tariffs, one fault story. It deliberately creates no sessions, so a
-- fresh install has an empty History/Invoices surface until a simulator runs.
--
-- This script fills the last 30 days with plausible, backdated sessions for the
-- three seeded drivers, so the driver surfaces (history, invoices, wallet ledger)
-- and the operator rollups have something real to show on first boot.
--
-- It is NOT a shortcut around the packages: invoices are written in the same
-- shape BILLING_PKG produces (ENERGY line from the resolved band + SESSION_FEE),
-- and payments always append a wallet_ledger row before touching the balance —
-- the invariant `balance = last balance_after` is asserted at the end.
--
-- Re-runnable: it exits early if any session already exists for driver 4..6 with
-- stop_reason = 'SEED_HISTORY'.
--
--   docker exec -i volthub-oracle sqlplus -S volthub/volthub_dev_pwd@localhost/freepdb1 @/tmp/demo_history.sql
-- ============================================================================
SET DEFINE OFF
SET SERVEROUTPUT ON

DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM charging_session WHERE stop_reason = 'SEED_HISTORY';
  IF v_exists > 0 THEN
    DBMS_OUTPUT.PUT_LINE('demo history already present (' || v_exists || ' sessions) — skipping');
    RETURN;
  END IF;
END;
/

DECLARE
  -- deterministic pseudo-randomness so two runs of a fresh DB look the same
  v_seed   NUMBER;
  v_users  SYS.ODCINUMBERLIST := SYS.ODCINUMBERLIST(4, 5, 6); -- karthik, divya, rohan
  v_bals   SYS.ODCINUMBERLIST := SYS.ODCINUMBERLIST(20, 2500, 2500);
  v_uid    NUMBER;
  v_bal    NUMBER;
  v_sid    NUMBER;
  v_inv    NUMBER;
  v_pay    NUMBER;
  v_seq    NUMBER;
  v_cp     NUMBER;
  v_no     NUMBER;
  v_plan   NUMBER;
  v_start  TIMESTAMP(6);
  v_end    TIMESTAMP(6);
  v_dur    NUMBER;
  v_kwh    NUMBER;
  v_price  NUMBER;
  v_fee    NUMBER;
  v_amt    NUMBER;
  v_n      NUMBER;
  v_hour   NUMBER;
  v_mk     NUMBER;
  v_veh    NUMBER;
  v_rating NUMBER;
  v_ok     NUMBER;
BEGIN
  DBMS_RANDOM.SEED(42);

  -- ---- vehicles (one per driver, both connector standards) ----
  FOR u IN 1..3 LOOP
    INSERT INTO vehicle (user_id, nickname, make, model, battery_kwh, is_default)
    VALUES (v_users(u), 'Daily drive',
            CASE u WHEN 1 THEN 'Tata' WHEN 2 THEN 'MG' ELSE 'Hyundai' END,
            CASE u WHEN 1 THEN 'Nexon EV' WHEN 2 THEN 'ZS EV' ELSE 'Kona Electric' END,
            CASE u WHEN 1 THEN 40.5 WHEN 2 THEN 50.3 ELSE 39.2 END, 'Y')
    RETURNING vehicle_id INTO v_veh;
    INSERT INTO vehicle_standard_support (vehicle_id, standard_id) VALUES (v_veh, 1);
    INSERT INTO vehicle_standard_support (vehicle_id, standard_id) VALUES (v_veh, 2);
  END LOOP;

  -- ---- 66 sessions over the last 30 days ----
  FOR i IN 1..66 LOOP
    -- driver: divya gets the most history (she is the demo login)
    DECLARE
      v_pick NUMBER := DBMS_RANDOM.VALUE;
    BEGIN
      IF v_pick < 0.5 THEN v_uid := 5;
      ELSIF v_pick < 0.78 THEN v_uid := 6;
      ELSE v_uid := 4;
      END IF;
    END;

    -- connector: city plans for stations 1-3, highway plan for station 4
    v_cp := 1 + FLOOR(DBMS_RANDOM.VALUE * 8);
    v_no := 1 + FLOOR(DBMS_RANDOM.VALUE * 2);
    v_plan := CASE WHEN v_cp >= 7 THEN 3 ELSE 2 END;

    -- start: 0..29 days ago, weighted towards the evening peak
    v_start := SYSTIMESTAMP - NUMTODSINTERVAL(FLOOR(DBMS_RANDOM.VALUE * 30), 'DAY')
                           - NUMTODSINTERVAL(FLOOR(DBMS_RANDOM.VALUE * 24), 'HOUR');
    v_dur   := 25 + FLOOR(DBMS_RANDOM.VALUE * 95);          -- 25..120 min
    v_end   := v_start + NUMTODSINTERVAL(v_dur, 'MINUTE');
    v_kwh   := ROUND(6 + DBMS_RANDOM.VALUE * 32, 3);        -- 6..38 kWh

    INSERT INTO charging_session
      (user_id, vehicle_id, connector_ref, cp_id, connector_no, tariff_plan_id, id_tag,
       state, billing_state, started_at, ended_at, start_meter_kwh, end_meter_kwh, energy_kwh, stop_reason)
    VALUES
      (v_uid, (SELECT MAX(vehicle_id) FROM vehicle WHERE user_id = v_uid),
       v_cp || ':' || v_no, v_cp, v_no, v_plan, 'TAG-' || v_uid,
       'COMPLETED', 'UNBILLED', v_start, v_end, 0, v_kwh, v_kwh, 'SEED_HISTORY')
    RETURNING session_id INTO v_sid;

    -- meter readings: one every ~5 minutes, monotone
    v_n := GREATEST(3, FLOOR(v_dur / 5));
    FOR q IN 1..v_n LOOP
      v_mk := ROUND(v_kwh * q / v_n, 3);
      INSERT INTO meter_reading (session_id, seq_no, taken_at, meter_kwh, power_kw, voltage_v, current_a, source)
      VALUES (v_sid, q, v_start + NUMTODSINTERVAL(v_dur * q / v_n, 'MINUTE'), v_mk,
              ROUND(18 + DBMS_RANDOM.VALUE * 40, 1), 400, 80, 'SYNTHETIC');
    END LOOP;

    -- bill: same shape as BILLING_PKG (band price at start + plan fee)
    v_hour := TO_NUMBER(TO_CHAR(v_start, 'HH24'));
    IF v_plan = 3 THEN
      v_price := CASE WHEN v_hour BETWEEN 18 AND 21 THEN 31 ELSE 25 END;
      v_fee   := 49;
    ELSE
      v_price := CASE WHEN v_hour BETWEEN 18 AND 21 THEN 28 ELSE 22 END;
      v_fee   := 20;
    END IF;
    v_amt := ROUND(v_kwh * v_price + v_fee, 2);

    INSERT INTO invoice (session_id, tariff_plan_id, status, total, currency, issued_at)
    VALUES (v_sid, v_plan, 'DUE', v_amt, 'INR', v_end)
    RETURNING invoice_id INTO v_inv;

    INSERT INTO invoice_line (invoice_id, line_no, kind, description, quantity, unit, unit_price, amount)
    VALUES (v_inv, 1, 'ENERGY', 'Energy ' || v_kwh || ' kWh @ Rs.' || v_price, v_kwh, 'kWh', v_price,
            ROUND(v_kwh * v_price, 2));
    INSERT INTO invoice_line (invoice_id, line_no, kind, description, quantity, unit, unit_price, amount)
    VALUES (v_inv, 2, 'SESSION_FEE', 'Session fee', 1, NULL, v_fee, v_fee);

    UPDATE charging_session SET billing_state = 'BILLED' WHERE session_id = v_sid;

    -- pay 72% of them, only when the balance covers it (karthik keeps his
    -- insufficient-funds story: his balance is 20 and his invoices stay DUE)
    v_bal := CASE v_uid WHEN 4 THEN v_bals(1) WHEN 5 THEN v_bals(2) ELSE v_bals(3) END;
    IF DBMS_RANDOM.VALUE < 0.72 AND v_bal >= v_amt THEN
      INSERT INTO payment (invoice_id, amount, method, status, reference, created_at)
      VALUES (v_inv, v_amt, 'WALLET', 'SUCCESS', 'SEED-' || v_inv, v_end)
      RETURNING payment_id INTO v_pay;

      SELECT NVL(MAX(seq_no), 0) + 1 INTO v_seq FROM wallet_ledger WHERE user_id = v_uid;
      v_bal := v_bal - v_amt;
      INSERT INTO wallet_ledger (user_id, seq_no, kind, amount, balance_after, payment_id, note, created_at)
      VALUES (v_uid, v_seq, 'PAYMENT', -v_amt, v_bal, v_pay, 'Invoice ' || v_inv, v_end);
      UPDATE wallet_account SET balance = v_bal, updated_at = v_end WHERE user_id = v_uid;
      UPDATE invoice SET status = 'PAID' WHERE invoice_id = v_inv;

      IF v_uid = 4 THEN v_bals(1) := v_bal; ELSIF v_uid = 5 THEN v_bals(2) := v_bal; ELSE v_bals(3) := v_bal; END IF;

      -- a third of paid sessions get a review
      IF DBMS_RANDOM.VALUE < 0.33 THEN
        v_rating := 3 + FLOOR(DBMS_RANDOM.VALUE * 3);
        INSERT INTO review (session_id, user_id, rating, comment_text, created_at)
        VALUES (v_sid, v_uid, LEAST(v_rating, 5),
                CASE WHEN v_rating >= 5 THEN 'Plugged in, walked away, done in 40 minutes.'
                     ELSE 'Worked fine; the bay was busy at peak.' END, v_end);
      END IF;
    END IF;

    IF v_uid = 4 THEN v_bals(1) := v_bal; ELSIF v_uid = 5 THEN v_bals(2) := v_bal; ELSE v_bals(3) := v_bal; END IF;
  END LOOP;

  -- ---- notifications for divya (the demo driver) ----
  INSERT INTO notification (user_id, kind, title, payload, is_read, created_at)
  VALUES (5, 'SESSION', 'Charging complete — 28.4 kWh', '{"session":"latest","kwh":28.4}', 'N', SYSTIMESTAMP - INTERVAL '2' HOUR);
  INSERT INTO notification (user_id, kind, title, payload, is_read, created_at)
  VALUES (5, 'INVOICE', 'Invoice settled from wallet', '{"channel":"wallet"}', 'N', SYSTIMESTAMP - INTERVAL '1' DAY);
  INSERT INTO notification (user_id, kind, title, payload, is_read, created_at)
  VALUES (5, 'RESERVATION', 'Your bay is held for 15 more minutes', '{"grace_min":15}', 'Y', SYSTIMESTAMP - INTERVAL '3' DAY);
  INSERT INTO notification (user_id, kind, title, payload, is_read, created_at)
  VALUES (5, 'WALLET', 'Wallet topped up ₹1,000', '{"amount":1000}', 'Y', SYSTIMESTAMP - INTERVAL '5' DAY);

  -- ---- demo float ----
  -- The loop above spends real balances on real invoices, which can leave the demo
  -- driver at ₹13 and unable to show a settlement. Keep divya and rohan solvent with
  -- one honest TOPUP row (never a silent balance edit: the ledger stays the truth).
  -- karthik (index 1) is deliberately left at ₹20 — he is the insufficient-funds story.
  FOR u IN 2..3 LOOP
    SELECT balance INTO v_bal FROM wallet_account WHERE user_id = v_users(u);
    IF v_bal < 800 THEN
      SELECT NVL(MAX(seq_no), 0) + 1 INTO v_seq FROM wallet_ledger WHERE user_id = v_users(u);
      INSERT INTO wallet_ledger (user_id, seq_no, kind, amount, balance_after, note, created_at)
      VALUES (v_users(u), v_seq, 'TOPUP', 2500 - v_bal, 2500, 'demo float', SYSTIMESTAMP);
      UPDATE wallet_account SET balance = 2500, updated_at = SYSTIMESTAMP WHERE user_id = v_users(u);
    END IF;
  END LOOP;

  COMMIT;
END;
/

-- ---- invariant: every wallet balance equals its newest ledger balance_after ----
DECLARE
  v_bad NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_bad
    FROM wallet_account w
   WHERE w.balance <> NVL((SELECT l.balance_after FROM wallet_ledger l
                            WHERE l.user_id = w.user_id
                            ORDER BY l.seq_no DESC FETCH FIRST 1 ROWS ONLY), w.balance);
  IF v_bad > 0 THEN
    RAISE_APPLICATION_ERROR(-20999, 'wallet ledger drift on ' || v_bad || ' account(s)');
  END IF;
  DBMS_OUTPUT.PUT_LINE('invariant ok: wallet balances match the ledger tail');
END;
/
EXIT
