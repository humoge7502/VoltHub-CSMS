// Timescale relay (§7.4): Oracle outbox -> hypertables via batched INSERT (dep-light).
// At-least-once + dedupe-key idempotency = effectively-once (ADR-0003, now real).
// Crash-after-INSERT replays safely (PK ON CONFLICT DO NOTHING); ack only after COMMIT.
// Local profile (no TS_HOST): delegates to the JSONL mirror in index.js.
'use strict';

let _pg = null;
let _poolFactory = null; // test seam: _setPoolFactory(fn) replaces the real pg Pool.
let _shared = null; // one pool for the whole worker process (see pool()/releasePool())

function pg() {
  if (!_pg) {
    try {
      _pg = require('pg');
    } catch {
      throw new Error('pg not installed (npm i -w apps/worker pg)');
    }
  }
  return _pg;
}
function newPool() {
  const { Pool } = pg();
  return new Pool({
    host: process.env.TS_HOST || 'localhost',
    port: Number(process.env.TS_PORT || 5432),
    database: process.env.TS_DB || 'volthub',
    user: process.env.TS_USER || 'volthub',
    password: process.env.TS_PASSWORD || process.env.TS_PASS || 'volthub_dev_pwd',
    max: Number(process.env.TS_POOL_MAX || 4),
    connectionTimeoutMillis: 5000, // never let a cold pool hang the 2 s loop
  });
}
// PERF: the relay polls every 2 s, and opening a Pool per poll meant a fresh TCP
// handshake plus (on a TLS/unreachable sink) a multi-second stall for every cycle.
// One lazily-created pool is shared by both relay paths and closed at shutdown.
function pool() {
  if (!_shared) _shared = _poolFactory ? _poolFactory() : newPool();
  return _shared;
}
function _setPoolFactory(fn) {
  _poolFactory = fn;
  _shared = null; // the cached pool belongs to the factory that made it
}
async function releasePool() {
  const p = _shared;
  _shared = null;
  if (p) await p.end().catch(() => {});
}

// Column lists. Every relay row ends with (dedupe_key, event_id): dedupe_key is the
// last real column, event_id is pipeline metadata that insertBatch slices away.
const TICK_COLS = [
  'ts',
  'session_id',
  'seq_no',
  'connector_ref',
  'meter_kwh',
  'power_kw',
  'voltage_v',
  'current_a',
  'dedupe_key',
];
const STATE_COLS = ['ts', 'connector_ref', 'from_state', 'to_state', 'cause', 'session_id', 'dedupe_key'];
const ENF_COLS = [
  'ts',
  'cp_id',
  'session_id',
  'decision_id',
  'scheduled_kw',
  'actual_kw',
  'deviation_kw',
  'dedupe_key',
];
const CONFLICT = 'ON CONFLICT DO NOTHING';

// Required channels must be a real finite number; optional ones that arrive NaN/±Inf
// collapse to NULL so a broken auxiliary sample never costs the session its register.
const isReal = (v) => v != null && Number.isFinite(Number(v));
const numOrNull = (v) => (isReal(v) ? Number(v) : null);

