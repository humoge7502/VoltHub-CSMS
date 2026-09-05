# Part IX — Sample Dataset Strategy and SQL Query Portfolio

> Masterplan sections 16–17. The dataset must make queries *interesting* (diurnal peaks, faults, abandoned reservations, price changes) and the query portfolio must read like evidence the schema was designed for real questions.

---

## 16. Sample Dataset Strategy

### 16.1 Principles

1. **Deterministic:** every generator takes a seed; the same seed reproduces the exact database on any laptop (NFR-08). Randomness lives in the generator, never in foreign-key integrity.
2. **Coherent:** meter ticks are consistent with session boundaries; invoices sum from tariff bands; reservation overlaps never exist; connector status history matches sessions. The generator calls the *same packages* the API uses — seed data is valid because it was born through the valid paths.
3. **Story-shaped:** the data encodes the demo narrative — an evening peak (18:00–21:00), a faulted CCS2 connector at a highway station, a price change mid-month (tariff v1 → v2), a no-show reservation, one wallet with insufficient funds.

### 16.2 Volumes (sized for meaningful analytics + snappy demo)

| Table | Rows | Rationale |
|---|---|---|
| APP_USER | 400 (drivers 360, operators 30, admins 10) | realistic operator assignment |
| VEHICLE (+support) | 520 (+1,100) | 1.3 vehicles/driver |
| STATION / AMENITIES | 24 (+120) | Chennai + OMR corridor spread |
| CHARGE_POINT / CONNECTOR | 48 / 96 | 2 cabinets, 2 connectors avg |
| TARIFF_PLAN / BAND | 9 versions / 30 bands | mid-month price change story |
| RESERVATION | 1,800 | incl. 60 no-shows, 40 cancellations |
| CHARGING_SESSION | 10,000 over 90 days | 110/day — enough for trends |
| METER_READING | ~600,000 | 60 ticks/session avg (5s sim ticks coalesced to 60s) |
| INVOICE / LINES / PAYMENT | 9,400 / 26,000 / 9,900 | 94% completion, includes failures |
| FAULT / MAINTENANCE | 260 / 180 | recurring fault at one connector |
| REVIEW / NOTIFICATION | 3,400 / 5,000 | ratings spread 1–5 |
| AUDIT_LOG / OUTBOX | ~800k / ~600k | full trail, unprocessed tail for DA3 demo |

Generation is a Node script (`scripts/seed/generate.ts`) that drives the packages via `node-oracledb` in controlled batches (fast), plus `SEED_PKG` PL/SQL for anything needing in-database coherence.

### 16.3 The diurnal model

Session starts follow a weighted hour-of-day curve (workplace morning bump 08–10, evening peak 18–21 at 2.5x base), weekends shifted later; session duration ~ Weibull(45 min, 1.6) clipped at 8h; energy = min(battery deficit, charger power x duration). This produces the utilization and peak-load shapes that make Section 17's analytical queries and DA3's load curves visibly "real".

---

## 17. SQL Query Portfolio

Queries Q1–Q26, graded and each with its real-world purpose. All run on the Part V schema.

### Tier 1 — beginner (correctness of basics)

**Q1 — Available connectors near a point (station discovery first page)**
```sql
SELECT v.station_id, v.station_name, v.city, v.standard_code, v.max_power_kw,
       v.connector_status
FROM   v_connector_live v
WHERE  v.connector_status = 'AVAILABLE'
  AND  v.station_status = 'ACTIVE'
  AND  v.latitude BETWEEN 12.80 AND 13.05          -- bounding box around VIT Chennai
  AND  v.longitude BETWEEN 80.10 AND 80.35
ORDER BY v.station_name;
```
*Purpose: the driver app's first query. Bounding box + status prefilter uses ix_station_geo before the view joins.*

**Q2 — Count of charging points per station**
```sql
SELECT s.name, COUNT(DISTINCT cp.cp_id) AS charge_points, COUNT(*) AS connectors
FROM   station s
JOIN   charge_point cp ON cp.station_id = s.station_id
JOIN   connector c     ON c.cp_id = cp.cp_id
GROUP BY s.name ORDER BY connectors DESC;
```
*Purpose: inventory report; exercises join + group by.*

