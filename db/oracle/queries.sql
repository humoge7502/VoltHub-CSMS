-- ============================================================================
-- VoltHub CSMS — Oracle query portfolio Q1-Q26 (masterplan §17)
-- Run against seeded VOLTHUB schema. All bind-based; no SELECT *.
-- ============================================================================

-- Q1 available connectors in bbox around VIT Chennai (12.97,80.06 ±0.15)
-- Uses v_connector_live.
SELECT connector_ref, station_name, standard_code, max_power_kw, connector_status
FROM v_connector_live
WHERE latitude BETWEEN 12.82 AND 13.12 AND longitude BETWEEN 79.91 AND 80.21
  AND connector_status = 'AVAILABLE' AND station_status = 'ACTIVE'
ORDER BY max_power_kw DESC FETCH FIRST 20 ROWS ONLY;

-- Q2 charge points + connector count per station
SELECT s.station_id, s.name, COUNT(DISTINCT cp.cp_id) AS points,
       COUNT(c.connector_no) AS connectors
FROM station s LEFT JOIN charge_point cp ON cp.station_id = s.station_id
LEFT JOIN connector c ON c.cp_id = cp.cp_id
GROUP BY s.station_id, s.name ORDER BY s.station_id;

-- Q3 driver last-10 sessions with invoice status (bind :uid)
SELECT cs.session_id, cs.connector_ref, cs.state, cs.energy_kwh, cs.started_at,
       i.status AS invoice_status, i.total
FROM charging_session cs LEFT JOIN invoice i ON i.session_id = cs.session_id
WHERE cs.user_id = :uid ORDER BY cs.started_at DESC FETCH FIRST 10 ROWS ONLY;

-- Q4 revenue per station MTD (encoded-key join cp_id||':%')
SELECT s.station_id, s.name, COUNT(cs.session_id) AS sessions,
       ROUND(SUM(i.total),2) AS revenue
FROM charging_session cs
JOIN charge_point cp ON cs.connector_ref LIKE cp.cp_id || ':%'
JOIN station s ON s.station_id = cp.station_id
JOIN invoice i ON i.session_id = cs.session_id AND i.status IN ('PAID','DUE')
WHERE cs.started_at >= TRUNC(SYSTIMESTAMP,'MM')
GROUP BY s.station_id, s.name ORDER BY revenue DESC;

-- Q5 stations with zero available connectors
SELECT s.station_id, s.name
FROM station s JOIN charge_point cp ON cp.station_id = s.station_id
JOIN connector c ON c.cp_id = cp.cp_id
GROUP BY s.station_id, s.name
HAVING SUM(CASE WHEN c.status='AVAILABLE' THEN 1 ELSE 0 END) = 0;

-- Q6 failed sessions with peak meter reading (scalar subquery)
SELECT cs.session_id, cs.connector_ref, cs.started_at,
       (SELECT MAX(meter_kwh) FROM meter_reading m WHERE m.session_id = cs.session_id) AS peak_kwh
FROM charging_session cs WHERE cs.state = 'FAILED' ORDER BY cs.started_at DESC;

-- Q7 repeat drivers (>=5 sessions)
SELECT u.user_id, u.email, COUNT(*) AS sessions
FROM charging_session cs JOIN app_user u ON u.user_id = cs.user_id
GROUP BY u.user_id, u.email HAVING COUNT(*) >= 5 ORDER BY sessions DESC;

-- Q8 fault backlog >48h with no maintenance record
SELECT f.fault_id, f.connector_ref, f.error_code, f.reported_at
FROM fault f WHERE f.cleared_at IS NULL
  AND f.reported_at < SYSTIMESTAMP - INTERVAL '48' HOUR
  AND NOT EXISTS (SELECT 1 FROM maintenance_record m WHERE m.fault_id = f.fault_id);

-- Q9 peak hours: hourly energy share with running pct (CTE + window)
WITH h AS (SELECT TO_CHAR(m.taken_at,'HH24') AS hh, SUM(m.meter_kwh) AS kwh
  FROM meter_reading m GROUP BY TO_CHAR(m.taken_at,'HH24'))
SELECT hh, kwh, ROUND(100*RATIO_TO_REPORT(kwh) OVER (),2) AS pct,
       ROUND(SUM(kwh) OVER (ORDER BY hh ROWS UNBOUNDED PRECEDING),1) AS cum_kwh
FROM h ORDER BY hh;

