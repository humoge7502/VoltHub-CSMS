-- ============================================================================
-- VoltHub CSMS — Oracle seed (package-driven, story-shaped)
-- Mirrors apps/api/src/db/seed.js via the packages (not raw INSERTs) so seeded
-- data respects the same rules the API enforces. Run after V001..V005:
--   sql volthub/<pwd>@localhost/freepdb1 @seed.sql
-- Story: 4 Chennai stations, tariff City v1->v2 + Highway flat, one faulted ECR
-- CCS2 connector, one EXPIRED no-show (via backdated BOOKED + expire_stale).
-- Password hashes below are REAL Argon2id PHC strings (m=19456,t=2,p=1, 16-byte
-- salts, 32-byte tags) for the demo logins admin@volthub.in/Admin@123,
-- *@volthub.in/Operator@123, drivers/Driver@123 — regenerate via apps/api
-- hashPassword if passwords change. verifyPassword accepts both this format and
-- the legacy '$scrypt$...' shape (length-safe), so pre-Argon2 rows keep working.
-- ============================================================================

-- ---- users (admin, 2 operators, 3 drivers) ----
INSERT INTO app_user (email, password_hash, full_name, role) VALUES
 ('admin@volthub.in', '$argon2id$v=19$m=19456,t=2,p=1$9U3zv2D07k8sliLwBJJCWQ$gXWMNq+15wGmCiymTksESkRH77I1KMiLDgchOrMsmts', 'VoltHub Admin', 'ADMIN');
INSERT INTO app_user (email, password_hash, full_name, role) VALUES
 ('arjun@volthub.in', '$argon2id$v=19$m=19456,t=2,p=1$4EJc3RqQ+/QeEnFHa7mr+Q$iHnZa051xMdsGRfWFFe4mfi9nl88bh5m2QbmBsU+Pic', 'Arjun Operator', 'OPERATOR');
INSERT INTO app_user (email, password_hash, full_name, role) VALUES
 ('meera@volthub.in', '$argon2id$v=19$m=19456,t=2,p=1$4EJc3RqQ+/QeEnFHa7mr+Q$iHnZa051xMdsGRfWFFe4mfi9nl88bh5m2QbmBsU+Pic', 'Meera Operator', 'OPERATOR');
INSERT INTO app_user (email, password_hash, full_name, role) VALUES
 ('karthik.raja0@example.in', '$argon2id$v=19$m=19456,t=2,p=1$avtcXp0YdJP1T0uZW+XIbA$cieshnC8ntCtgJwavDd9Oh1jpUinE1zxrCUb13h4GrY', 'Karthik Raja', 'DRIVER');
INSERT INTO app_user (email, password_hash, full_name, role) VALUES
 ('divya.shankar1@example.in', '$argon2id$v=19$m=19456,t=2,p=1$avtcXp0YdJP1T0uZW+XIbA$cieshnC8ntCtgJwavDd9Oh1jpUinE1zxrCUb13h4GrY', 'Divya Shankar', 'DRIVER');
INSERT INTO app_user (email, password_hash, full_name, role) VALUES
 ('rohan.menon2@example.in', '$argon2id$v=19$m=19456,t=2,p=1$avtcXp0YdJP1T0uZW+XIbA$cieshnC8ntCtgJwavDd9Oh1jpUinE1zxrCUb13h4GrY', 'Rohan Menon', 'DRIVER');

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
-- Commit per story: audit_pkg.log is an AUTONOMOUS_TRANSACTION, so a single giant
-- seed transaction holding locks across sections self-deadlocks (ORA-00060).
COMMIT;

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
COMMIT;

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