**Q3 — Driver's charging history (last 10)**
```sql
SELECT cs.started_at, cs.energy_kwh, cs.state, i.total, i.status AS invoice_status
FROM   charging_session cs
LEFT JOIN invoice i ON i.session_id = cs.session_id
WHERE  cs.user_id = :user_id
ORDER BY cs.started_at DESC
FETCH FIRST 10 ROWS ONLY;
```
*Purpose: FR-DRV-03; LEFT JOIN because unbilled sessions still appear.*

### Tier 2 — intermediate (aggregates, subqueries, case)

**Q4 — Revenue by station for a month**
```sql
SELECT s.name, SUM(i.total) AS revenue, COUNT(*) AS paid_sessions
FROM   invoice i
JOIN   charging_session cs ON cs.session_id = i.session_id
JOIN   station s ON s.station_id =
         TO_NUMBER(SUBSTR(cs.connector_ref, 1, INSTR(cs.connector_ref, ':') - 1))
WHERE  i.status = 'PAID'
  AND  i.issued_at >= TRUNC(SYSDATE, 'MONTH')
GROUP BY s.name
ORDER BY revenue DESC;
```
*Purpose: operator KPI; also demonstrates the encoded-key join trade-off (Part V, 10.3) honestly.*

**Q5 — Stations currently having zero available connectors**
```sql
SELECT s.name
FROM   station s
JOIN   charge_point cp ON cp.station_id = s.station_id
JOIN   connector c ON c.cp_id = cp.cp_id
GROUP BY s.name
HAVING SUM(CASE WHEN c.status = 'AVAILABLE' THEN 1 ELSE 0 END) = 0;
```
*Purpose: "full right now" badge; HAVING + CASE.*

**Q6 — Failed sessions with their last known meter tick**
```sql
SELECT cs.session_id, cs.connector_ref, cs.stop_reason, cs.ended_at,
       (SELECT MAX(m.meter_kwh) FROM meter_reading m
        WHERE m.session_id = cs.session_id) AS last_kwh
FROM   charging_session cs
WHERE  cs.state = 'FAILED' AND cs.ended_at >= SYSDATE - 7
ORDER  BY cs.ended_at DESC;
```
*Purpose: fault triage queue; correlated scalar subquery.*

**Q7 — Repeat customers (>= 5 sessions)**
```sql
SELECT u.email, COUNT(*) AS sessions, SUM(cs.energy_kwh) AS lifetime_kwh
FROM   app_user u
JOIN   charging_session cs ON cs.user_id = u.user_id
GROUP BY u.email
HAVING COUNT(*) >= 5
ORDER BY lifetime_kwh DESC;
```

**Q8 — Maintenance backlog: connectors faulted > 48h without a record**
```sql
SELECT f.fault_id, f.connector_ref, f.code, f.reported_at,
       SYSTIMESTAMP - f.reported_at AS fault_age
FROM   fault f
WHERE  f.cleared_at IS NULL
  AND  NOT EXISTS (SELECT 1 FROM maintenance_record mr WHERE mr.fault_id = f.fault_id)
  AND  f.reported_at < SYSTIMESTAMP - INTERVAL '48' HOUR
ORDER  BY fault_age DESC;
```
*Purpose: FR-MNT backlog; NOT EXISTS anti-join.*

### Tier 3 — advanced (window functions, CTEs, gaps-and-islands)

**Q9 — Peak charging hours (network-wide)**
```sql
WITH starts AS (
  SELECT TO_CHAR(started_at, 'HH24') AS hr, COUNT(*) AS n
  FROM   charging_session
  WHERE  started_at >= SYSDATE - 30
  GROUP  BY TO_CHAR(started_at, 'HH24'))
SELECT hr, n,
       ROUND(100 * n / SUM(n) OVER (), 1) AS pct_of_load
FROM   starts
ORDER  BY n DESC FETCH FIRST 5 ROWS WITH TIES;
```
*Purpose: capacity planning; CTE + ratio-to-total window.*

