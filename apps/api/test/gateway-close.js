// BUG-021 regression: a reconnecting charge point's stale socket must not
// deregister its live successor. OCPP 1.6J §4 allows one connection per identity;
// when a CP flaps, the gateway closes the OLD socket on the duplicate-connect path.
// The bug: that old socket's 'close' handler ran registry.delete(identity) +
// cp.status='OFFLINE' unconditionally — so a live, healthy socket was deregistered
// and the charger showed OFFLINE (remote-stop/start then 409 CP_OFFLINE).
// Observable contract: after ws1 (stale) closes, the successor ws2 must still
// receive CSMS-initiated CALLs (remote commands resolve via registry.get) and the
// CP must still read ONLINE. Validated to catch the bug: against the unguarded
// handler the remote-stop below returns 409 CP_OFFLINE and cp.status flips OFFLINE.
// Run: node apps/api/test/gateway-close.js (RATE_LIMIT_OFF=1).
'use strict';
process.env.RATE_LIMIT_OFF = '1';
const assert = require('assert');
const WebSocket = require('ws');

async function main() {
  process.env.PORT = '4109';
  const { server, store } = require('../src/server');
  await new Promise((r) => server.listen(4109, r));
  const B = 'http://localhost:4109/api/v1';
  const api = async (p, o = {}) => {
    const { headers, ...rest } = o;
    const r = await fetch(B + p, {
      ...rest,
      headers: { 'content-type': 'application/json', ...(headers || {}) },
    });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  try {
    const registry = global.__ocppRegistry;
    assert.ok(registry, 'gateway registry must be exported on global');
    // Pick a CP that owns an AVAILABLE connector (session start needs one).
    const cpEntry = [...store.cps.values()]
      .map((cp) => ({
        cp,
        conns: [...store.connectors.values()].filter((c) => c.cp_id === cp.cp_id && c.status === 'AVAILABLE'),
      }))
      .find((x) => x.conns.length);
    assert.ok(cpEntry, 'need a CP with an AVAILABLE connector');
    const { cp } = cpEntry;
    const connNo = cpEntry.conns[0].connector_no;
    const identity = cp.ocpp_identity;
    const secret = cp.auth_secret || `dev-${identity}`;
    const basic = Buffer.from(`${identity}:${secret}`).toString('base64');
    const connect = () =>
      new Promise((res, rej) => {
        const ws = new WebSocket(`ws://localhost:4109/ocpp/${identity}`, {
          headers: { Authorization: `Basic ${basic}` },
        });
        ws.on('open', () => res(ws));
        ws.on('error', rej);
      });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Persistent watcher: records every CSMS CALL and auto-answers it. Must be
    // attached BEFORE the REST call that triggers the send — the WS frame can
    // beat the HTTP response back to the client.
    const watch = (ws) => {
      const calls = [];
      ws.on('message', (raw) => {
        try {
          const m = JSON.parse(String(raw));
          if (Array.isArray(m) && m[0] === 2) {
            calls.push(m);
            ws.send(JSON.stringify([3, m[1], { status: 'Accepted' }]));
          }
        } catch {}
      });
      return {
        calls,
        waitForCall: async (action, timeoutMs = 3000) => {
          const t0 = Date.now();
          for (;;) {
            const hit = calls.find((m) => m[2] === action);
            if (hit) return hit;
            if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${action}`);
            await sleep(50);
          }
        },
      };
    };
    // A driver for the session.
    const reg = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: `close${Date.now()}@example.in`, password: 'Driver@123', full_name: 'C Driver' }),
    });
    assert.equal(reg.status, 201);
    const H = { Authorization: `Bearer ${reg.j.accessToken}` };

    // --- t1: stale socket close must not deregister the live successor ---
    const ws1 = await connect(); // original connection
    await sleep(150); // fully wired
    const st = await api('/sessions/start', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ cpId: cp.cp_id, connectorNo: connNo }),
    });
    assert.equal(st.status, 201, `session start must be 201, got ${st.status}`);
    const sid = st.j.session.session_id;
    const ws2 = await connect(); // reconnecting successor -> server closes ws1 (stale)
    const w2 = watch(ws2); // attach BEFORE any remote command
    assert.strictEqual(cp.status, 'ONLINE');
    // Let the stale socket's close event fire on the server (it was closed by the gateway).
    await sleep(400);
    // The regression: ws1's close handler must not mark the live CP OFFLINE.
    assert.strictEqual(cp.status, 'ONLINE', 'stale close must not mark the live CP OFFLINE');
    // ...and the successor must still resolve remote commands (registry.get intact).
    const stop = await api(`/sessions/${sid}/remote-stop`, { method: 'POST', headers: H });
    assert.equal(
      stop.status,
      200,
      `remote-stop must be 200, got ${stop.status} (stale close deregistered the live socket?)`
    );
    const call = await w2.waitForCall('RemoteStopTransaction');
    assert.equal(call[3].transactionId, sid, 'successor socket must receive the remote command');
    console.log('  close 1 - stale close leaves successor registered + CP ONLINE (remote-stop round-trip OK)');
    ws1.close();
    await sleep(200);

    // --- t2: closing the *registered* socket (no successor) still cleans up ---
    ws2.close();
    await sleep(400);
    assert.strictEqual(cp.status, 'OFFLINE', 'final close must mark the CP OFFLINE');
    assert.strictEqual(registry.get(identity), undefined, 'final close must deregister the identity');
    console.log('  close 2 - registered socket close still deregisters + OFFLINE');
    console.log('\nOCPP gateway-close tests: 2 passed');
  } finally {
    server.close();
  }
  process.exit(0);
}
main().catch((e) => {
  console.error('GATEWAY-CLOSE FAIL', e);
  process.exit(1);
});
