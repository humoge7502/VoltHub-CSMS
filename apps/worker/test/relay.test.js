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
        'INSERT INTO connector_state_event (ts,connector_ref,from_state,to_state,cause,session_id) VALUES'
      )
    );
    assert.ok(
      !joined.includes(
        'meter_tick (ts,session_id,seq_no,connector_ref,meter_kwh,power_kw,voltage_v,current_a,dedupe_key) (ts,'
      )
    );
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
  process.exit(0);
}
main().catch((e) => {
  console.error('RELAY FAIL', e);
  process.exit(1);
});