-- Q10 station utilization rank
SELECT s.station_id, s.name,
       ROUND(100*SUM(CASE WHEN c.status='OCCUPIED' THEN 1 ELSE 0 END)/COUNT(*),1) AS util_pct,
       RANK() OVER (ORDER BY SUM(CASE WHEN c.status='OCCUPIED' THEN 1 ELSE 0 END) DESC) AS rnk
FROM station s JOIN charge_point cp ON cp.station_id=s.station_id
JOIN connector c ON c.cp_id=cp.cp_id GROUP BY s.station_id, s.name;

-- Q11 MoM revenue growth (LAG)
WITH m AS (SELECT TRUNC(cs.started_at,'MM') AS mon, SUM(i.total) AS rev
  FROM charging_session cs JOIN invoice i ON i.session_id=cs.session_id
  WHERE i.status IN ('PAID','DUE') GROUP BY TRUNC(cs.started_at,'MM'))
SELECT mon, rev, LAG(rev) OVER (ORDER BY mon) AS prev,
       ROUND(100*(rev-LAG(rev) OVER (ORDER BY mon))/NULLIF(LAG(rev) OVER (ORDER BY mon),0),1) AS g_pct
FROM m ORDER BY mon;

-- Q12 7-day moving average sessions
WITH d AS (SELECT TRUNC(started_at) AS day, COUNT(*) AS n FROM charging_session GROUP BY TRUNC(started_at))
SELECT day, n, ROUND(AVG(n) OVER (ORDER BY day ROWS 6 PRECEDING),1) AS ma7 FROM d ORDER BY day;

-- Q13 concurrent sessions sweep-line (gaps-and-islands style)
WITH ev AS (
  SELECT started_at AS t, 1 AS d FROM charging_session
  UNION ALL SELECT ended_at AS t, -1 AS d FROM charging_session WHERE ended_at IS NOT NULL)
SELECT t, SUM(d) OVER (ORDER BY t ROWS UNBOUNDED PRECEDING) AS concurrent_now
FROM ev ORDER BY t FETCH FIRST 100 ROWS ONLY;

-- Q14 energy charged inside tariff bands (interval join)
SELECT b.plan_id, b.day_scope, COUNT(*) AS ticks, ROUND(SUM(m.power_kw)/12,2) AS est_kwh
FROM meter_reading m JOIN charging_session cs ON cs.session_id=m.session_id
JOIN tariff_band b ON b.plan_id=cs.tariff_plan_id
WHERE (CAST(m.taken_at AS DATE)-TRUNC(CAST(m.taken_at AS DATE)))
  BETWEEN (CAST(b.start_time AS DATE)-TRUNC(CAST(b.start_time AS DATE)))
  AND (CAST(b.end_time AS DATE)-TRUNC(CAST(b.end_time AS DATE)))
GROUP BY b.plan_id, b.day_scope;

-- Q15 keyset pagination: driver history page (binds :uid :cursor_ts :cursor_id)
SELECT session_id, started_at, energy_kwh FROM charging_session
WHERE user_id = :uid AND (started_at, session_id) < (:cursor_ts, :cursor_id)
ORDER BY started_at DESC, session_id DESC FETCH FIRST 20 ROWS ONLY;

-- Q16 cohort retention: % of first-week drivers active in week 4
WITH first AS (SELECT user_id, MIN(TRUNC(started_at,'IW')) AS w0 FROM charging_session GROUP BY user_id)
SELECT COUNT(*) AS cohort, SUM(CASE WHEN EXISTS (
  SELECT 1 FROM charging_session c2 WHERE c2.user_id=f.user_id
  AND TRUNC(c2.started_at,'IW')=f.w0+21) THEN 1 ELSE 0 END) AS retained_w4
FROM first f;

-- Q17 faults per 100 sessions per station
SELECT s.station_id, s.name, COUNT(DISTINCT cs.session_id) AS sess,
       COUNT(DISTINCT f.fault_id) AS faults,
       ROUND(100*COUNT(DISTINCT f.fault_id)/NULLIF(COUNT(DISTINCT cs.session_id),0),2) AS per100
FROM station s LEFT JOIN charge_point cp ON cp.station_id=s.station_id
LEFT JOIN charging_session cs ON cs.connector_ref LIKE cp.cp_id || ':%'
LEFT JOIN fault f ON f.connector_ref LIKE cp.cp_id || ':%'
GROUP BY s.station_id, s.name;

