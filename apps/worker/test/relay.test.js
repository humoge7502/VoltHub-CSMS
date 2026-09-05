// Worker relay unit tests (no DB needed): station_map sync upsert + error paths.
// Run: node apps/worker/test/relay.test.js
'use strict';
const assert = require('assert');

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
      joined.includes('INSERT INTO station_map (connector_ref, station_id, station_name, standard_code, max_power_kw)')
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

  console.log(`\nrelay: ${pass} tests passed`);
  process.exit(0);
}
main().catch((e) => {
  console.error('RELAY FAIL', e);
  process.exit(1);
});
