// Timescale relay (§7.4): Oracle outbox -> hypertables via batched INSERT (dep-light).
// At-least-once + dedupe-key idempotency = effectively-once (ADR-0003, now real).
// Crash-after-INSERT replays safely (PK ON CONFLICT DO NOTHING); ack only after COMMIT.
// Local profile (no TS_HOST): delegates to the JSONL mirror in index.js.
'use strict';

let _pg = null;
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
function pool() {
  const { Pool } = pg();
  return new Pool({
    host: process.env.TS_HOST || 'localhost',
    port: Number(process.env.TS_PORT || 5432),
    database: process.env.TS_DB || 'volthub',
    user: process.env.TS_USER || 'volthub',
    password: process.env.TS_PASSWORD || process.env.TS_PASS || 'volthub_dev_pwd',
    max: 4,
  });
}

// Split outbox events into INSERT-ready rows. PK alignment: meter_tick(session_id, seq_no, ts),
// connector_state_event(connector_ref, ts) — seq_no/dedupe_key carry the pipeline dedupe key (B2G-006).
function toRows(events) {
  const ticks = [],
    states = [];
  for (const e of events) {
    const p = e.payload || {};
    if (e.kind === 'METER_TICK' && p.session_id && p.ts) {
      // B2G-006: pass seq + dedupe_key so same-second ticks don't collide on the PK.
      ticks.push([
        new Date(p.ts),
        Number(p.session_id),
        Number(p.seq ?? 0),
        String(p.connector_ref || ''),
        Number(p.meter_kwh),
        p.power_kw ?? null,
        null,
        null,
        e.dedupe_key,
      ]);
    } else if (e.kind === 'CONNECTOR_STATE' && p.connector_ref) {
      states.push([
        new Date(e.created_at || Date.now()),
        String(p.connector_ref),
        p.from || null,
        p.to || 'UNKNOWN',
        p.cause || 'OCPP',
        p.session_id ?? p.reservation_id ?? null,
        e.dedupe_key,
      ]);
    } else if (e.kind === 'SESSION_EVENT' && p.session_id) {
      states.push([
        new Date(e.created_at || Date.now()),
        String(p.connector_ref || `sess:${p.session_id}`),
        p.from || null,
        p.to || 'UNKNOWN',
        'SESSION',
        Number(p.session_id),
        e.dedupe_key,
      ]);
    }
  }
  return { ticks, states };
}

// B3G-003: historically named copyBatch; performs chunked multi-row INSERT.
async function insertBatch(client, table, cols, rows, conflict) {
  if (!rows.length) return 0;
  // Dependency-light path: multi-row INSERT ... ON CONFLICT DO NOTHING in 500-row chunks.
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const vals = [];
    const ph = chunk.map((r, ri) => `(${r.map((_, ci) => `$${ri * r.length + ci + 1}`).join(',')})`).join(',');
    chunk.forEach((r) => vals.push(...r.slice(0, cols.length)));
    await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${ph} ${conflict}`, vals);
    n += chunk.length;
  }
  return n;
}

async function relayToTimescale(apiBase, internalToken, fetchImpl) {
  const fetchFn = fetchImpl || fetch;
  const r = await fetchFn(`${apiBase}/internal/outbox`, { headers: { 'x-internal': internalToken } });
  if (!r.ok) throw new Error(`outbox poll ${r.status}`);
  const { events } = await r.json();
  if (!events.length) return { relayed: 0, ticks: 0, states: 0 };
  const { ticks, states } = toRows(events);
  const p = pool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const nt = await insertBatch(
      client,
      'meter_tick (ts, session_id, seq_no, connector_ref, meter_kwh, power_kw, voltage_v, current_a, dedupe_key)',
      ['ts', 'session_id', 'seq_no', 'connector_ref', 'meter_kwh', 'power_kw', 'voltage_v', 'current_a', 'dedupe_key'],
      ticks.map((t) => t.slice(0, 9)),
      'ON CONFLICT DO NOTHING'
    );
    const ns = await insertBatch(
      client,
      'connector_state_event (ts, connector_ref, from_state, to_state, cause, session_id)',
      ['ts', 'connector_ref', 'from_state', 'to_state', 'cause', 'session_id'],
      states.map((s) => s.slice(0, 6)),
      'ON CONFLICT DO NOTHING'
    );
    await client.query('COMMIT');
    const ack = await fetchFn(`${apiBase}/internal/outbox/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal': internalToken },
      body: JSON.stringify({ ids: events.map((e) => e.event_id) }),
    });
    if (!ack.ok) throw new Error(`ack ${ack.status}`);
    return { relayed: events.length, ticks: nt, states: ns };
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw e;
  } finally {
    client.release();
    await p.end().catch(() => {});
  }
}

module.exports = { relayToTimescale, toRows, insertBatch, copyBatch: insertBatch };