**Q10 — Station ranking by utilization (window function)**
```sql
WITH occ AS (
  SELECT cs.connector_ref,
         SUM(cs.ended_at - cs.started_at) AS occupied
  FROM   charging_session cs
  WHERE  cs.state = 'COMPLETED' AND cs.started_at >= SYSDATE - 30
  GROUP  BY cs.connector_ref),
sellable AS (
  SELECT c.cp_id || ':' || c.connector_no AS connector_ref,
         (SYSDATE - 30) * COUNT(*) AS sellable_hours
  FROM   connector c GROUP BY c.cp_id, c.connector_no)
SELECT s.name,
       ROUND(100 * SUM(o.occupied) * 24 / NULLIF(SUM(sa.sellable_hours),0), 1) AS util_pct,
       RANK() OVER (ORDER BY ROUND(100 * SUM(o.occupied) * 24
                     / NULLIF(SUM(sa.sellable_hours),0), 1) DESC) AS rk
FROM   occ o JOIN sellable sa USING (connector_ref)
JOIN   charge_point cp ON cp.cp_id = TO_NUMBER(SUBSTR(o.connector_ref,1,INSTR(o.connector_ref,':')-1))
JOIN   station s ON s.station_id = cp.station_id
GROUP  BY s.name
ORDER  BY rk;
```
*Purpose: the KPI operators actually compete on (Section 3.7); RANK with ties.*

**Q11 — Month-over-month revenue trend with lag**
```sql
WITH monthly AS (
  SELECT TRUNC(i.issued_at, 'MONTH') AS m, SUM(i.total) AS revenue
  FROM   invoice i WHERE i.status = 'PAID'
  GROUP  BY TRUNC(i.issued_at, 'MONTH'))
SELECT m, revenue,
       LAG(revenue) OVER (ORDER BY m)                    AS prev_month,
       ROUND(100*(revenue - LAG(revenue) OVER (ORDER BY m))
             / NULLIF(LAG(revenue) OVER (ORDER BY m),0), 1) AS growth_pct
FROM   monthly ORDER BY m;
```

**Q12 — Moving 7-day average of daily energy (MA)**
```sql
WITH daily AS (
  SELECT TRUNC(cs.started_at) AS d, SUM(cs.energy_kwh) AS kwh
  FROM   charging_session cs
  WHERE  cs.state = 'COMPLETED'
  GROUP  BY TRUNC(cs.started_at))
SELECT d, kwh,
       ROUND(AVG(kwh) OVER (ORDER BY d ROWS BETWEEN 6 PRECEDING AND CURRENT ROW), 1)
         AS ma7_kwh
FROM   daily ORDER BY d;
```
*Purpose: smooths weekday noise for the trend chart; frame clause.*

**Q13 — Concurrency peaks: simultaneous active sessions per hour (gaps-and-islands flavor)**
```sql
WITH spans AS (
  SELECT session_id, started_at AS t, +1 AS delta FROM charging_session WHERE started_at IS NOT NULL
  UNION ALL
  SELECT session_id, COALESCE(ended_at, SYSTIMESTAMP) AS t, -1 AS delta
  FROM   charging_session WHERE started_at IS NOT NULL),
walk AS (
  SELECT t, SUM(delta) OVER (ORDER BY t, delta) AS active_count FROM spans)
SELECT TRUNC(t, 'HH24') AS bucket, MAX(active_count) AS peak_concurrent
FROM   walk GROUP BY TRUNC(t, 'HH24') ORDER BY bucket;
```
*Purpose: the sweep-line technique — how many chargers were busy at once; the seed of DA3's load curve done in pure SQL.*

