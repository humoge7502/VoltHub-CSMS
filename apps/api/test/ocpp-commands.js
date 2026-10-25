// ADR-0018: OCPP 1.6 management command suite.
// Drives the real gateway + REST route against a fake charge point and asserts the
// wire payload, the awaited CALLRESULT, validation, RBAC, rejection and timeout paths.
// Run: node apps/api/test/ocpp-commands.js (RATE_LIMIT_OFF=1).
'use strict';
process.env.RATE_LIMIT_OFF = '1';
process.env.OCPP_ACK_TIMEOUT_MS = '1200';
const assert = require('assert');
const WebSocket = require('ws');

function t(name, fn) {
  return fn()
    .then(() => console.log(`  ocpp-cmd - ${name}`))
    .catch((e) => {
      e.message = `${name}: ${e.message}`;
      throw e;
    });
}

async function main() {
  process.env.PORT = '4115';
  const { server, store } = require('../src/server');
  await new Promise((r) => server.listen(4115, r));
  const B = 'http://localhost:4115/api/v1';
  const api = async (p, o = {}) => {
    const { headers, ...rest } = o;
    const r = await fetch(B + p, {
      ...rest,
      headers: { 'content-type': 'application/json', ...(headers || {}) },
    });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };

  const adminLogin = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@volthub.in', password: 'Admin@123' }),
  });
  assert.ok(adminLogin.j.accessToken, 'seeded admin login');
  const AH = { Authorization: `Bearer ${adminLogin.j.accessToken}` };

  const cp = [...store.cps.values()].find((x) => x.ocpp_identity);
  assert.ok(cp, 'need a seeded charge point');
  const secret = cp.auth_secret || `dev-${cp.ocpp_identity}`;
  const ws = new WebSocket(`ws://localhost:4115/ocpp/${cp.ocpp_identity}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${cp.ocpp_identity}:${secret}`).toString('base64')}` },
  });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });

  const seen = [];
  let mode = 'normal';
  const config = new Map([
    ['HeartbeatInterval', '60'],
    ['ChargePointVendor', 'VoltHub'],
  ]);
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!Array.isArray(m) || m[0] !== 2) return;
    seen.push(m);
    if (mode === 'silent') return;
    if (mode === 'callerror') return ws.send(JSON.stringify([4, m[1], 'InternalError', 'fake failure', {}]));
    const [, uid, action, payload] = m;
    let result = { status: 'Accepted' };
    if (action === 'UnlockConnector') result = { status: 'Unlocked' };
    else if (action === 'Reset' && payload?.type === 'Hard') result = { status: 'Rejected' };
    else if (action === 'GetConfiguration') {
      const wanted = Array.isArray(payload?.key) ? payload.key : [...config.keys()];
      result = {
        configurationKey: wanted
          .filter((k) => config.has(k))
          .map((k) => ({ key: k, readonly: false, value: config.get(k) })),
        unknownKey: wanted.filter((k) => !config.has(k)),
      };
    } else if (action === 'ChangeConfiguration') config.set(payload.key, payload.value);
    else if (action === 'DataTransfer') result = { status: 'Accepted', data: 'echo' };
    ws.send(JSON.stringify([3, uid, result]));
  });

  const waitFor = async (action, predicate = () => true, timeoutMs = 3000) => {
    const t0 = Date.now();
    for (;;) {
      const hit = seen.find((m) => m[2] === action && predicate(m[3] || {}));
      if (hit) return hit;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${action}; seen=${JSON.stringify(seen)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const cmd = (action, body = {}, headers = AH) =>
    api(`/control/cp/${cp.cp_id}/commands/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

  try {
    await t('M1 catalog is operator-readable and lists the full suite', async () => {
      const op = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'arjun@volthub.in', password: 'Operator@123' }),
      });
      assert.ok(op.j.accessToken, 'operator login');
      const r = await api('/control/commands', { headers: { Authorization: `Bearer ${op.j.accessToken}` } });
      assert.equal(r.status, 200);
      assert.equal(r.j.commands.length, 10, `want 10 commands, got ${r.j.commands.length}`);
      const inventory = await api('/admin/charge-points', { headers: AH });
      assert.equal(inventory.status, 200, JSON.stringify(inventory.j));
      assert.ok(inventory.j.charge_points.length >= 1, 'seeded charge points');
      assert.ok(
        inventory.j.charge_points.every((c) => c.auth_secret === undefined),
        'inventory must not leak secrets'
      );
      assert.ok(
        inventory.j.charge_points.some((c) => c.ocpp_identity === cp.ocpp_identity),
        'connected CP listed'
      );
      const actions = r.j.commands.map((c) => c.action);
      for (const a of [
        'Reset',
        'UnlockConnector',
        'ChangeAvailability',
        'GetConfiguration',
        'ChangeConfiguration',
        'TriggerMessage',
        'ReserveNow',
        'CancelReservation',
        'ClearCache',
        'DataTransfer',
      ])
        assert.ok(actions.includes(a), `catalog missing ${a}`);
      const anon = await api('/control/commands');
      assert.equal(anon.status, 401);
    });

    await t('M2 reset/unlock/availability/trigger/clearCache await real answers', async () => {
      const reset = await cmd('reset', { type: 'Soft' });
      assert.equal(reset.status, 200, JSON.stringify(reset.j));
      assert.equal(reset.j.command.status, 'Accepted');
      const frame = await waitFor('Reset', (p) => p.type === 'Soft');
      assert.ok(frame[1], 'Reset carries a CSMS call id');

      const unlock = await cmd('unlockConnector', { connectorId: 1 });
      assert.equal(unlock.status, 200);
      assert.equal(unlock.j.command.status, 'Unlocked');
      await waitFor('UnlockConnector', (p) => p.connectorId === 1);

      const avail = await cmd('changeAvailability', { connectorId: 0, type: 'Inoperative' });
      assert.equal(avail.status, 200);
      assert.equal(avail.j.command.status, 'Accepted');

      const trig = await cmd('triggerMessage', { requestedMessage: 'MeterValues', connectorId: 1 });
      assert.equal(trig.status, 200);
      await waitFor('TriggerMessage', (p) => p.requestedMessage === 'MeterValues' && p.connectorId === 1);

      const cache = await cmd('clearCache');
      assert.equal(cache.status, 200);
      assert.equal(cache.j.command.status, 'Accepted');
    });

    await t('M3 GetConfiguration returns the CP payload, not a status', async () => {
      const r = await cmd('getConfiguration', { key: ['HeartbeatInterval', 'NoSuchKey'] });
      assert.equal(r.status, 200, JSON.stringify(r.j));
      assert.equal(r.j.command.status, null);
      assert.equal(r.j.command.accepted, true);
      assert.deepEqual(r.j.command.payload.unknownKey, ['NoSuchKey']);
      assert.equal(r.j.command.payload.configurationKey[0].value, '60');
    });

    await t('M4 ChangeConfiguration is reflected by a later GetConfiguration', async () => {
      const set = await cmd('changeConfiguration', { key: 'HeartbeatInterval', value: '90' });
      assert.equal(set.status, 200, JSON.stringify(set.j));
      assert.equal(set.j.command.status, 'Accepted');
      const get = await cmd('getConfiguration', { key: ['HeartbeatInterval'] });
      assert.equal(get.j.command.payload.configurationKey[0].value, '90');
    });

    await t('M5 reserveNow/cancelReservation/dataTransfer round-trip', async () => {
      const expiry = new Date(Date.now() + 3600e3).toISOString();
      const reserve = await cmd('reserveNow', {
        connectorId: 1,
        expiryDate: expiry,
        idTag: 'TAG-1',
        reservationId: 4242,
      });
      assert.equal(reserve.status, 200, JSON.stringify(reserve.j));
      await waitFor('ReserveNow', (p) => p.reservationId === 4242 && p.expiryDate === expiry);

      const cancel = await cmd('cancelReservation', { reservationId: 4242 });
      assert.equal(cancel.status, 200);
      await waitFor('CancelReservation', (p) => p.reservationId === 4242);

      const dt = await cmd('dataTransfer', { vendorId: 'com.volthub.test', messageId: 'm1', data: 'x' });
      assert.equal(dt.status, 200);
      assert.equal(dt.j.command.payload.data, 'echo');
    });

    await t('M6 a Rejected CALLRESULT is an HTTP 409 with code OCPP_REJECTED', async () => {
      const r = await cmd('reset', { type: 'Hard' });
      assert.equal(r.status, 409, JSON.stringify(r.j));
      assert.equal(r.j.error.code, 'OCPP_REJECTED');
      assert.equal(r.j.error.ocpp.status, 'Rejected');
    });

    await t('M7 CALLERROR surfaces as 502, never as Accepted', async () => {
      mode = 'callerror';
      const r = await cmd('clearCache');
      assert.equal(r.status, 502, JSON.stringify(r.j));
      assert.equal(r.j.error.code, 'InternalError');
      mode = 'normal';
    });

    await t('M8 timeout returns 504 and does not leave a pending call', async () => {
      mode = 'silent';
      const before = require('../src/ocpp/gateway').pendingCallCount();
      const r = await cmd('clearCache');
      assert.equal(r.status, 504, JSON.stringify(r.j));
      assert.equal(r.j.error.code, 'CP_TIMEOUT');
      const after = require('../src/ocpp/gateway').pendingCallCount();
      assert.equal(after, before, `pending calls leaked: ${before} -> ${after}`);
      mode = 'normal';
    });

    await t('M9 validation and RBAC are fail-closed', async () => {
      const unknown = await cmd('eraseFirmware', {});
      assert.equal(unknown.status, 400, JSON.stringify(unknown.j));
      assert.equal(unknown.j.error.code, 'VALIDATION');
      const field = await cmd('reset', { type: 'Soft', evil: true });
      assert.equal(field.status, 400);
      const conn = await cmd('unlockConnector', { connectorId: 0 });
      assert.equal(conn.status, 400);
      const tag = await cmd('reserveNow', {
        connectorId: 1,
        expiryDate: new Date().toISOString(),
        idTag: 'x'.repeat(21),
        reservationId: 1,
      });
      assert.equal(tag.status, 400);
      const op = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'arjun@volthub.in', password: 'Operator@123' }),
      });
      const denied = await cmd('reset', {}, { Authorization: `Bearer ${op.j.accessToken}` });
      assert.equal(denied.status, 403, 'operator must not actuate hardware commands');
      const driver = await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email: `cmddrv${Date.now()}@example.in`, password: 'Driver@123', full_name: 'Cmd' }),
      });
      const denied2 = await cmd('reset', {}, { Authorization: `Bearer ${driver.j.accessToken}` });
      assert.equal(denied2.status, 403);
    });

    await t('M10 an offline charge point is 409 CP_OFFLINE, not a hung request', async () => {
      await new Promise((res) => {
        ws.once('close', res);
        ws.close();
      });
      await new Promise((r) => setTimeout(r, 100));
      const r = await cmd('clearCache');
      assert.equal(r.status, 409, JSON.stringify(r.j));
      assert.equal(r.j.error.code, 'CP_OFFLINE');
    });

    console.log('\nocpp-commands: 10/10 passed');
  } finally {
    try {
      ws.close();
    } catch {}
    await new Promise((res) => server.close(res));
  }
}

main().catch((e) => {
  console.error('OCPP-COMMANDS FAIL', e);
  process.exitCode = 1;
});
