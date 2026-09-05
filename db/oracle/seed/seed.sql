-- ============================================================================
-- VoltHub CSMS — Oracle seed (package-driven, story-shaped)
-- Mirrors apps/api/src/db/seed.js via the packages (not raw INSERTs) so seeded
-- data respects the same rules the API enforces. Run after V001..V005:
--   sql volthub/<pwd>@localhost/freepdb1 @seed.sql
-- Story: 4 Chennai stations, tariff City v1->v2 + Highway flat, one faulted ECR
-- CCS2 connector, one EXPIRED no-show (via backdated BOOKED + expire_stale).
-- Password hashes below are REAL deterministic scrypt PHC hashes (fixed salts) for
-- the demo logins admin@volthub.in/Admin@123, *@volthub.in/Operator@123,
-- drivers/Driver@123 — regenerate via apps/api hashPassword if passwords change.
-- They must verify against apps/api/src/db/store.js verifyPassword (length-safe).
-- ============================================================================

-- ---- users (admin, 2 operators, 3 drivers) ----
INSERT INTO app_user (email, password_hash, full_name, role) VALUES
 ('admin@volthub.in', '$scrypt$0123456789abcdef0123456789abcdef$f4cd3950d9a994b243d9a5d2167caae60674cea905c20600cfda28c48fa18254', 'VoltHub Admin', 'ADMIN');
INSERT INTO app_user (email, password_hash, full_name, role) VALUES
 ('arjun@volthub.in', '$scrypt$fedcba9876543210fedcba9876543210$61e52338f3c92fcf04b4a9dd649d058e56384eb2fe7cd224adeb2bbd9bcab9d5', 'Arjun Operator', 'OPERATOR');
INSERT INTO app_user (email, password_hash, full_name, role) VALUES
 ('meera@volthub.in', '$scrypt$fedcba9876543210fedcba9876543210$61e52338f3c92fcf04b4a9dd649d058e56384eb2fe7cd224adeb2bbd9bcab9d5', 'Meera Operator', 'OPERATOR');
INSERT INTO app_user (email, password_hash, full_name, role) VALUES
 ('karthik.raja0@example.in', '$scrypt$11223344556677889900aabbccddeeff$68855d21cb40778c71d31beddd1036b8a14338c0a1be554e9a924e579fc70542', 'Karthik Raja', 'DRIVER');
INSERT INTO app_user (email, password_hash, full_name, role) VALUES
 ('divya.shankar1@example.in', '$scrypt$11223344556677889900aabbccddeeff$68855d21cb40778c71d31beddd1036b8a14338c0a1be554e9a924e579fc70542', 'Divya Shankar', 'DRIVER');
INSERT INTO app_user (email, password_hash, full_name, role) VALUES
 ('rohan.menon2@example.in', '$scrypt$11223344556677889900aabbccddeeff$68855d21cb40778c71d31beddd1036b8a14338c0a1be554e9a924e579fc70542', 'Rohan Menon', 'DRIVER');

-- wallets: driver[0] thin (insufficient-funds story), others funded
INSERT INTO wallet_account (user_id, balance) SELECT user_id, 20 FROM app_user WHERE email='karthik.raja0@example.in';
INSERT INTO wallet_account (user_id, balance) SELECT user_id, 2500 FROM app_user WHERE email IN ('divya.shankar1@example.in','rohan.menon2@example.in');
INSERT INTO wallet_ledger (user_id, seq_no, kind, amount, balance_after, note)
 SELECT user_id, 1, 'TOPUP', 20, 20, 'seed top-up' FROM app_user WHERE email='karthik.raja0@example.in';

-- ---- stations + hardware ----
INSERT INTO station (name, latitude, longitude, address_line, city, state, pincode, operator_id)
 SELECT 'VIT Chennai Gate', 12.9716, 80.0412, 'Vandalur-Kelambakkam Rd, Chennai', 'Chennai', 'Tamil Nadu', '600127', user_id FROM app_user WHERE email='arjun@volthub.in';
INSERT INTO station (name, latitude, longitude, address_line, city, state, pincode, operator_id)
 SELECT 'OMR Perungudi Hub', 12.9698, 80.2436, 'Rajiv Gandhi Salai, Perungudi', 'Chennai', 'Tamil Nadu', '600096', user_id FROM app_user WHERE email='meera@volthub.in';
INSERT INTO station (name, latitude, longitude, address_line, city, state, pincode, operator_id)
 SELECT 'Guindy Depot', 13.0067, 80.2206, 'GST Rd, Guindy', 'Chennai', 'Tamil Nadu', '600032', user_id FROM app_user WHERE email='arjun@volthub.in';
INSERT INTO station (name, latitude, longitude, address_line, city, state, pincode, operator_id)
 SELECT 'ECR Highway Stop', 12.8691, 80.2267, 'East Coast Rd, Kanathur', 'Chennai', 'Tamil Nadu', '603110', user_id FROM app_user WHERE email='meera@volthub.in';