**Q14 — Per-session energy buckets vs tariff bands (session detail audit)**
```sql
SELECT cs.session_id, cs.started_at, cs.energy_kwh, tp.name AS plan,
       b.price_per_kwh, ROUND(cs.energy_kwh * b.price_per_kwh, 2) AS energy_charge
FROM   charging_session cs
JOIN   tariff_plan tp ON tp.plan_id = cs.tariff_plan_id
JOIN   tariff_band b  ON b.plan_id = tp.plan_id
                     AND b.start_time <= cs.started_at AND b.end_time > cs.started_at
WHERE  cs.billing_state = 'BILLED' AND ROWNUM <= 50;
```
*Purpose: proves billing inputs; interval join.*

**Q15 — Keyset pagination on history (the performance query)**
```sql
SELECT session_id, started_at, energy_kwh
FROM   charging_session
WHERE  user_id = :user_id
  AND  (started_at, session_id) < (:cursor_ts, :cursor_id)
ORDER  BY started_at DESC, session_id DESC
FETCH FIRST 20 ROWS ONLY;
```
*Purpose: stable pagination at depth vs OFFSET's O(n) scan; uses ix_session_user_time.*

### Tier 4 — analytical / showcase

**Q16 — Cohort-style retention of drivers by first-session week**
```sql
WITH first_session AS (
  SELECT user_id, TRUNC(MIN(started_at), 'IW') AS cohort_week
  FROM   charging_session GROUP BY user_id),
activity AS (
  SELECT f.cohort_week,
         TRUNC(cs.started_at, 'IW') AS active_week, COUNT(DISTINCT cs.user_id) AS users
  FROM   charging_session cs JOIN first_session f USING (user_id)
  GROUP  BY f.cohort_week, TRUNC(cs.started_at, 'IW'))
SELECT cohort_week, active_week, users FROM activity ORDER BY cohort_week, active_week;
```

**Q17 — Connector reliability league (faults per 100 sessions)**
```sql
SELECT c_ref, sessions, faults,
       ROUND(100 * faults / NULLIF(sessions,0), 2) AS fault_rate_per_100
FROM  (SELECT connector_ref AS c_ref, COUNT(*) AS sessions
       FROM charging_session GROUP BY connector_ref) s
JOIN  (SELECT connector_ref, COUNT(*) AS faults FROM fault
       GROUP BY connector_ref) f USING (c_ref)
ORDER BY fault_rate_per_100 DESC;
```
*Purpose: preventive-maintenance targeting.*

**Q18 — Tariff price-change impact (before/after same station)**
```sql
SELECT tp.version_no, tp.active_from, COUNT(cs.session_id) AS sessions,
       ROUND(AVG(cs.energy_kwh),2) AS avg_kwh, ROUND(AVG(i.total),2) AS avg_invoice
FROM   tariff_plan tp
LEFT  JOIN charging_session cs ON cs.tariff_plan_id = tp.plan_id
LEFT  JOIN invoice i ON i.session_id = cs.session_id AND i.status = 'PAID'
WHERE  tp.group_id = :plan_group
GROUP  BY tp.version_no, tp.active_from ORDER BY tp.version_no;
```
*Purpose: demonstrates why versioned tariffs (Part VI, 12.7) enable analysis.*

**Q19 — Wallet ledger integrity check (reconciliation)**
```sql
SELECT w.user_id, w.balance,
       (SELECT SUM(amount) FROM wallet_ledger l WHERE l.user_id = w.user_id) AS ledger_sum,
       w.balance - (SELECT SUM(amount) FROM wallet_ledger l
                    WHERE l.user_id = w.user_id) AS drift
FROM   wallet_account w
WHERE  w.balance <> (SELECT NVL(SUM(amount),0) FROM wallet_ledger l
                     WHERE l.user_id = w.user_id);
```
*Purpose: self-auditing data — should return zero rows; great "we test our own invariants" line.*

**Q20 — Idle-fee candidates: sessions holding connector 30+ min after 90% charge**
```sql
SELECT cs.session_id, cs.connector_ref, cs.ended_at - cs.started_at AS held
FROM   charging_session cs
WHERE  cs.state = 'COMPLETED'
  AND  cs.stop_reason = 'IDLE_TIMEOUT'
  AND  cs.ended_at - cs.started_at > INTERVAL '30' MINUTE;
```
*(Simulator emits IDLE_TIMEOUT stops; connects pricing rule FR-TAR idle_fee to data.)*

