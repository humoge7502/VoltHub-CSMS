// Worker relay unit tests (no DB needed): station_map sync upsert + error paths
// + RESIL chaos cases (API down / ack failure / recovery drain — injected via the
// relayOnce test seams; the real data/ mirror is never touched).
// Run: node apps/worker/test/relay.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  const rt = require('../src/relay-timescale');
  rt._setPoolFactory(() => null); // ensure real pg is never touched below

  let pass = 0;
  const t = async (name, fn) => {
    await fn();
    pass++;
    console.log(`  relay ${pass} - ${name}`);
  };

  await t('syncStationMap upserts rows from the API station-map endpoint', async () => {
    const calls = { sql: [], vals: [] };
    const client = {
      async query(text, vals) {
        calls.sql.push(text);
        calls.vals.push(vals || []);
        return { rowCount: 1 };
      },
      release() {},
    };
    rt._setPoolFactory(() => ({ connect: async () => client, end: async () => {} }));
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        rows: [
          {
            connector_ref: '1:1',
            station_id: 1,
            station_name: 'VIT Chennai Gate',
            standard_code: 'CCS2',
            max_power_kw: 60,
          },
          {
            connector_ref: '4:2',
            station_id: 4,
            station_name: 'ECR Highway Stop',
            standard_code: 'CCS2',
            max_power_kw: 120,
          },
        ],
      }),
    });
    const out = await rt.syncStationMap('http://api/v1', 'tok', fetchImpl);
    assert.equal(out.synced, 2);
    const joined = calls.sql.join('\n');
    assert.ok(joined.includes('BEGIN'));
    assert.ok(
      joined.includes(
        'INSERT INTO station_map (connector_ref,station_id,station_name,standard_code,max_power_kw) VALUES'
      )
    );
    assert.ok(joined.includes('ON CONFLICT (connector_ref) DO UPDATE SET station_id = EXCLUDED.station_id'));
    const insertVals = calls.vals.flat().map(String);
    assert.ok(insertVals.includes('1:1') && insertVals.includes('ECR Highway Stop') && insertVals.includes('CCS2'));
    assert.ok(joined.includes('COMMIT'));
  });

  await t('syncStationMap skips silently when the API has no stations', async () => {
    rt._setPoolFactory(() => {
      throw new Error('pool must not be opened for empty rows');
    });
    const fetchImpl = async () => ({ ok: true, json: async () => ({ rows: [] }) });
    const out = await rt.syncStationMap('http://api/v1', 'tok', fetchImpl);
    assert.deepEqual(out, { synced: 0 });
  });

  await t('syncStationMap surfaces API errors', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403 });
    await assert.rejects(() => rt.syncStationMap('http://api/v1', 'bad', fetchImpl), /station-map poll 403/);
  });

  await t('relayToTimescale INSERTs carry a single column list (no double-parens bug)', async () => {
    const calls = { sql: [], acks: 0 };
    const client = {
      async query(text) {
        calls.sql.push(text);
        return { rowCount: 1 };
      },
      release() {},
    };
    rt._setPoolFactory(() => ({ connect: async () => client, end: async () => {} }));
    const fetchImpl = async (url) => {
      if (url.endsWith('/internal/outbox')) {
        return {
          ok: true,
          json: async () => ({
            events: [
              {
                event_id: 1,
                dedupe_key: 'm1',
                kind: 'METER_TICK',
                payload: {
                  session_id: 7,
                  ts: '2026-09-05T00:00:00Z',
                  seq: 1,
                  connector_ref: '1:1',
                  meter_kwh: 12.5,
                  power_kw: 30,
                },
              },
              {
                event_id: 2,
                dedupe_key: 's1',
                kind: 'CONNECTOR_STATE',
                payload: { connector_ref: '1:1', from: 'AVAILABLE', to: 'OCCUPIED', cause: 'OCPP' },
              },
            ],
          }),
        };
      }
      if (url.endsWith('/internal/outbox/ack')) {
        calls.acks++;
        return { ok: true };
      }
      return { ok: false, status: 404 };
    };
    const out = await rt.relayToTimescale('http://api/v1', 'tok', fetchImpl);
    assert.equal(out.relayed, 2);
    assert.equal(out.ticks, 1);
    assert.equal(out.states, 1);
    assert.equal(calls.acks, 1);
    const joined = calls.sql.join('\n');
    // The INSERT must contain exactly one column list each — a duplicated one (the
    // old table='meter_tick (…)' + cols bug) was a syntax error at "connector_ref".
    assert.ok(
      joined.includes(
        'INSERT INTO meter_tick (ts,session_id,seq_no,connector_ref,meter_kwh,power_kw,voltage_v,current_a,dedupe_key) VALUES'
      )
    );
    assert.ok(
      joined.includes(
        'INSERT INTO connector_state_event (ts,connector_ref,from_state,to_state,cause,session_id,dedupe_key) VALUES'
      )
    );
    assert.ok(
      !joined.includes(
        'meter_tick (ts,session_id,seq_no,connector_ref,meter_kwh,power_kw,voltage_v,current_a,dedupe_key) (ts,'
      )
    );
  });

  // ---- B-27: the state row must carry its pipeline identity ----
  await t('connector_state_event INSERT carries dedupe_key (same-second transitions survive)', async () => {
    const calls = { sql: [], vals: [] };
    const client = {
      async query(text, vals) {
        calls.sql.push(text);
        calls.vals.push(vals || []);
        return { rowCount: 1 };
      },
      release() {},
    };
    rt._setPoolFactory(() => ({ connect: async () => client, end: async () => {} }));
    const tick = (id, key, seq) => ({
      event_id: id,
      dedupe_key: key,
      kind: 'METER_TICK',
      payload: { session_id: 9, ts: '2026-09-05T00:00:00Z', seq, connector_ref: '1:1', meter_kwh: 1 },
    });
    const st = (id, key, to, ts) => ({
      event_id: id,
      dedupe_key: key,
      kind: 'CONNECTOR_STATE',
      created_at: ts,
      payload: { connector_ref: '1:1', from: 'OCCUPIED', to, cause: 'OCPP' },
    });
    const fetchImpl = async (url) => {
      if (url.endsWith('/internal/outbox'))
        return {
          ok: true,
          json: async () => ({
            events: [
              st(1, 'c1', 'CHARGING', '2026-09-05T10:00:00.200Z'),
              st(2, 'c2', 'FINISHING', '2026-09-05T10:00:00.900Z'),
              tick(3, 't1', 1),
            ],
          }),
        };
      if (url.endsWith('/internal/outbox/ack')) return { ok: true };
      return { ok: false, status: 404 };
    };
    const out = await rt.relayToTimescale('http://api/v1', 'tok', fetchImpl);
    assert.equal(out.states, 2, 'both transitions are written, not collapsed into one PK slot');
    // ts is still second-truncated, so the ONLY thing separating the two rows is the key.
    const stateSql = calls.sql.find((s) => s.includes('INSERT INTO connector_state_event'));
    assert.ok(stateSql.includes('VALUES ($1,$2,$3,$4,$5,$6,$7),($8,$9,$10,$11,$12,$13,$14)'));
    const stateVals = calls.vals.find((v) => v.length === 14);
    assert.deepEqual(
      [stateVals[6], stateVals[13]],
      ['c1', 'c2'],
      'dedupe_key is bound per row — T001/T004 make it part of the primary key'
    );
    assert.equal(
      stateVals[0].getTime(),
      stateVals[7].getTime(),
      'both transitions collapse onto the same second; only the key keeps them distinct'
    );
    assert.equal(out.ticks, 1);
  });

  // ---- Pool lifecycle (PERF: one pool per worker process, not one per 2 s poll) ----
  await t('the relay reuses one pool across polls and reopens only after releasePool', async () => {
    let opens = 0;
    const client = {
      async query() {
        return { rowCount: 1 };
      },
      release() {},
    };
    rt._setPoolFactory(() => {
      opens++;
      return { connect: async () => client, end: async () => {} };
    });
    const fetchImpl = async (url) => {
      if (url.endsWith('/internal/outbox'))
        return {
          ok: true,
          json: async () => ({
            events: [
              {
                event_id: 1,
                dedupe_key: 'p1',
                kind: 'METER_TICK',
                payload: { session_id: 1, seq: 1, ts: '2026-09-05T00:00:00Z', connector_ref: '1:1', meter_kwh: 1 },
              },
            ],
          }),
        };
      if (url.endsWith('/internal/outbox/ack')) return { ok: true };
      return { ok: false, status: 404 };
    };
    await rt.relayToTimescale('http://api/v1', 'tok', fetchImpl);
    await rt.relayToTimescale('http://api/v1', 'tok', fetchImpl);
    assert.equal(opens, 1, 'two cycles must not open two pools');
    await rt.releasePool();
    await rt.relayToTimescale('http://api/v1', 'tok', fetchImpl);
    assert.equal(opens, 2, 'releasePool() (SIGTERM drain) lets the next cycle rebuild');
  });

  // ---- Poison isolation: ONE bad row must not freeze the queue behind it ----
  const pgErr = (message, code) => Object.assign(new Error(message), { code });
  const threeTicks = [
    {
      event_id: 1,
      dedupe_key: 'k1',
      kind: 'METER_TICK',
      payload: { session_id: 1, seq: 1, ts: '2026-09-05T00:00:00Z', connector_ref: '1:1', meter_kwh: 1 },
    },
    {
      event_id: 2,
      dedupe_key: 'k2',
      kind: 'METER_TICK',
      payload: { session_id: 1, seq: 2, ts: '2026-09-05T00:00:01Z', connector_ref: '1:1', meter_kwh: 2 },
    },
    // meter_kwh is NOT NULL in T001; a package that emits a value the sink cannot
    // represent is the realistic poison (class 22 data exception), and it sat at the
    // head of the queue. 1e308 is a *finite* JS number, so the relay's pre-screen
    // lets it through and the mock sink rejects it the way numeric(12,4) would.
    {
      event_id: 3,
      dedupe_key: 'k3',
      kind: 'METER_TICK',
      payload: { session_id: 1, seq: 3, ts: '2026-09-05T00:00:02Z', connector_ref: '1:1', meter_kwh: 1e308 },
    },
  ];
  function poisonHarness({ failOn }) {
    const seen = { batchTried: 0, landed: [], quarantine: null, ack: null };
    const client = {
      async query(text, vals) {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rowCount: 0 };
        if (!text.startsWith('INSERT INTO meter_tick')) return { rowCount: 1 };
        seen.batchTried++;
        // First call is the whole batch (3 rows in one statement); later ones are per row.
        const isBatch = (vals || []).length > 9;
        const poison = (vals || []).some((v) => v === 1e308);
        if (poison && failOn) throw pgErr('numeric field overflow', '22003');
        if (isBatch && failOn) throw pgErr('numeric field overflow', '22003');
        seen.landed.push(vals);
        return { rowCount: 1 };
      },
      release() {},
    };
    rt._setPoolFactory(() => ({ connect: async () => client, end: async () => {} }));
    const fetchImpl = async (url, opts = {}) => {
      if (url.endsWith('/internal/outbox'))
        return { ok: true, json: async () => ({ events: threeTicks, pending: 3, oldest_age_s: 40 }) };
      if (url.endsWith('/internal/outbox/quarantine')) {
        seen.quarantine = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ quarantined: seen.quarantine.keys.length }) };
      }
      if (url.endsWith('/internal/outbox/ack')) {
        seen.ack = JSON.parse(opts.body);
        return { ok: true };
      }
      return { ok: false, status: 404 };
    };
    return { seen, fetchImpl };
  }

  await t('poison: batch rejected → rows retried alone, bad key quarantined, good keys acked', async () => {
    const { seen, fetchImpl } = poisonHarness({ failOn: true });
    const out = await rt.relayToTimescale('http://api/v1', 'tok', fetchImpl);
    assert.equal(out.ticks, 2, 'the two writable rows land even though the batch failed');
    assert.equal(out.quarantined, 1);
    assert.deepEqual(seen.quarantine.keys, ['k3'], 'only the poison key is dead-lettered');
    assert.deepEqual(seen.quarantine.ids, [3]);
    assert.ok(/meter_tick 22003/.test(seen.quarantine.reason), 'the sink error is the triage reason');
    assert.deepEqual(seen.ack.keys, ['k1', 'k2'], 'poison is never acked by the ack call — quarantine owns it');
    assert.deepEqual(seen.ack.ids, [1, 2]);
    assert.equal(out.pending, 3, 'the API-measured lag rides back to the caller');
  });

  await t('poison: non-finite meter_kwh is refused before the sink and triaged by name', async () => {
    const seen = { quarantine: null, ack: null };
    const events = [
      {
        event_id: 1,
        dedupe_key: 'p1',
        kind: 'METER_TICK',
        payload: { session_id: 1, seq: 1, ts: '2026-09-05T00:00:00Z', connector_ref: '1:1', meter_kwh: 1 },
      },
      {
        event_id: 2,
        dedupe_key: 'p2',
        kind: 'METER_TICK',
        payload: { session_id: 1, seq: 2, ts: '2026-09-05T00:00:01Z', connector_ref: '1:1', meter_kwh: NaN },
      },
    ];
    const client = { query: async () => ({ rowCount: 1 }), release() {} };
    rt._setPoolFactory(() => ({ connect: async () => client, end: async () => {} }));
    const fetchImpl = async (url, opts = {}) => {
      if (url.endsWith('/internal/outbox')) return { ok: true, json: async () => ({ events }) };
      if (url.endsWith('/internal/outbox/quarantine')) {
        seen.quarantine = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ quarantined: 1 }) };
      }
      if (url.endsWith('/internal/outbox/ack')) {
        seen.ack = JSON.parse(opts.body);
        return { ok: true };
      }
      return { ok: false, status: 404 };
    };
    const out = await rt.relayToTimescale('http://api/v1', 'tok', fetchImpl);
    assert.equal(out.ticks, 1, 'the finite row still lands');
    assert.equal(out.quarantined, 1);
    assert.deepEqual(seen.quarantine.ids, [2]);
    assert.match(seen.quarantine.reason, /meter_tick refuses non-finite meter_kwh: NaN/);
    assert.deepEqual(seen.ack.ids, [1], 'the refused event is not acked — quarantine owns it');
  });

  await t('poison: every row refused → nothing is dead-lettered, the queue keeps its events', async () => {
    // Systemic failure (a sink bug, not a bad event). Quarantining here would throw
    // away telemetry that a retry would have written, so the relay must fail loudly.
    const { seen, fetchImpl } = poisonHarness({ failOn: true });
    const client = {
      query: async () => {
        throw pgErr('permission denied for table meter_tick', '42501');
      },
      release() {},
    };
    rt._setPoolFactory(() => ({ connect: async () => client, end: async () => {} }));
    await assert.rejects(() => rt.relayToTimescale('http://api/v1', 'tok', fetchImpl), /schema drift/);
    rt._setPoolFactory(() => ({
      connect: async () => ({
        async query(text) {
          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rowCount: 0 };
          seen.batchTried++;
          throw pgErr('null value in column "meter_kwh" violates not-null constraint', '23502');
        },
        release() {},
      }),
      end: async () => {},
    }));
    await assert.rejects(() => rt.relayToTimescale('http://api/v1', 'tok', fetchImpl), /wrote 0\/3 rows/);
    assert.equal(seen.quarantine, null, 'a systemic error must not mass-dead-letter the queue');
    assert.equal(seen.ack, null, 'and it must not ack what it did not write');
  });

  await t('sink down (08xxx) → back off: no ack, no quarantine, events stay in the queue', async () => {
    const seen = { ack: null, quarantine: null };
    const client = {
      async query(text) {
        if (text === 'BEGIN') throw pgErr('connection to server failed', '08006');
        return { rowCount: 1 };
      },
      release() {},
    };
    rt._setPoolFactory(() => ({ connect: async () => client, end: async () => {} }));
    const fetchImpl = async (url, opts = {}) => {
      if (url.endsWith('/internal/outbox'))
        return { ok: true, json: async () => ({ events: threeTicks, pending: 3, oldest_age_s: 10 }) };
      if (url.endsWith('/internal/outbox/ack')) {
        seen.ack = JSON.parse(opts.body);
        return { ok: true };
      }
      if (url.endsWith('/internal/outbox/quarantine')) {
        seen.quarantine = JSON.parse(opts.body);
        return { ok: true };
      }
      return { ok: false, status: 404 };
    };
    await assert.rejects(() => rt.relayToTimescale('http://api/v1', 'tok', fetchImpl), /connection to server failed/);
    assert.equal(seen.ack, null, 'at-least-once: nothing leaves the queue until it is written');
    assert.equal(seen.quarantine, null, 'the events are fine — only the sink is not');
  });

  await t('station-map: one malformed station no longer rolls back the other 46', async () => {
    const landed = [];
    const client = {
      async query(text, vals) {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rowCount: 0 };
        const bad = (vals || []).some(
          (v) => v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v))
        );
        if (bad) throw pgErr('invalid input syntax for type integer', '22P02');
        landed.push(text);
        return { rowCount: 1 };
      },
      release() {},
    };
    rt._setPoolFactory(() => ({ connect: async () => client, end: async () => {} }));
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        rows: [
          { connector_ref: '1:1', station_id: 1, station_name: 'A', standard_code: 'CCS2', max_power_kw: 60 },
          { connector_ref: '2:1', station_id: NaN, station_name: 'B', standard_code: 'CCS2', max_power_kw: 60 },
          { connector_ref: '3:1', station_id: 3, station_name: 'C', standard_code: 'CCS2', max_power_kw: 60 },
        ],
      }),
    });
    const out = await rt.syncStationMap('http://api/v1', 'tok', fetchImpl);
    assert.equal(out.synced, 2, 'the two valid connectors are enriched');
    assert.equal(out.skipped, 1);
    assert.equal(landed.length, 2);
  });

  // ---- RESIL chaos cases (local-mode relay via the injectable seams) ----
  const worker = require('../src/index');
  const tmpMirror = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vh-relay-')), 'mirror.jsonl');
  const lines = (file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).dedupe_key);
  const ev = (id, key) => ({ event_id: id, dedupe_key: key, kind: 'METER_TICK', payload: {} });

  await t('chaos: API down → relayOnce throws, mirror untouched (events accumulate API-side)', async () => {
    worker._resetSeen();
    const file = tmpMirror();
    const down = async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:4000');
    };
    await assert.rejects(() => worker.relayOnce({ fetchImpl: down, outFile: file }), /ECONNREFUSED/);
    assert.ok(!fs.existsSync(file), 'a failed poll must never write the mirror');
  });

  await t('chaos: ack failure after append → replay dedupes (no duplicate lines), ack retried', async () => {
    worker._resetSeen();
    const file = tmpMirror();
    let acks = 0;
    let ackOk = false;
    const flaky = async (url) => {
      if (url.endsWith('/internal/outbox')) {
        return { ok: true, json: async () => ({ events: [ev(1, 'c1'), ev(2, 'c2')] }) };
      }
      if (url.endsWith('/internal/outbox/ack')) {
        acks++;
        if (!ackOk) return { ok: false, status: 500 };
        return { ok: true };
      }
      return { ok: false, status: 404 };
    };
    // Cycle 1: append succeeds, ack 500 → the loop must throw (events NOT acked).
    await assert.rejects(() => worker.relayOnce({ fetchImpl: flaky, outFile: file }), /ack 500/);
    assert.deepEqual(lines(file).sort(), ['c1', 'c2'], 'events are durably mirrored before the ack');
    // Cycle 2: same events re-polled → dedupe must skip the append, ack succeeds.
    ackOk = true;
    const out = await worker.relayOnce({ fetchImpl: flaky, outFile: file });
    assert.equal(out.relayed, 2);
    assert.equal(acks, 2, 'ack must be retried on the next cycle');
    assert.deepEqual(lines(file).sort(), ['c1', 'c2'], 'crash-after-append must not duplicate lines');
  });

  await t('chaos: recovery drain — an outage backlog relays exactly once on recovery', async () => {
    worker._resetSeen();
    const file = tmpMirror();
    let up = false;
    const api = async (url) => {
      if (!up) throw new Error('ECONNREFUSED');
      if (url.endsWith('/internal/outbox')) {
        return {
          ok: true,
          json: async () => ({ events: [ev(1, 'r1'), ev(2, 'r2'), ev(3, 'r3')] }),
        };
      }
      if (url.endsWith('/internal/outbox/ack')) return { ok: true };
      return { ok: false, status: 404 };
    };
    // outage cycles: every poll fails, nothing is written
    await assert.rejects(() => worker.relayOnce({ fetchImpl: api, outFile: file }));
    await assert.rejects(() => worker.relayOnce({ fetchImpl: api, outFile: file }));
    // recovery: the backlog drains exactly once, no partials, no dupes
    up = true;
    const out = await worker.relayOnce({ fetchImpl: api, outFile: file });
    assert.equal(out.relayed, 3);
    assert.deepEqual(lines(file).sort(), ['r1', 'r2', 'r3']);
    // and a second successful cycle over the same events stays a no-op
    const again = await worker.relayOnce({ fetchImpl: api, outFile: file });
    assert.equal(again.relayed, 3);
    assert.deepEqual(lines(file).sort(), ['r1', 'r2', 'r3'], 'replay must stay idempotent');
  });

  console.log(`\nrelay: ${pass} tests passed`);
  process.exitCode = 0;
}
main().catch((e) => {
  console.error('RELAY FAIL', e);
  process.exitCode = 1;
});
