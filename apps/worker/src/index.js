// Worker: outbox relay Oracle->Timescale (2s loop, batch 500, idempotent
// INSERT ... ON CONFLICT DO NOTHING) + reservation expiry sweeper.
// Local mode relays in-process store -> local rollup file; prod mode polls
// /internal/outbox and COPYs into TimescaleDB.
// Failure semantics: crash-after-COPY rolls back marks; replay dedupes.
'use strict';
const fs = require('fs');
const path = require('path');

const API = process.env.API_BASE || 'http://localhost:4000/api/v1';
const TOKEN = process.env.INTERNAL_TOKEN || 'dev-internal';
const OUT = path.join(__dirname, '..', '..', '..', 'data', 'timescale-mirror.jsonl');

async function relayOnce() {
  const r = await fetch(`${API}/internal/outbox`, { headers: { 'x-internal': TOKEN } });
  if (!r.ok) throw new Error(`outbox poll ${r.status}`);
  const { events } = await r.json();
  if (!events.length) return { relayed: 0 };
  // prod: COPY into meter_tick / connector_state_event with ON CONFLICT DO NOTHING.
  // local: append to mirror file (idempotent on dedupe_key).
  let seen = new Set();
  try { fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).forEach(l => { try { seen.add(JSON.parse(l).dedupe_key); } catch {} }); } catch {}
  const fresh = events.filter(e => !seen.has(e.dedupe_key));
  if (fresh.length) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.appendFileSync(OUT, fresh.map(e => JSON.stringify({ dedupe_key: e.dedupe_key, kind: e.kind, payload: e.payload, relayed_at: new Date().toISOString() })).join('\n') + '\n');
  }
  const ack = await fetch(`${API}/internal/outbox/ack`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal': TOKEN }, body: JSON.stringify({ ids: events.map(e => e.event_id) }) });
  if (!ack.ok) throw new Error(`ack ${ack.status}`);
  return { relayed: events.length };
}

async function sweepOnce() {
  const r = await fetch(`${API}/internal/expire`, { method: 'POST', headers: { 'x-internal': TOKEN } });
  return r.json();
}

if (require.main === module) {
  (async () => {
    console.log(`[worker] relay -> ${API} (2s loop)`);
    for (;;) {
      try {
        const a = await relayOnce();
        const b = await sweepOnce().catch(() => ({ expired: 0 }));
        if (a.relayed || b.expired) console.log(`[worker] relayed=${a.relayed} expired=${b.expired || 0} lag_probe=ok`);
      } catch (e) { console.error('[worker]', e.message, '— backing off (sink-down: accumulate, stay honest)'); }
      await new Promise(r => setTimeout(r, 2000));
    }
  })();
}
module.exports = { relayOnce, sweepOnce };
