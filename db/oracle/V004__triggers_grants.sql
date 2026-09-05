-- ============================================================================
-- VoltHub CSMS — V004 triggers + grants (Oracle 23ai)
-- ============================================================================

-- Only 2 triggers (masterplan §15.5): session audit + connector guard.
CREATE OR REPLACE TRIGGER trg_session_audit
AFTER UPDATE ON charging_session FOR EACH ROW
BEGIN
  IF :OLD.state != :NEW.state OR :OLD.billing_state != :NEW.billing_state THEN
    audit_pkg.log(NULL, 'CHARGING_SESSION', TO_CHAR(:NEW.session_id), 'TRANSITION',
      JSON_OBJECT('state' VALUE :OLD.state, 'billing' VALUE :OLD.billing_state),
      JSON_OBJECT('state' VALUE :NEW.state, 'billing' VALUE :NEW.billing_state));
  END IF;
END;
/

-- BR-07: connector status only via gateway/packages. API role cannot UPDATE.
-- Gateway sets CLIENT_IDENTIFIER='ocpp-gw'; packages run as definer and set 'pkg:<proc>'.
-- BUG-003 fix: allow-list (was: NULL identifier silently passed + only 'api:%' rejected).
CREATE OR REPLACE TRIGGER trg_connector_guard
BEFORE UPDATE OF status ON connector FOR EACH ROW
DECLARE v_ci VARCHAR2(64);
BEGIN
  v_ci := SYS_CONTEXT('USERENV','CLIENT_IDENTIFIER');
  IF v_ci IS NULL OR (v_ci != 'ocpp-gw' AND v_ci NOT LIKE 'pkg:%') THEN
    RAISE_APPLICATION_ERROR(-20801, 'CONNECTOR_GUARD: status via OCPP gateway/packages only (got ' || NVL(v_ci,'NULL') || ')');
  END IF;
END;
/

-- ---- least-privilege role for the API --------------------------------------
-- Re-runnable: drop if exists pattern for fresh containers.
BEGIN EXECUTE IMMEDIATE 'DROP ROLE volthub_app_role'; EXCEPTION WHEN OTHERS THEN
  IF SQLCODE != -01919 THEN RAISE; END IF; END;
/
CREATE ROLE volthub_app_role;
GRANT CONNECT TO volthub_app_role;
GRANT SELECT ON app_user TO volthub_app_role;
GRANT SELECT ON wallet_account TO volthub_app_role;
GRANT SELECT ON wallet_ledger TO volthub_app_role;
GRANT SELECT ON vehicle TO volthub_app_role;
GRANT SELECT ON vehicle_standard_support TO volthub_app_role;
GRANT SELECT ON station TO volthub_app_role;
GRANT SELECT ON station_amenity TO volthub_app_role;
GRANT SELECT ON charge_point TO volthub_app_role;
GRANT SELECT ON connector TO volthub_app_role;
GRANT SELECT ON tariff_plan TO volthub_app_role;
GRANT SELECT ON tariff_band TO volthub_app_role;
GRANT SELECT ON reservation TO volthub_app_role;
GRANT SELECT ON charging_session TO volthub_app_role;
GRANT SELECT ON meter_reading TO volthub_app_role;
GRANT SELECT ON invoice TO volthub_app_role;
GRANT SELECT ON invoice_line TO volthub_app_role;
GRANT SELECT ON payment TO volthub_app_role;
GRANT SELECT ON fault TO volthub_app_role;
GRANT SELECT ON maintenance_record TO volthub_app_role;
GRANT SELECT ON review TO volthub_app_role;
GRANT SELECT ON notification TO volthub_app_role;
-- API may insert/update business rows only through packages; direct DML limited:
GRANT INSERT, UPDATE ON reservation TO volthub_app_role;
GRANT INSERT, UPDATE ON charging_session TO volthub_app_role;
GRANT INSERT ON meter_reading TO volthub_app_role;
GRANT INSERT, UPDATE ON invoice TO volthub_app_role;
GRANT INSERT ON invoice_line TO volthub_app_role;
GRANT INSERT ON payment TO volthub_app_role;
GRANT INSERT, UPDATE ON vehicle TO volthub_app_role;
GRANT INSERT ON notification TO volthub_app_role;
GRANT INSERT ON fault TO volthub_app_role;
GRANT INSERT, UPDATE ON maintenance_record TO volthub_app_role;
-- No DELETE anywhere. No UPDATE/DELETE on ledger, audit, readings.
-- No direct UPDATE on connector.status / wallet_account.balance.
GRANT EXECUTE ON reservation_pkg TO volthub_app_role;
GRANT EXECUTE ON charge_session_pkg TO volthub_app_role;
GRANT EXECUTE ON billing_pkg TO volthub_app_role;
GRANT EXECUTE ON tariff_pkg TO volthub_app_role;
GRANT EXECUTE ON maintenance_pkg TO volthub_app_role;
GRANT SELECT ON v_connector_live TO volthub_app_role;
GRANT SELECT ON v_station_summary TO volthub_app_role;
GRANT SELECT ON mv_station_daily TO volthub_app_role;
COMMIT;