// Split outbox events into INSERT-ready rows. PK alignment: meter_tick(session_id, seq_no, ts, ...),
// connector_state_event(connector_ref, ts, dedupe_key) — seq_no/dedupe_key carry the pipeline
// dedupe key (B2G-006).
// ADR-0010/Phase 3: ENFORCEMENT_TICK rides the same outbox -> meter_tick_enforcement (T003)
// with priority over analytics-only kinds when relay lag breaches the SLO (O.2 backpressure).
function toRows(events) {
  // Timescale hypertables key on (id, ts). Oracle package payloads carry second
  // precision while the JS outbox carries milliseconds; truncating to seconds makes
  // the two writers collide on the same primary key, so ON CONFLICT DO NOTHING
  // dedupes a tick that both engines observed instead of storing it twice.
  const toSec = (v) => {
    const d = new Date(v);
    d.setMilliseconds(0);
    return d;
  };
  const ticks = [],
    states = [],
    enforcement = [],
    refused = [];
  for (const e of events) {
    const p = e.payload || {};
    if (e.kind === 'METER_TICK' && p.session_id && p.ts) {
      // Timescale float8 stores NaN and ±Infinity as ordinary-looking rows, and for
      // float8 Postgres defines NaN = NaN as TRUE — so the IEEE "x !== x" detector
      // never spots the value it stored, while every SUM/AVG above it turns into NaN.
      // The ingest boundary rejects these frames now (gateway TypeMismatch, store
      // TICK_REJECTED), but events queued before that fix still reach the outbox, so
      // the relay refuses them here and dead-letters them rather than writing a poison
      // row the sink cannot refuse: Timescale forbids CHECK constraints on a
      // compression-enabled hypertable, which every table here is.
      if (!isReal(p.meter_kwh)) {
        refused.push({
          table: 'meter_tick',
          key: e.dedupe_key,
          id: e.event_id,
          reason: `meter_tick refuses non-finite meter_kwh: ${String(p.meter_kwh)}`,
        });
        continue;
      }
      // B2G-006: pass seq + dedupe_key so same-second ticks don't collide on the PK.
      ticks.push([
        toSec(p.ts),
        Number(p.session_id),
        Number(p.seq ?? 0),
        String(p.connector_ref || ''),
        Number(p.meter_kwh),
        numOrNull(p.power_kw),
        null,
        null,
        e.dedupe_key,
        e.event_id,
      ]);
    } else if (e.kind === 'ENFORCEMENT_TICK' && p.cp_id != null && p.ts) {
      if (!isReal(p.scheduled_kw)) {
        refused.push({
          table: 'meter_tick_enforcement',
          key: e.dedupe_key,
          id: e.event_id,
          reason: `meter_tick_enforcement refuses non-finite scheduled_kw: ${String(p.scheduled_kw)}`,
        });
        continue;
      }
      enforcement.push([
        new Date(p.ts),
        Number(p.cp_id),
        p.session_id ?? null,
        p.decision_id ?? null,
        Number(p.scheduled_kw),
        numOrNull(p.actual_kw),
        numOrNull(p.deviation_kw),
        e.dedupe_key,
        e.event_id,
      ]);
    } else if (e.kind === 'CONNECTOR_STATE' && p.connector_ref) {
      // dedupe_key is part of the primary key (T001/T004). Without it, two genuine
      // transitions inside one wall-clock second (OCCUPIED→CHARGING then
      // CHARGING→FINISHING) collided and ON CONFLICT DO NOTHING silently deleted
      // history that the utilization caggs in T002 read.
      states.push([
        toSec(e.created_at || Date.now()),
        String(p.connector_ref),
        p.from || null,
        p.to || 'UNKNOWN',
        p.cause || 'OCPP',
        p.session_id ?? p.reservation_id ?? null,
        e.dedupe_key,
        e.event_id,
      ]);
    } else if (e.kind === 'SESSION_EVENT' && p.session_id) {
      states.push([
        toSec(e.created_at || Date.now()),
        String(p.connector_ref || `sess:${p.session_id}`),
        p.from || null,
        p.to || 'UNKNOWN',
        'SESSION',
        Number(p.session_id),
        e.dedupe_key,
        e.event_id,
      ]);
    }
  }
  return { ticks, states, enforcement, refused };
}

const dedupeOf = (row) => row[row.length - 2];
const eventOf = (row) => row[row.length - 1];

