// Oracle adapter regression tests (SEC-067/SEC-068, review 2026-10-25).
// The adapter is exercised with a scripted fake pool: no Oracle server, but the exact
// statement/bind shape and the local-mirror outcome the durable engine depends on.
// Run: node apps/api/test/oracle-adapter.js
'use strict';
const assert = require('assert');
const { createStore } = require('../src/db/store');
const { seedStore } = require('../src/db/seed');

try {
  require('oracledb');
} catch {
  // Optional dependency absent: the adapter cannot even be constructed (driver() throws).
  console.log('oracle-adapter: SKIP (oracledb not installed)');
  process.exit(0);
}
const { wrapWithOracle } = require('../src/db/oracle');

// A pool that records every statement and answers through `handlers` in call order.
// withConn() leases a fresh connection per call; commit/close are recorded too.
function fakePool(handlers = []) {
  const calls = [];
  const pool = {
    getConnection: async () => ({
      execute: async (sql, binds = {}) => {
        calls.push({ sql, binds });
        const h = handlers.shift();
        return h ? h(sql, binds) : { outBinds: {} };
      },
      commit: async () => calls.push({ sql: 'COMMIT' }),
      close: async () => {},
    }),
  };
  return { pool, calls };
}

async function main() {
  let pass = 0;
  const t = async (name, fn) => {
    await fn();
    pass++;
    console.log(`  ora ${pass} - ${name}`);
  };

  const base = () => {
    const store = createStore();
    seedStore(store, 'demo');
    const driver = [...store.users.values()].find((u) => u.role === 'DRIVER');
    const [cpId, connNo] = [...store.connectors.entries()]
      .find(([, c]) => c.status === 'AVAILABLE')[0]
      .split(':')
      .map(Number);
    const planId = store.plans.keys().next().value;
    return { store, driver, cpId, connNo, planId };
  };

  await t('SEC-067: OCPP meterStop reaches stop_session and is billed from the register', async () => {
    const { store, driver, cpId, connNo, planId } = base();
    const sess = await store.startSession({ uid: driver.user_id, cpId, connNo, planId, meterStartKwh: 10 });
    await store.recordTick(sess.session_id, 1, new Date().toISOString(), 12, 30, 400, 75);
    const { pool, calls } = fakePool();
    const wrapped = wrapWithOracle(store, pool);
    await wrapped.stopSession(sess.session_id, 'OCPP_STOP', 15.5);
    const stop = calls.find((c) => /charge_session_pkg\.stop_session/.test(c.sql));
    assert.ok(stop, 'stop_session package call missing');
    assert.match(stop.sql, /:p_meter_stop/, 'meterStop must be passed as a bind, not dropped');
    assert.equal(stop.binds.p_meter_stop, 15.5);
    assert.equal(store.sessions.get(sess.session_id).end_meter_kwh, 15.5);
    assert.equal(store.sessions.get(sess.session_id).state, 'COMPLETED');
  });

  await t('SEC-067: a stop without meterStop uses the 2-arg package form (MAX reading server-side)', async () => {
    const { store, driver, cpId, connNo, planId } = base();
    const sess = await store.startSession({ uid: driver.user_id, cpId, connNo, planId });
    await store.recordTick(sess.session_id, 1, new Date().toISOString(), 4.25, 30, 400, 75);
    const { pool, calls } = fakePool();
    const wrapped = wrapWithOracle(store, pool);
    await wrapped.stopSession(sess.session_id, 'REMOTE_STOP');
    const stop = calls.find((c) => /charge_session_pkg\.stop_session/.test(c.sql));
    assert.ok(stop);
    assert.doesNotMatch(stop.sql, /p_meter_stop/);
    assert.equal(store.sessions.get(sess.session_id).end_meter_kwh, 4.25);
  });

  await t('SEC-067: a durable METER_REGRESSION maps to the canonical 409 code', async () => {
    const { store, driver, cpId, connNo, planId } = base();
    const sess = await store.startSession({ uid: driver.user_id, cpId, connNo, planId, meterStartKwh: 20 });
    const oraErr = Object.assign(new Error('ORA-20602: ORA-20602: METER_REGRESSION'), { errorNum: -20602 });
    const { pool } = fakePool([
      () => {
        throw oraErr;
      },
    ]);
    const wrapped = wrapWithOracle(store, pool);
    const code = await wrapped.stopSession(sess.session_id, 'OCPP_STOP', 1).then(
      () => 'NO_ERROR',
      (e) => `${e.code}/${e.status}`
    );
    assert.equal(code, 'METER_REGRESSION/409');
    assert.equal(store.sessions.get(sess.session_id).state, 'PREPARING', 'failed durable stop must not mutate local');
  });

  await t('SEC-068: billSession remaps the local mirror to the Oracle invoice id', async () => {
    const { store, driver, cpId, connNo, planId } = base();
    const sess = await store.startSession({ uid: driver.user_id, cpId, connNo, planId, meterStartKwh: 0 });
    await store.recordTick(sess.session_id, 1, new Date().toISOString(), 12, 30, 400, 75);
    await store.stopSession(sess.session_id, 'REMOTE_STOP', 12);
    const localNext = Number(store.seq.inv) + 1;
    const oracleId = localNext + 500;
    const { pool } = fakePool([() => ({ outBinds: { p_invoice: oracleId } })]);
    const wrapped = wrapWithOracle(store, pool);
    const inv = await wrapped.billSession(sess.session_id);
    assert.equal(Number(inv.invoice_id), oracleId);
    assert.ok(store.invoices.has(oracleId), 'invoice must live under the Oracle id');
    assert.ok(!store.invoices.has(localNext), 'local id must not remain addressable');
    assert.ok(
      store.lines.every((l) => Number(l.invoice_id) !== localNext),
      'invoice lines must be remapped'
    );
    assert.ok(store.seq.inv >= oracleId, 'local invoice sequence must be clamped up');
  });

  console.log(`Oracle adapter tests: ${pass} passed`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