-- Q18 tariff version impact: avg invoice by plan version
SELECT t.group_id, t.version_no, COUNT(*) AS invoices, ROUND(AVG(i.total),2) AS avg_total
FROM invoice i JOIN tariff_plan t ON t.plan_id=i.tariff_plan_id
GROUP BY t.group_id, t.version_no ORDER BY t.group_id, t.version_no;

-- Q19 wallet ledger reconciliation drift (expect 0 rows)
SELECT w.user_id, w.balance,
       NVL((SELECT SUM(amount) FROM wallet_ledger l WHERE l.user_id=w.user_id),0) AS ledger_sum
FROM wallet_account w
WHERE w.balance != NVL((SELECT SUM(amount) FROM wallet_ledger l WHERE l.user_id=w.user_id),0);

-- Q20 idle-fee candidates: COMPLETED sessions with long plug-in tail
SELECT session_id, connector_ref, started_at, ended_at,
       ROUND((CAST(ended_at AS DATE)-CAST(started_at AS DATE))*24*60) AS mins
FROM charging_session WHERE state='COMPLETED'
AND (CAST(ended_at AS DATE)-CAST(started_at AS DATE))*24*60 > 240;

-- Q21 busiest connector per station (ROW_NUMBER partition)
WITH c AS (SELECT cs.connector_ref, COUNT(*) AS n,
  ROW_NUMBER() OVER (PARTITION BY cp.station_id ORDER BY COUNT(*) DESC) AS rn,
  cp.station_id FROM charging_session cs
  JOIN charge_point cp ON cs.connector_ref LIKE cp.cp_id || ':%' GROUP BY cs.connector_ref, cp.station_id)
SELECT station_id, connector_ref, n FROM c WHERE rn=1;

-- Q22 session duration quartiles (NTILE)
SELECT session_id, mins, NTILE(4) OVER (ORDER BY mins) AS quartile FROM (
  SELECT session_id, (CAST(NVL(ended_at,SYSTIMESTAMP) AS DATE)-CAST(started_at AS DATE))*24*60 AS mins
  FROM charging_session);

-- Q23 fault first-response hours
SELECT f.fault_id, f.reported_at, MIN(m.started_at) AS first_touch,
  ROUND((CAST(MIN(m.started_at) AS DATE)-CAST(f.reported_at AS DATE))*24,1) AS hrs
FROM fault f LEFT JOIN maintenance_record m ON m.fault_id=f.fault_id
GROUP BY f.fault_id, f.reported_at;

-- Q24 energy mix by connector standard (RATIO_TO_REPORT)
SELECT st.code, ROUND(SUM(cs.energy_kwh),1) AS kwh,
  ROUND(100*RATIO_TO_REPORT(SUM(cs.energy_kwh)) OVER (),1) AS pct
FROM charging_session cs JOIN connector c
  ON c.cp_id=TO_NUMBER(REGEXP_SUBSTR(cs.connector_ref,'^[0-9]+'))
 AND c.connector_no=TO_NUMBER(REGEXP_SUBSTR(cs.connector_ref,'[0-9]+$'))
JOIN connector_standard st ON st.standard_id=c.standard_id
WHERE cs.energy_kwh IS NOT NULL GROUP BY st.code;

-- Q25 double-booking proof (expect 0 rows; CI fails if any row)
SELECT r1.reservation_id AS a, r2.reservation_id AS b, r1.connector_ref
FROM reservation r1 JOIN reservation r2
  ON r2.connector_ref=r1.connector_ref AND r2.reservation_id>r1.reservation_id
 AND r2.status IN ('BOOKED','CONVERTED') AND r1.status IN ('BOOKED','CONVERTED')
 AND r2.start_at < r1.end_at AND r2.end_at > r1.start_at;

-- Q26 operator dashboard header (single DUAL round-trip)
SELECT (SELECT COUNT(*) FROM charging_session WHERE state IN ('PREPARING','CHARGING','SUSPENDED')) AS active,
       (SELECT COUNT(*) FROM connector WHERE status='AVAILABLE') AS available,
       (SELECT COUNT(*) FROM fault WHERE cleared_at IS NULL) AS open_faults,
       (SELECT NVL(SUM(total),0) FROM invoice WHERE TRUNC(issued_at)=TRUNC(SYSTIMESTAMP) AND status IN ('PAID','DUE')) AS revenue_today
FROM DUAL;
