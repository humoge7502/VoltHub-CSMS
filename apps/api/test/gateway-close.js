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
// Test 3 is the BUG-024 regression: a CSMS restart must not swallow in-flight
// sessions' meter data (the per-session tick cursor is recovered from the store).
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

    // --- t3 (BUG-024): a CSMS restart must not swallow in-flight sessions' meter data ---
    // Sessions are durable (Oracle + hydrate) but the gateway's per-session tick cursor
    // was memory-only. After a restart the cursor restarted at 1 and every replayed
    // seq_no was silently deduped ({deduped:true}) — meter updates dropped until the
    // counter caught up with the pre-restart max. The gateway now recovers the cursor
    // from the persisted readings; this test proves ticks keep advancing past the old max.
    const cursor = global.__ocppTickCursor;
    assert.ok(cursor, 'gateway must expose the tick cursor (test seam)');
    cursor.clear(); // simulate: CSMS process restarted, per-session counters lost
    const ws3 = await connect();
    await sleep(150);
    // The session above is COMPLETED — start a fresh one on the same connector.
    const st3 = await api('/sessions/start', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ cpId: cp.cp_id, connectorNo: connNo }),
    });
    assert.equal(st3.status, 201, `session restart start must be 201, got ${st3.status}`);
    const sid3 = st3.j.session.session_id;
    // Pre-charge the cursor the old-fashioned way: two OCPP ticks (seq 1 and 2).
    ws3.send(
      JSON.stringify([
        2,
        'mv-1',
        'MeterValues',
        {
          transactionId: sid3,
          meterValue: [
            {
              timestamp: new Date().toISOString(),
              sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: '1000' }],
            },
          ],
        },
      ])
    );
    await sleep(120);
    ws3.send(
      JSON.stringify([
        2,
        'mv-2',
        'MeterValues',
        {
          transactionId: sid3,
          meterValue: [
            {
              timestamp: new Date().toISOString(),
              sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: '2000' }],
            },
          ],
        },
      ])
    );
    await sleep(120);
    // Simulate the CSMS restart with the session still open (durable): cursor dropped.
    cursor.clear();
    // Reconnect (the restarted gateway has no sockets; also proves recovery needs no reconnect ordering).
    ws3.close();
    await sleep(200);
    const ws4 = await connect();
    await sleep(150);
    // Post-restart MeterValues: a gateway with the old bug would assign seq 1 again →
    // dedupe swallow. Fixed: cursor recovers from store.readings and writes seq 3.
    ws4.send(
      JSON.stringify([
        2,
        'mv-3',
        'MeterValues',
        {
          transactionId: sid3,
          meterValue: [
            {
              timestamp: new Date().toISOString(),
              sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: '3500' }],
            },
          ],
        },
      ])
    );
    await sleep(200);
    const post = store.readings.filter((r) => r.session_id === sid3);
    assert.strictEqual(post.length, 3, `all three ticks must persist, got ${post.length} (cursor recovery broken?)`);
    assert.strictEqual(post.find((r) => r.meter_kwh === 3.5).seq_no, 3, 'post-restart tick must land at seq 3');
    console.log('  close 3 - CSMS restart recovers the tick cursor; no meter data swallowed');
    ws4.close();

    console.log('\nOCPP gateway-close tests: 3 passed');
  } finally {
    server.close();
  }
  process.exit(0);
}
main().catch((e) => {
  console.error('GATEWAY-CLOSE FAIL', e);
  process.exit(1);
});