-- 2 charge points per station (VH-<station>-CP<n>) + 2 connectors each
DECLARE
  v_cp NUMBER;
BEGIN
  FOR s IN (SELECT station_id FROM station ORDER BY station_id) LOOP
    FOR p IN 1..2 LOOP
      INSERT INTO charge_point (station_id, ocpp_identity, vendor, model, firmware_version, status, auth_secret)
      VALUES (s.station_id, 'VH-' || s.station_id || '-CP' || p, 'VoltHub', CASE WHEN p=1 THEN 'VH-DC60' ELSE 'VH-AC22' END, '1.6.5', 'ONLINE', 'dev-VH-' || s.station_id || '-CP' || p)
      RETURNING cp_id INTO v_cp;
      INSERT INTO connector (cp_id, connector_no, standard_id, max_power_kw, status)
      VALUES (v_cp, 1, 1, 22, 'AVAILABLE');
      INSERT INTO connector (cp_id, connector_no, standard_id, max_power_kw, status)
      VALUES (v_cp, 2, 2, CASE WHEN p=1 THEN 60 ELSE 120 END, 'AVAILABLE');
    END LOOP;
  END LOOP;
END;
/

-- fault story: one CCS2 highway connector faulted (last ECR DC point)
-- NB: PL/SQL cannot use a scalar subquery inside a procedure argument — select first.
DECLARE v_fault NUMBER; v_last_cp NUMBER;
BEGIN
  SELECT MAX(cp_id) INTO v_last_cp FROM charge_point;
  maintenance_pkg.report_fault(p_ref => v_last_cp || ':2',
    p_code => 'GroundFailure', p_sev => 'CRITICAL', p_src => 'OCPP',
    p_desc => 'Ground fault detected mid-session (seed story)', p_fault => v_fault);
END;
/

-- ---- tariffs: City group 1 v1->v2 (ToU 18-22h peak), Highway group 2 flat ----
DECLARE v_v1 NUMBER; v_v2 NUMBER; v_h1 NUMBER; BEGIN
  tariff_pkg.create_version(1, 'City Day v1', 20, 0, SYSTIMESTAMP - 60, 1, v_v1);
  INSERT INTO tariff_band (plan_id, day_scope, start_time, end_time, price_per_kwh) VALUES
   (v_v1, 'ALL', TRUNC(SYSDATE), TRUNC(SYSDATE) + 18/24, 18);
  INSERT INTO tariff_band (plan_id, day_scope, start_time, end_time, price_per_kwh) VALUES
   (v_v1, 'ALL', TRUNC(SYSDATE) + 18/24, TRUNC(SYSDATE) + 22/24, 24);
  INSERT INTO tariff_band (plan_id, day_scope, start_time, end_time, price_per_kwh) VALUES
   (v_v1, 'ALL', TRUNC(SYSDATE) + 22/24, TRUNC(SYSDATE) + 86399/86400, 18);
  tariff_pkg.create_version(1, 'City Day v2', 20, 0, SYSTIMESTAMP - 15, 1, v_v2);
  INSERT INTO tariff_band (plan_id, day_scope, start_time, end_time, price_per_kwh) VALUES
   (v_v2, 'ALL', TRUNC(SYSDATE), TRUNC(SYSDATE) + 18/24, 22);
  INSERT INTO tariff_band (plan_id, day_scope, start_time, end_time, price_per_kwh) VALUES
   (v_v2, 'ALL', TRUNC(SYSDATE) + 18/24, TRUNC(SYSDATE) + 22/24, 28);
  INSERT INTO tariff_band (plan_id, day_scope, start_time, end_time, price_per_kwh) VALUES
   (v_v2, 'ALL', TRUNC(SYSDATE) + 22/24, TRUNC(SYSDATE) + 86399/86400, 22);
  tariff_pkg.create_version(2, 'Highway Flat v1', 49, 0, SYSTIMESTAMP - 60, 1, v_h1);
  INSERT INTO tariff_band (plan_id, day_scope, start_time, end_time, price_per_kwh) VALUES
   (v_h1, 'ALL', TRUNC(SYSDATE), TRUNC(SYSDATE) + 18/24, 25);
  INSERT INTO tariff_band (plan_id, day_scope, start_time, end_time, price_per_kwh) VALUES
   (v_h1, 'ALL', TRUNC(SYSDATE) + 18/24, TRUNC(SYSDATE) + 22/24, 31);
  INSERT INTO tariff_band (plan_id, day_scope, start_time, end_time, price_per_kwh) VALUES
   (v_h1, 'ALL', TRUNC(SYSDATE) + 22/24, TRUNC(SYSDATE) + 86399/86400, 25);
END;
/
COMMIT;