// B3G-003: historically named copyBatch; performs chunked multi-row INSERT.
async function insertBatch(client, table, cols, rows, conflict) {
  if (!rows.length) return 0;
  // Dependency-light path: multi-row INSERT ... ON CONFLICT DO NOTHING in 500-row chunks.
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    // Slice to the column list first: relay rows carry a trailing event_id that is
    // pipeline metadata, not a column. Placeholder numbering follows cols.length.
    const chunk = rows.slice(i, i + 500).map((r) => r.slice(0, cols.length));
    const vals = [];
    const ph = chunk.map((r, ri) => `(${r.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(',')})`).join(',');
    chunk.forEach((r) => vals.push(...r));
    await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${ph} ${conflict}`, vals);
    n += chunk.length;
  }
  return n;
}

// Failure classification — the difference between "back off" and "drop one row".
//   08/53/57/58/40: sink or session state (down, overloaded, deadlock, serialized).
//                   Nothing is wrong with the events, so the queue must keep them.
//   42:            schema drift (undefined_table/column, datatype mismatch). The sink
//                   changed shape; dead-lettering a whole fleet of events would be
//                   data loss caused by a missed migration, so page instead.
//   22/23:         this row's values violate the table (bad numeric, NOT NULL,
//                   truncation). Those are true poison messages: isolate and quarantine.
// Anything else is treated as poison but only quarantined if the pass lands some
// rows — see writeOneByOne's all-failed guard.
const pgCode = (e) => String((e && e.code) || '');
function isTransportError(e) {
  return /^(08|53|57|58|40)/.test(pgCode(e));
}
function isSchemaError(e) {
  return /^42/.test(pgCode(e));
}

// One transaction for the whole batch: the common case, and it keeps a batch atomic.
// On a data-shaped failure the batch is rolled back and replayed row by row so a
// single bad event cannot block the queue behind it forever (head-of-line blocking).
async function writeSpecs(specs) {
  const p = pool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const byName = {};
    for (const s of specs) byName[s.name] = await insertBatch(client, s.table, s.cols, s.rows, s.conflict);
    await client.query('COMMIT');
    return { byName, poison: [] };
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    if (isTransportError(e)) throw e;
    if (isSchemaError(e))
      throw new Error(`schema drift on ${specs.map((s) => s.table).join(',')}: ${e.message}`, { cause: e });
    return writeOneByOne(client, specs, e);
  } finally {
    client.release();
  }
}

async function writeOneByOne(client, specs, firstError) {
  const byName = {};
  const poison = [];
  for (const s of specs) {
    byName[s.name] = 0;
    for (const row of s.rows) {
      try {
        await client.query('BEGIN');
        await insertBatch(client, s.table, s.cols, [row], s.conflict);
        await client.query('COMMIT');
        byName[s.name]++;
      } catch (e) {
        try {
          await client.query('ROLLBACK');
        } catch {}
        if (isTransportError(e)) throw e; // sink went down mid-isolation: stop, keep the queue
        // Rows that carry pipeline metadata are wider than their column list; the
        // station_map rows don't, so identity is only available on the event path.
        const tracked = row.length > s.cols.length;
        poison.push({
          table: s.table,
          key: tracked ? dedupeOf(row) : null,
          id: tracked ? eventOf(row) : null,
          reason: `${s.table} ${pgCode(e) || 'ERROR'}: ${String(e.message || '').slice(0, 140)}`,
        });
      }
    }
  }
  // Every row refused with the same-shaped error is an outage or a bug in this relay,
  // not a poison message. Dead-lettering the batch would throw away telemetry that a
  // retry would have written, so hand it back to the queue and let the loop back off.
  if (poison.length && Object.values(byName).every((n) => n === 0)) {
    throw new Error(
      `relay wrote 0/${poison.length} rows individually — ${poison[0].reason} (was: ${firstError.message})`,
      { cause: firstError }
    );
  }
  return { byName, poison };
}

// Masterplan §26.5: station_map is Oracle-owned metadata that continuous aggregates
// may not join inside their definitions (P2V-01), so the relay keeps a denormalized
// copy in Timescale for query-time enrichment (v_tick_*_enriched, Grafana). The API
// serves the authoritative rows at GET /internal/station-map from its hydrated store.
// BUG-022: HTTP is bounded (5 s) so a hung API cannot freeze the relay pipeline.
const HTTP_TIMEOUT_MS = 5000;
function bounded(fetchFn) {
  return (url, opts = {}) => fetchFn(url, { ...opts, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
}

const MAP_COLS = ['connector_ref', 'station_id', 'station_name', 'standard_code', 'max_power_kw'];
const MAP_UPSERT = `ON CONFLICT (connector_ref) DO UPDATE SET station_id = EXCLUDED.station_id, station_name = EXCLUDED.station_name, standard_code = EXCLUDED.standard_code, max_power_kw = EXCLUDED.max_power_kw`;

async function syncStationMap(apiBase, internalToken, fetchImpl) {
  const fetchFn = bounded(fetchImpl || fetch);
  const r = await fetchFn(`${apiBase}/internal/station-map`, { headers: { 'x-internal': internalToken } });
  if (!r.ok) throw new Error(`station-map poll ${r.status}`);
  const { rows } = await r.json();
  if (!rows || !rows.length) return { synced: 0 };
  // Same batch-then-isolate path as the event relay: one malformed station used to
  // roll back the whole map, so a single bad row left 46 connectors unenriched and
  // every per-station Grafana panel blank until it was fixed.
  const specs = [
    {
      name: 'station_map',
      table: 'station_map',
      cols: MAP_COLS,
      conflict: MAP_UPSERT,
      rows: rows.map((x) => [
        String(x.connector_ref),
        Number(x.station_id),
        String(x.station_name || ''),
        String(x.standard_code || ''),
        Number(x.max_power_kw),
      ]),
    },
  ];
  const { byName, poison } = await writeSpecs(specs);
  return { synced: byName.station_map || 0, skipped: poison.length };
}

async function relayToTimescale(apiBase, internalToken, fetchImpl) {
  const fetchFn = bounded(fetchImpl || fetch);
  const r = await fetchFn(`${apiBase}/internal/outbox`, { headers: { 'x-internal': internalToken } });
  if (!r.ok) throw new Error(`outbox poll ${r.status}`);
  const body = await r.json();
  const events = body.events || [];
  // The API measures queue lag; the worker only reports it. Before this the loop
  // printed a hardcoded `lag_probe=ok`, so a stuck queue looked healthy in logs.
  const lag = { pending: Number(body.pending || 0), oldest_age_s: Number(body.oldest_age_s || 0) };
  if (!events.length) return { relayed: 0, ticks: 0, states: 0, enforcement: 0, quarantined: 0, ...lag };
  const { ticks, states, enforcement, refused } = toRows(events);
  const specs = [];
  if (ticks.length)
    specs.push({ name: 'ticks', table: 'meter_tick', cols: TICK_COLS, rows: ticks, conflict: CONFLICT });
  if (states.length)
    specs.push({ name: 'states', table: 'connector_state_event', cols: STATE_COLS, rows: states, conflict: CONFLICT });
  if (enforcement.length)
    specs.push({
      name: 'enforcement',
      table: 'meter_tick_enforcement',
      cols: ENF_COLS,
      rows: enforcement,
      conflict: CONFLICT,
    });
  // Every event the sink cannot classify is acked only after it is written, so an
  // outbox row whose payload shape matches none of the tables is metadata-only —
  // keep the previous behaviour of clearing it rather than looping on it forever.
  const relayed = specs.reduce((n, s) => n + s.rows.length, 0);
  const { byName, poison: sinkPoison } = specs.length ? await writeSpecs(specs) : { byName: {}, poison: [] };
  // Rows the relay refused before reaching the sink are poison with a clearer reason
  // than any database can give, so they ride the same quarantine path.
  const poison = [...refused, ...sinkPoison];
  let quarantined = 0;
  if (poison.length) {
    const keys = [...new Set(poison.map((x) => x.key).filter(Boolean))];
    const ids = [...new Set(poison.map((x) => x.id).filter((n) => Number.isFinite(n)))];
    const q = await fetchFn(`${apiBase}/internal/outbox/quarantine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal': internalToken },
      body: JSON.stringify({ ids, keys, reason: poison[0].reason }),
    });
    // A failed quarantine is not a failed write: the rows are still unacked, so the
    // next cycle retries them (idempotent) rather than losing them silently.
    if (!q.ok) throw new Error(`quarantine ${q.status}`);
    const out = await q.json().catch(() => ({}));
    quarantined = Number(out.quarantined || keys.length);
  }
  const bad = new Set(poison.map((x) => x.key));
  const ackIds = [];
  const ackKeys = [];
  for (const e of events) {
    if (bad.has(e.dedupe_key)) continue;
    ackIds.push(e.event_id);
    if (e.dedupe_key) ackKeys.push(e.dedupe_key);
  }
  // Only rows that landed (or were quarantined) leave the queue: acking an event the
  // sink never wrote is the data-loss bug this whole path exists to avoid.
  const ack = await fetchFn(`${apiBase}/internal/outbox/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal': internalToken },
    body: JSON.stringify({ ids: ackIds, keys: ackKeys }),
  });
  if (!ack.ok) throw new Error(`ack ${ack.status}`);
  return {
    relayed: events.length,
    written: relayed,
    ticks: byName.ticks || 0,
    states: byName.states || 0,
    enforcement: byName.enforcement || 0,
    quarantined,
    ...lag,
  };
}

module.exports = {
  relayToTimescale,
  syncStationMap,
  toRows,
  insertBatch,
  copyBatch: insertBatch,
  releasePool,
  _setPoolFactory,
};
