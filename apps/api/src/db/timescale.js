// Timescale read path for the operator charts (ADR-0002).
//
// Why this file exists: the load curve used to be computed from `store.ticks` — the
// in-memory tail of ticks this process happened to see since boot. The response still
// said `source: 'timescaledb'` whenever TS_HOST was set, which was a claim the code did
// not honour: after a restart the chart was empty while the database held a week of
// ticks. Charts now read the engine they name, and fall back honestly when it is absent.
//
// Shape: arbitrary bucket sizes (5m/1h) over a bounded window. The continuous
// aggregates (tick_1m/tick_1h) serve fixed shapes; a caller-chosen bucket is a
// hypertable query with time_bucket(), which is what Timescale is for.
'use strict';
let _pg = null;
let _pool = null;

function pool() {
  if (_pool) return _pool;
  if (!process.env.TS_HOST) return null;
  if (!_pg) {
    try {
      _pg = require('pg');
    } catch {
      return null; // pg absent in this install — caller falls back to the local rollup
    }
  }
  const { Pool } = _pg;
  _pool = new Pool({
    host: process.env.TS_HOST,
    port: Number(process.env.TS_PORT || 5432),
    database: process.env.TS_DB || 'volthub',
    user: process.env.TS_USER || 'volthub',
    password: process.env.TS_PASSWORD || process.env.TS_PASS || 'volthub_dev_pwd',
    max: 4,
    // A chart must never hang a request: fail fast and let the route fall back.
    connectionTimeoutMillis: 2500,
    idleTimeoutMillis: 30000,
  });
  _pool.on('error', () => {});
  return _pool;
}

const available = () => !!process.env.TS_HOST;

async function query(sql, params) {
  const p = pool();
  if (!p) return null;
  const r = await p.query(sql, params);
  return r.rows;
}

// Average and peak kW per bucket for one station (or the whole fleet when stationId is
// null). `connector_ref` is '<cp_id>:<connector_no>', and station_map is the Oracle-owned
// metadata join the relay keeps in sync — so this filters without a cross-engine call.
async function loadCurve({ stationId, from, to, bucket = '5m' }) {
  const mins = bucket === '1h' ? 60 : bucket === '1m' ? 1 : 5;
  const rows = await query(
    `SELECT time_bucket(make_interval(mins => $1), t.ts) AS bucket,
            AVG(t.power_kw)::float8 AS avg_kw,
            MAX(t.power_kw)::float8 AS peak_kw,
            COUNT(*)::int AS n
       FROM meter_tick t
       JOIN station_map m ON m.connector_ref = t.connector_ref
      WHERE t.ts >= $2 AND t.ts <= $3
        AND ($4::int IS NULL OR m.station_id = $4::int)
      GROUP BY 1
      ORDER BY 1`,
    [mins, from, to, stationId == null ? null : Number(stationId)]
  );
  return (rows || []).map((r) => ({
    bucket: new Date(r.bucket).toISOString(),
    avg_kw: +Number(r.avg_kw).toFixed(2),
    peak_kw: +Number(r.peak_kw).toFixed(2),
  }));
}

// 7×24 utilization matrix: average number of connectors drawing power at any moment
// inside each (weekday, hour) cell. Ticks are 5-minute samples, so
//   busy = ticks × 5min / 60min / days
// is "bays in use, on average" — the number an operator can act on. Counting distinct
// connectors per hour saturates (one 5-minute draw marks the whole hour), which is the
// trap this metric avoids.
async function heatmap({ stationId, days = 7 }) {
  const rows = await query(
    `SELECT EXTRACT(DOW FROM t.ts)::int AS dow,
            EXTRACT(HOUR FROM t.ts)::int AS hour,
            (COUNT(*) * 5.0 / 60.0 / $1::numeric)::float8 AS busy
       FROM meter_tick t
       JOIN station_map m ON m.connector_ref = t.connector_ref
      WHERE t.ts >= now() - make_interval(days => $1::int)
        AND ($2::int IS NULL OR m.station_id = $2::int)
      GROUP BY 1, 2`,
    [days, stationId == null ? null : Number(stationId)]
  );
  if (!rows) return null;
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of rows) grid[r.dow][r.hour] = +Number(r.busy).toFixed(2);
  return grid;
}

async function health() {
  if (!available()) return 'local-rollup';
  try {
    await query('SELECT 1');
    return 'connected';
  } catch {
    return 'unreachable';
  }
}

module.exports = { available, loadCurve, heatmap, health };
