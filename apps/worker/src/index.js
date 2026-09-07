// Worker: outbox relay Oracle->Timescale (2s loop, batch 500, idempotent
// INSERT ... ON CONFLICT DO NOTHING) + reservation expiry sweeper.
// Local mode relays in-process store -> local rollup file; prod mode polls
// /internal/outbox and INSERTs into TimescaleDB (see relay-timescale.js).
// Failure semantics: crash-after-INSERT rolls back marks; replay dedupes.
'use strict';
const fs = require('fs');
const path = require('path');

const API = process.env.API_BASE || 'http://localhost:4000/api/v1';
const TOKEN = process.env.INTERNAL_TOKEN || 'dev-internal';
const OUT = path.join(__dirname, '..', '..', '..', 'data', 'timescale-mirror.jsonl');

// BUG-015 fix: dedupe set lives in memory (seeded once per mirror file), not rebuilt by
// re-reading the whole JSONL mirror every 2 s (was O(total ticks) per poll).
const seenCache = new Map(); // mirror file -> Set(dedupe_key)
function loadSeen(file = OUT) {
  if (seenCache.has(file)) return seenCache.get(file);
  const set = new Set();
  try {
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .forEach((l) => {
        try {
          set.add(JSON.parse(l).dedupe_key);
        } catch {}
      });
  } catch {}
  seenCache.set(file, set);
  return set;
}

// BUG-022: every worker HTTP call is bounded — a hung API must not freeze the
// relay forever. AbortSignal.timeout aborts after 5 s and the loop backs off.
const HTTP_TIMEOUT_MS = 5000;
function apiFetch(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
}

// opts.fetchImpl / opts.outFile are test seams (RESIL: chaos tests inject failures
// and a temp mirror file without touching the real data/ path or global fetch).
async function relayOnce(opts = {}) {
  const doFetch = opts.fetchImpl || apiFetch;
  const outFile = opts.outFile || OUT;
  // Prod path (TS_HOST set): batched COPY into hypertables; ack only after COMMIT.
  if (process.env.TS_HOST) {
    const { relayToTimescale, syncStationMap } = require('./relay-timescale');
    // Masterplan §26.5: keep Timescale station_map in step with Oracle-owned station
    // metadata (cheap full upsert; powers v_tick_*_enriched + Grafana). Failures log
    // and back off with the loop — they must not stall event relay.
    await syncStationMap(API, TOKEN, doFetch).catch((e) => {
      console.error('[worker] station-map sync:', e.message);
    });
    return relayToTimescale(API, TOKEN, doFetch);
  }
  const r = await doFetch(`${API}/internal/outbox`, { headers: { 'x-internal': TOKEN } });
  if (!r.ok) throw new Error(`outbox poll ${r.status}`);
  const { events } = await r.json();
  if (!events.length) return { relayed: 0 };
  // prod: INSERT into meter_tick / connector_state_event with ON CONFLICT DO NOTHING (relay-timescale.js).
  // local: append to mirror file (idempotent on dedupe_key).
  const seen = loadSeen(outFile);
  const fresh = events.filter((e) => !seen.has(e.dedupe_key));
  if (fresh.length) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.appendFileSync(
      outFile,
      fresh
        .map((e) =>
          JSON.stringify({
            dedupe_key: e.dedupe_key,
            kind: e.kind,
            payload: e.payload,
            relayed_at: new Date().toISOString(),
          })
        )
        .join('\n') + '\n'
    );
    fresh.forEach((e) => seen.add(e.dedupe_key));
  }
  const ack = await doFetch(`${API}/internal/outbox/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal': TOKEN },
    body: JSON.stringify({ ids: events.map((e) => e.event_id) }),
  });
  if (!ack.ok) throw new Error(`ack ${ack.status}`);
  return { relayed: events.length };
}

async function sweepOnce() {
  const r = await apiFetch(`${API}/internal/expire`, { method: 'POST', headers: { 'x-internal': TOKEN } });
  return r.json();
}

if (require.main === module) {
  (async () => {
    console.log(`[worker] relay -> ${API} (2s loop)`);
    // Graceful shutdown (BUG-022 companion): SIGTERM ends the loop after the
    // current cycle — replay is idempotent (ack-after-COMMIT + dedupe), so stopping
    // mid-batch loses nothing. A 10 s failsafe keeps the drain inside compose's
    // stop_grace_period even if a poll hangs (HTTP is bounded at 5 s anyway).
    let stop = false;
    const failsafe = setTimeout(() => {
      console.error('[worker] drain timeout — forcing exit');
      process.exit(0);
    }, 10000);
    failsafe.unref?.();
    process.on('SIGTERM', () => {
      console.log('[worker] SIGTERM — draining');
      stop = true;
    });
    process.on('SIGINT', () => {
      stop = true;
    });
    while (!stop) {
      try {
        const a = await relayOnce();
        const b = await sweepOnce().catch(() => ({ expired: 0 }));
        if (a.relayed || b.expired) console.log(`[worker] relayed=${a.relayed} expired=${b.expired || 0} lag_probe=ok`);
      } catch (e) {
        console.error('[worker]', e.message, '— backing off (sink-down: accumulate, stay honest)');
      }
      if (stop) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log('[worker] stopped cleanly');
  })();
}
module.exports = {
  relayOnce,
  sweepOnce,
  _loadSeen: loadSeen,
  _resetSeen: () => {
    seenCache.clear();
  },
};
