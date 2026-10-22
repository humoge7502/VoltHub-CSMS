-- ============================================================================
-- VoltHub CSMS - V008 tariff midnight close (BUG-008 follow-up)
--
-- A tariff band may close at midnight. Oracle TIMESTAMP cannot hold 24:00, so
-- the canonical representation is the NEXT midnight (TRUNC(end_time)+1). Older
-- builds stored 23:59:59 or 23:59, which left the final second/minute of the
-- day priced by NO band: a session billed in that window failed with
-- -20701 NO_TARIFF_BAND (and the local engine did the same).
--
-- Two fixes, both idempotent:
--   1. Normalize every near-midnight close to the next midnight.
--   2. Recompile tariff_pkg.resolve_band_price so 00:00 / 23:59:59 closes are
--      treated as end-of-day. Bands that already hold the next midnight keep
--      working because the comparison is half-open [start, end).
--
-- Money path only; no schema shape changes.
-- ============================================================================

UPDATE tariff_band
   SET end_time = TRUNC(CAST(end_time AS DATE)) + 1
 WHERE CAST(end_time AS DATE) - TRUNC(CAST(end_time AS DATE)) >= 86399/86400;

COMMIT;

CREATE OR REPLACE PACKAGE BODY tariff_pkg AS
  FUNCTION resolve_band_price(p_plan IN NUMBER, p_at IN TIMESTAMP) RETURN NUMBER IS
    v_price NUMBER; v_dow VARCHAR2(3); v_frac NUMBER;
  BEGIN
    v_dow := TO_CHAR(p_at, 'DY', 'NLS_DATE_LANGUAGE=AMERICAN');
    -- BUG-008: half-open [start, end) to match the JS resolver (mins >= start AND mins < end).
    v_frac := CAST(p_at AS DATE) - TRUNC(CAST(p_at AS DATE));
    -- A band may close at midnight: stored as 00:00 on a TIMESTAMP or, in older
    -- data, clamped to 23:59:59. Both mean end-of-day (fraction 1), so the last
    -- second of the day can never fall through to NO_TARIFF_BAND.
    -- B2G-011/D-03: deterministic on overlap - specific WEEKDAY/WEEKEND beats ALL.
    SELECT price_per_kwh INTO v_price FROM tariff_band
     WHERE plan_id = p_plan
       AND (day_scope = 'ALL' OR (day_scope='WEEKDAY' AND v_dow NOT IN ('SAT','SUN'))
            OR (day_scope='WEEKEND' AND v_dow IN ('SAT','SUN')))
       AND v_frac >= (CAST(start_time AS DATE) - TRUNC(CAST(start_time AS DATE)))
       AND v_frac <  CASE
             WHEN CAST(end_time AS DATE) - TRUNC(CAST(end_time AS DATE)) = 0
               OR CAST(end_time AS DATE) - TRUNC(CAST(end_time AS DATE)) >= 86399/86400
             THEN 1
             ELSE CAST(end_time AS DATE) - TRUNC(CAST(end_time AS DATE))
           END
     ORDER BY CASE day_scope WHEN 'ALL' THEN 0 ELSE 1 END
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
