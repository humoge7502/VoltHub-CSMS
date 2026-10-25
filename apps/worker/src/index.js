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
let lastStationSync = 0;
// O.2 / §11.4: relay lag the console and Grafana page on. The queue is drained by
// this loop, so "pending" here is the operator-visible definition of staleness.
const LAG_SLO_SECONDS = Math.max(5, Number(process.env.RELAY_LAG_SLO_SECONDS || 120));
let lastLagWarn = 0;
function lagWarn(out) {
  if (!out || !out.oldest_age_s || out.oldest_age_s < LAG_SLO_SECONDS) return;
  const now = Date.now();
  if (now - lastLagWarn < 30000) return; // one warning per 30 s, not one per 2 s poll
  lastLagWarn = now;
  console.warn(
    `[worker] LAG SLO BREACH: oldest unacked event is ${out.oldest_age_s}s old (SLO ${LAG_SLO_SECONDS}s), ` +
      `pending=${out.pending} — sink down or relay slower than the fleet`
  );
}

async function relayOnce(opts = {}) {
  const doFetch = opts.fetchImpl || apiFetch;
  const outFile = opts.outFile || OUT;
  // Prod path (TS_HOST set): batched COPY into hypertables; ack only after COMMIT.
  if (process.env.TS_HOST) {
    const { relayToTimescale, syncStationMap } = require('./relay-timescale');
    // Masterplan §26.5: keep Timescale station_map in step with Oracle-owned station
    // metadata (cheap full upsert; powers v_tick_*_enriched + Grafana). Failures log
    // and back off with the loop — they must not stall event relay.
    // PERF: station metadata changes when a commissioning engineer edits a station,
    // not every 2 seconds, so the full upsert is throttled. Before this the worker
    // re-synced every connector on every poll: 30 HTTP requests and 30 upserts a
    // minute per worker for data that is essentially static.
    const now = Date.now();
    const throttleMs = Math.max(5000, Number(process.env.STATION_MAP_SYNC_SECONDS || 60) * 1000);
    if (now - lastStationSync >= throttleMs) {
      lastStationSync = now;
      await syncStationMap(API, TOKEN, doFetch)
        .then((r) => {
          if (r.skipped) console.warn(`[worker] station-map: ${r.skipped} row(s) rejected by Timescale`);
        })
        .catch((e) => {
          lastStationSync = 0; // a failed sync must be retried on the next cycle
          console.error('[worker] station-map sync:', e.message);
        });
    }
    const out = await relayToTimescale(API, TOKEN, doFetch);
    lagWarn(out);
    if (out.quarantined) console.warn(`[worker] quarantined ${out.quarantined} poison event(s) -> /ops/dead-letters`);
    return out;
  }
  const r = await doFetch(`${API}/internal/outbox`, { headers: { 'x-internal': TOKEN } });
  if (!r.ok) throw new Error(`outbox poll ${r.status}`);
  const body = await r.json();
  const events = body.events || [];
  const lag = { pending: Number(body.pending || 0), oldest_age_s: Number(body.oldest_age_s || 0) };
  if (!events.length) return { relayed: 0, ...lag };
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
    body: JSON.stringify({ ids: events.map((e) => e.event_id), keys: events.map((e) => e.dedupe_key) }),
  });
  if (!ack.ok) throw new Error(`ack ${ack.status}`);
  lagWarn(lag);
  return { relayed: events.length, ...lag };
}

async function sweepOnce() {
  const r = await apiFetch(`${API}/internal/expire`, { method: 'POST', headers: { 'x-internal': TOKEN } });
  return r.json();
}

if (require.main === module) {
  (async () => {
    // SEC-069: the published dev token must not drive a production relay. Without this
    // the worker would poll forever and every /internal call would be refused (the API
    // fails such tokens closed), looking like a silent telemetry outage.
    if (
      process.env.NODE_ENV === 'production' &&
      (!process.env.INTERNAL_TOKEN ||
        process.env.INTERNAL_TOKEN.length < 24 ||
        /^(dev-internal|change_me|replace_with_)/.test(process.env.INTERNAL_TOKEN))
    ) {
      console.error(
        '[worker] FATAL: INTERNAL_TOKEN missing, shorter than 24 chars, or a published dev value with NODE_ENV=production.'
      );
      process.exit(1);
    }
    console.log(`[worker] relay -> ${API} (2s loop)`);
    // Graceful shutdown (BUG-022 companion): SIGTERM ends the loop after the
    // current cycle — replay is idempotent (ack-after-COMMIT + dedupe), so stopping
    // mid-batch loses nothing. A 10 s failsafe armed ONLY when draining begins keeps
    // a hung poll inside compose's stop_grace_period (HTTP is bounded at 5 s anyway).
    // BUG-0xx fix: the failsafe used to be armed at boot, which force-exited the
    // worker ~10 s after every start — compose restart-looped it and each boot
    // relayed a batch, masking the bug while bloating restart counts.
    let stop = false;
    const armFailsafe = () => {
      const failsafe = setTimeout(() => {
        console.error('[worker] drain timeout — forcing exit');
        process.exit(0);
      }, 10000);
      failsafe.unref?.();
    };
    const shutdown = () => {
      console.log('[worker] SIGTERM — draining');
      stop = true;
      armFailsafe();
      // Close the shared Timescale pool so compose sees a clean exit instead of
      // waiting on idle sockets (relay-timescale.js keeps one pool for the process).
      if (process.env.TS_HOST) {
        try {
          require('./relay-timescale')
            .releasePool()
            .catch(() => {});
        } catch {}
      }
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    // PF-09: drain while the queue is behind instead of one 500-event batch per 2 s
    // (a hard 250 events/s ceiling). The batch cap keeps a single cycle bounded so
    // shutdown and the expiry sweep still get a turn.
    const MAX_BATCHES_PER_CYCLE = Math.max(1, Number(process.env.RELAY_MAX_BATCHES_PER_CYCLE || 8));
    while (!stop) {
      let drained = 0;
      let last = null;
      try {
        for (let i = 0; i < MAX_BATCHES_PER_CYCLE && !stop; i++) {
          const a = await relayOnce();
          last = a;
          drained += Number(a.relayed) || 0;
          if (!a.pending || !a.relayed) break;
        }
        const b = await sweepOnce().catch(() => ({ expired: 0 }));
        if (drained || b.expired) {
          // Measured backlog, not a probe that always prints "ok": a relay that is
          // running but 10 minutes behind has to look different in the logs.
          const lag = `pending=${last?.pending || 0} oldest=${last?.oldest_age_s || 0}s`;
          console.log(`[worker] relayed=${drained} expired=${b.expired || 0} ${lag}`);
        }
      } catch (e) {
        console.error('[worker]', e.message, '— backing off (sink-down: accumulate, stay honest)');
      }
      if (stop) break;
      // Caught up: the historical 2 s heartbeat. Behind: keep the pressure on, but
      // yield the loop so a stop signal and the expiry sweep are not starved.
      const behind = last && Number(last.pending) > 0;
      await new Promise((r) => setTimeout(r, behind ? 250 : 2000));
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
