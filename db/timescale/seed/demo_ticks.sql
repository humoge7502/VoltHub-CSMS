-- ============================================================================
-- VoltHub CSMS — demo telemetry (optional)
--
-- Seven days of synthetic meter ticks so the operator charts (load curve,
-- 7x24 heatmap) have a week of history on a fresh install instead of only the
-- ticks this process happened to see since boot.
--
-- Shape, not noise: a 5-minute cadence, a diurnal double-peak (commute + evening),
-- occupancy probability per connector so bays are not all busy at 03:00, and a
-- monotone meter_kwh per (connector, day) because a real meter never runs backwards.
--
-- Deterministic: setseed makes the same install look the same twice.
--   docker exec -i volthub-timescale psql -U volthub -d volthub -f /tmp/demo_ticks.sql
-- ============================================================================
SET client_min_messages = warning;
SELECT setseed(0.42);

-- Idempotence guard: skip when a seeded week is already present.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM meter_tick WHERE dedupe_key LIKE 'seed:%';
  IF n > 0 THEN
    RAISE NOTICE 'demo ticks already present (% rows) — skipping', n;
  ELSE
    INSERT INTO meter_tick (ts, session_id, seq_no, connector_ref, meter_kwh, power_kw, voltage_v, current_a, dedupe_key)
    WITH slots AS (
      SELECT generate_series(
               date_trunc('hour', now() - interval '7 days'),
               date_trunc('hour', now()),
               interval '5 minutes') AS ts
    ),
    conn AS (SELECT connector_ref, max_power_kw FROM station_map),
    draw AS (
      SELECT s.ts,
             c.connector_ref,
             c.max_power_kw,
             EXTRACT(dow FROM s.ts)::int  AS dow,
             EXTRACT(hour FROM s.ts)::int AS hh,
             -- double peak: 09:00 commute, 19:00 evening
             0.22
               + 0.55 * exp(-power((EXTRACT(hour FROM s.ts) - 19) / 3.4, 2))
               + 0.30 * exp(-power((EXTRACT(hour FROM s.ts) - 9) / 3.0, 2)) AS diurnal
        FROM slots s CROSS JOIN conn c
    ),
    live AS (
      SELECT ts, connector_ref, max_power_kw, dow, hh,
             -- weekend evenings are busier, weekday mornings are not
             LEAST(0.97, diurnal * (CASE WHEN dow IN (0, 6) AND hh BETWEEN 16 AND 22 THEN 1.15 ELSE 1 END))
               AS occ,
             random() AS r
        FROM draw
    ),
    drawn AS (
      SELECT ts, connector_ref, max_power_kw, dow, hh,
             -- a connector is drawing only when the roll says so
             ROUND((max_power_kw * (0.55 + 0.45 * r) * (0.7 + 0.3 * random()))::numeric, 1)::float8 AS power_kw
        FROM live
       WHERE r < occ
    ),
    keyed AS (
      SELECT ts, connector_ref, power_kw,
             row_number() OVER (ORDER BY connector_ref, ts) AS rn,
             -- one synthetic session per connector per day
             900000 + dense_rank() OVER (ORDER BY connector_ref) * 100 + EXTRACT(doy FROM ts)::int AS session_id,
             row_number() OVER (PARTITION BY connector_ref, date_trunc('day', ts) ORDER BY ts) AS seq_no
        FROM drawn
    )
    SELECT ts,
           session_id,
           seq_no,
           connector_ref,
           ROUND(SUM(power_kw * 5.0 / 60.0) OVER (PARTITION BY connector_ref, date_trunc('day', ts) ORDER BY ts)
                 ::numeric, 3)::float8 AS meter_kwh,
           power_kw,
           400,
           ROUND((power_kw * 1000 / 400)::numeric, 1)::float8,
           'seed:' || connector_ref || ':' || ts::text
      FROM keyed;
  END IF;
END $$;

-- Refresh the continuous aggregates so the 1m/1h shapes include the seeded week.
CALL refresh_continuous_aggregate('tick_1m', now() - interval '8 days', now());
CALL refresh_continuous_aggregate('tick_1h', now() - interval '8 days', now());

SELECT count(*) AS ticks, min(ts) AS first_tick, max(ts) AS last_tick
  FROM meter_tick WHERE dedupe_key LIKE 'seed:%';