**Q21 — Busiest connector per station (top-n-per-group)**
```sql
SELECT station_name, connector_ref, sessions
FROM  (SELECT s.name AS station_name, cs.connector_ref, COUNT(*) AS sessions,
              ROW_NUMBER() OVER (PARTITION BY s.station_id
                                 ORDER BY COUNT(*) DESC) AS rn
       FROM   charging_session cs
       JOIN   charge_point cp ON cp.cp_id =
                TO_NUMBER(SUBSTR(cs.connector_ref,1,INSTR(cs.connector_ref,':')-1))
       JOIN   station s ON s.station_id = cp.station_id
       GROUP  BY s.station_id, s.name, cs.connector_ref)
WHERE  rn = 1;
```
*Purpose: classic TOP-N-per-group with ROW_NUMBER — a guaranteed viva question.*

**Q22 — Session duration distribution (NTILE)**
```sql
SELECT NTILE(4) OVER (ORDER BY (ended_at - started_at)) AS quartile,
       MIN(ended_at - started_at), MAX(ended_at - started_at),
       COUNT(*)
FROM   charging_session WHERE state = 'COMPLETED'
GROUP  BY NTILE(4) OVER (ORDER BY (ended_at - started_at));
```

**Q23 — First-response time for faults (operational SLA)**
```sql
SELECT f.fault_id, f.reported_at, mr.started_at AS first_action,
       EXTRACT(DAY FROM (mr.started_at - f.reported_at)) * 24
       + EXTRACT(HOUR FROM (mr.started_at - f.reported_at)) AS response_hours
FROM   fault f
JOIN   maintenance_record mr ON mr.fault_id = f.fault_id
WHERE  mr.started_at IS NOT NULL
ORDER  BY response_hours DESC FETCH FIRST 10 ROWS ONLY;
```
*Ties to the arXiv Fault-Time KPI [9].*

**Q24 — Energy per connector-standard mix (network)**
```sql
SELECT cs2.code, SUM(cs.energy_kwh) AS kwh,
       ROUND(100 * RATIO_TO_REPORT(SUM(cs.energy_kwh)) OVER (), 1) AS pct
FROM   charging_session cs
JOIN   connector c ON c.cp_id = TO_NUMBER(SUBSTR(cs.connector_ref,1,INSTR(cs.connector_ref,':')-1))
                  AND c.connector_no = TO_NUMBER(SUBSTR(cs.connector_ref, INSTR(cs.connector_ref,':')+1))
JOIN   connector_standard cs2 ON cs2.standard_id = c.standard_id
GROUP  BY cs2.code ORDER BY kwh DESC;
```
*Purpose: fleet-planning signal (CCS2 share rising?).*

**Q25 — Double-booking impossibility proof (test query)**
```sql
SELECT connector_ref, COUNT(*) AS overlapping_pairs
FROM   reservation a JOIN reservation b
  ON   a.connector_ref = b.connector_ref
 AND   a.reservation_id < b.reservation_id
 AND   a.status IN ('BOOKED','CONVERTED') AND b.status IN ('BOOKED','CONVERTED')
 AND   a.start_at < b.end_at AND a.end_at > b.start_at
GROUP  BY connector_ref;
```
*Purpose: returns zero rows *always* — used as an automated DB test (Section 33) and demoed as the correctness proof.*

**Q26 — "Now" dashboard query (operator home)**
```sql
SELECT (SELECT COUNT(*) FROM charging_session WHERE state IN ('CHARGING','SUSPENDED'))      AS active_sessions,
       (SELECT COUNT(*) FROM connector c WHERE c.status='AVAILABLE')                        AS available_now,
       (SELECT COUNT(*) FROM fault WHERE cleared_at IS NULL)                                AS open_faults,
       (SELECT NVL(SUM(total),0) FROM invoice WHERE status='PAID'
          AND issued_at >= TRUNC(SYSDATE))                                                  AS revenue_today
FROM   DUAL;
```
*Purpose: one round-trip for the dashboard header cards.*
