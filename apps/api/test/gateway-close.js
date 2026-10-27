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
  // Watchdog: this suite holds live WS sockets, so one failed assertion can leave a
  // client open and server.close() waiting forever — which would hang the whole
  // 16-suite chain with zero output. Fail loudly instead.
  const watchdog = setTimeout(() => {
    console.error('GATEWAY-CLOSE TIMEOUT: suite did not finish in 120s (a socket or await is stuck)');
    process.exit(2);
  }, 120000);
  process.env.PORT = '4109';
  const { server, store } = require('../src/server');
  await new Promise((r) => server.listen(4109, r));
  const B = 'http://localhost:4109/api/v1';
  const ORIGIN = new URL(B).origin;
  const api = async (p, o = {}) => {
    const { headers, ...rest } = o;
    // CodeQL js/request-forgery: request paths interpolate ids received from simulated
    // chargers (tainted by construction). The base is a FIXED localhost test origin —
    // normalize the path against it and refuse anything that would leave that origin
    // before the request is made (the documented allowlist mitigation).
    const u = new URL(`${B.replace(/\/$/, '')}${p.startsWith('/') ? '' : '/'}${p}`);
    if (u.origin !== ORIGIN) throw new Error(`refusing non-test origin: ${u.origin}`);
    const r = await fetch(u, {
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

    // --- t4 (HARD-001): oversized frames must be rejected at the socket, not parsed ---
    // ws's default maxPayload is 100 MiB; the OCPP rate limit is 10 msg/s, so a malicious
    // CP could otherwise push ~1 GB/s of parse load per connection. OCPP 1.6 messages are
    // tiny (<64 KB) — the gateway now caps frames at 256 KB and terminates on violation.
    const wsBig = await connect();
    wsBig.on('error', () => {}); // abnormal termination (1009) surfaces as a client 'error' first
    const bigClosed = new Promise((res) => wsBig.on('close', (code) => res(code)));
    await sleep(150);
    wsBig.send(JSON.stringify([2, 'big-1', 'Heartbeat', { pad: 'x'.repeat(300 * 1024) }]));
    const closeCode = await Promise.race([bigClosed, sleep(2500).then(() => null)]);
    assert.strictEqual(closeCode, 1009, `oversized frame must close 1009, got ${closeCode}`);
    await sleep(300); // server-side error→close→cleanup settles after the client sees 1009
    assert.strictEqual(registry.get(identity), undefined, 'oversized-frame socket must be deregistered');
    assert.strictEqual(cp.status, 'OFFLINE', 'oversized-frame close must mark the CP OFFLINE');
    console.log('  close 4 - oversized frame (>256KB) terminates the socket with 1009');

    // --- t5 (PROTO-002): the 11 msg/s violation answers with the OFFENDING message's uid ---
    const ws5 = await connect();
    await sleep(150);
    const replies = [];
    ws5.on('message', (raw) => {
      try {
        replies.push(JSON.parse(String(raw)));
      } catch {}
    });
    const uids = Array.from({ length: 12 }, (_, i) => `rl-${i}`);
    for (const uid of uids) ws5.send(JSON.stringify([2, uid, 'Heartbeat', {}]));
    await sleep(600);
    const violation = replies.find((m) => Array.isArray(m) && m[0] === 4);
    assert.ok(violation, 'the >10 msg/s call must get a CALLERROR');
    assert.strictEqual(violation[2], 'FormationViolation');
    assert.ok(
      uids.includes(violation[1]),
      `CALLERROR must carry the offending uid (got '${violation[1]}') — '0' is not a valid answer to a parsed CALL`
    );
    console.log('  close 5 - rate-limit CALLERROR carries the offending message uid');
    ws5.close();
    await sleep(300);

    // --- t6 (PROTO-003): StopTransaction on a never-charged (PREPARING) session is graceful ---
    // A CP that plugs in and stops without a single MeterValues previously drove the gateway
    // into ILLEGAL_TRANSITION → CALLERROR InternalError. The spec-shaped answer is a normal
    // CALLRESULT and the session ends CANCELLED.
    const ws6 = await connect();
    await sleep(1100); // the t5 heartbeat burst must age out of the 10 msg/s window first
    // t3 left sid3 open (connector OCCUPIED) — close it so the OCPP start below is bookable.
    const t3stop = await api(`/sessions/${sid3}/remote-stop`, { method: 'POST', headers: H });
    assert.equal(t3stop.status, 200, 't3 session remote-stop must be 200');
    await sleep(200);
    const stopReplies = [];
    ws6.on('message', (raw) => {
      try {
        stopReplies.push(JSON.parse(String(raw)));
      } catch {}
    });
    ws6.send(
      JSON.stringify([
        2,
        'st-1',
        'StartTransaction',
        { connectorId: connNo, idTag: `TAG-${reg.j.user.user_id}`, meterStart: 0, timestamp: new Date().toISOString() },
      ])
    );
    await sleep(200);
    const stReply = stopReplies.find((m) => Array.isArray(m) && m[0] === 3 && m[1] === 'st-1');
    assert.ok(stReply, 'StartTransaction must get a CALLRESULT');
    assert.strictEqual(stReply[2].idTagInfo.status, 'Accepted', 'known tag must be Accepted');
    const newSid = stReply[2].transactionId;
    assert.strictEqual(store.sessions.get(newSid).state, 'PREPARING');
    ws6.send(
      JSON.stringify([
        2,
        'stop-1',
        'StopTransaction',
        { transactionId: newSid, meterStop: 0, timestamp: new Date().toISOString() },
      ])
    );
    await sleep(200);
    const stopReply = stopReplies.find((m) => Array.isArray(m) && m[0] === 3 && m[1] === 'stop-1');
    assert.ok(stopReply, 'StopTransaction must get a CALLRESULT (was: InternalError ILLEGAL_TRANSITION)');
    assert.strictEqual(store.sessions.get(newSid).state, 'CANCELLED', 'never-charged session must end CANCELLED');
    console.log('  close 6 - StopTransaction on PREPARING ends CANCELLED with a normal CALLRESULT');

    // --- t7 (invariant): a stale "Available" must not erase CSMS-owned state ---
    // If a CP could flip an in-session connector back to AVAILABLE, a second driver
    // could start on the same connector; if it could flip a RESERVED connector, a
    // walk-up could take someone else's booking. Both are CSMS authority, not CP.
    const st7 = await api('/sessions/start', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ cpId: cp.cp_id, connectorNo: connNo }),
    });
    assert.equal(st7.status, 201, `t7 session start must be 201, got ${st7.status}`);
    const sid7 = st7.j.session.session_id;
    ws6.send(
      JSON.stringify([
        2,
        'st-avail',
        'StatusNotification',
        { connectorId: connNo, status: 'Available', errorCode: 'NoError' },
      ])
    );
    await sleep(200);
    assert.strictEqual(
      store.connectors.get(`${cp.cp_id}:${connNo}`).status,
      'OCCUPIED',
      'an active session must keep the connector OCCUPIED despite a CP Available report'
    );
    await assert.rejects(
      () =>
        store.startSession({
          uid: reg.j.user.user_id,
          vehicleId: null,
          cpId: cp.cp_id,
          connNo,
          planId: 2,
          reservationId: null,
          idTag: `TAG-${reg.j.user.user_id}`,
        }),
      (e) => e.code === 'NOT_BOOKABLE',
      'double-booking through a stale StatusNotification must be rejected'
    );
    await api(`/sessions/${sid7}/remote-stop`, { method: 'POST', headers: H });
    await sleep(250);
    // ...and a live booking survives the same stale report.
    const rsv = await api('/reservations', {
      method: 'POST',
      headers: { ...H, 'Idempotency-Key': `close-rsv-${Date.now()}` },
      body: JSON.stringify({
        cpId: cp.cp_id,
        connectorNo: connNo,
        startAt: new Date(Date.now() + 20 * 60000).toISOString(),
        endAt: new Date(Date.now() + 60 * 60000).toISOString(),
      }),
    });
    assert.equal(rsv.status, 201, `reservation must be 201, got ${rsv.status}`);
    ws6.send(
      JSON.stringify([
        2,
        'st-avail-2',
        'StatusNotification',
        { connectorId: connNo, status: 'Available', errorCode: 'NoError' },
      ])
    );
    await sleep(200);
    assert.strictEqual(
      store.connectors.get(`${cp.cp_id}:${connNo}`).status,
      'RESERVED',
      'a BOOKED reservation must survive a CP Available report'
    );
    await api(`/reservations/${rsv.j.reservation.reservation_id}/cancel`, { method: 'POST', headers: H });
    console.log('  close 7 - stale Available cannot unlock an active session or a live reservation');

    // --- t8 (ownership): a CP cannot meter or stop another CP's transaction ---
    const st8 = await api('/sessions/start', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ cpId: cp.cp_id, connectorNo: connNo }),
    });
    assert.equal(st8.status, 201, `t8 session start must be 201, got ${st8.status}`);
    const sid8 = st8.j.session.session_id;
    const other = [...store.cps.values()].find((o) => o.cp_id !== cp.cp_id);
    assert.ok(other, 'need a second CP for the ownership probe');
    const otherSecret = other.auth_secret || `dev-${other.ocpp_identity}`;
    const otherBasic = Buffer.from(`${other.ocpp_identity}:${otherSecret}`).toString('base64');
    const wsOther = await new Promise((res, rej) => {
      const w = new WebSocket(`ws://localhost:4109/ocpp/${other.ocpp_identity}`, {
        headers: { Authorization: `Basic ${otherBasic}` },
      });
      w.on('open', () => res(w));
      w.on('error', rej);
    });
    const foreignReplies = [];
    wsOther.on('message', (raw) => {
      try {
        foreignReplies.push(JSON.parse(String(raw)));
      } catch {}
    });
    await sleep(150);
    wsOther.send(
      JSON.stringify([
        2,
        'foreign-mv',
        'MeterValues',
        {
          transactionId: sid8,
          meterValue: [
            {
              timestamp: new Date().toISOString(),
              sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: '9999' }],
            },
          ],
        },
      ])
    );
    await sleep(250);
    const mvErr = foreignReplies.find((m) => Array.isArray(m) && m[0] === 4 && m[1] === 'foreign-mv');
    assert.ok(mvErr, 'foreign MeterValues must get a CALLERROR');
    assert.strictEqual(mvErr[2], 'SecurityError', `expected SecurityError, got ${mvErr[2]}`);
    assert.strictEqual(
      store.readings.filter((r) => r.session_id === sid8).length,
      0,
      'foreign meter data must not be recorded'
    );
    wsOther.send(JSON.stringify([2, 'foreign-stop', 'StopTransaction', { transactionId: sid8, meterStop: 0 }]));
    await sleep(250);
    const stopErr = foreignReplies.find((m) => Array.isArray(m) && m[0] === 4 && m[1] === 'foreign-stop');
    assert.ok(stopErr, 'foreign StopTransaction must get a CALLERROR');
    assert.strictEqual(stopErr[2], 'SecurityError', `expected SecurityError, got ${stopErr[2]}`);
    assert.notStrictEqual(store.sessions.get(sid8).state, 'COMPLETED', 'foreign CP must not stop the session');
    wsOther.close();
    await api(`/sessions/${sid8}/remote-stop`, { method: 'POST', headers: H });
    await sleep(200);
    console.log("  close 8 - a CP cannot meter or stop another CP's transaction (SecurityError)");

    // --- t9: SEC-041 — a charge point with NO stored secret must be refused ---
    // Pre-fix: checkBasic returned true for a secretless CP in per-cp mode, so an open
    // registration row meant an open gateway — anyone could connect as any CP with no
    // credentials at all and fabricate sessions + meter input.
    // Contract note: the WS upgrade completes, THEN the gateway closes with 4401 before
    // any frame is processed (same shape as the wrong-password path). So the assertions
    // are: a 4401 close arrives, and nothing sent on that socket is ever answered.
    const stashed = cp.auth_secret;
    cp.auth_secret = null;
    const refused = await new Promise((resolve) => {
      const w = new WebSocket(`ws://localhost:4109/ocpp/${identity}`); // NO auth header
      let answered = false;
      w.on('open', () => w.send(JSON.stringify([2, 'noauth-boot', 'BootNotification', {}])));
      w.on('message', () => {
        answered = true;
      });
      w.on('close', (code) => resolve({ code, answered }));
      w.on('error', () => {});
      setTimeout(() => resolve({ code: -1, answered }), 3000);
    });
    cp.auth_secret = stashed;
    assert.strictEqual(refused.code, 4401, `secretless CP must be closed with 4401, got ${JSON.stringify(refused)}`);
    assert.strictEqual(refused.answered, false, 'a refused socket must not receive any OCPP answer');
    console.log('  close 9 - a CP without a stored secret is refused (4401), zero frames answered');

    // --- t10: BUG-054 — StartTransaction.meterStart is billed as the register base ---
    // Pre-fix: start_meter_kwh was hardcoded 0 while meterStop is an absolute register,
    // so every charger whose meter did not start at zero was overbilled by the offset.
    const drvUid = reg.j.user.user_id;
    const free = [...store.connectors.values()].find((c) => c.status === 'AVAILABLE');
    assert.ok(free, 'need an AVAILABLE connector for the meterStart probe');
    const fcp = store.cps.get(free.cp_id);
    const fSecret = fcp.auth_secret || `dev-${fcp.ocpp_identity}`;
    const fBasic = Buffer.from(`${fcp.ocpp_identity}:${fSecret}`).toString('base64');
    const wsMs = await new Promise((res, rej) => {
      const w = new WebSocket(`ws://localhost:4109/ocpp/${fcp.ocpp_identity}`, {
        headers: { Authorization: `Basic ${fBasic}` },
      });
      w.on('open', () => res(w));
      w.on('error', rej);
      setTimeout(() => rej(new Error('meterStart probe: connect timeout')), 3000);
    });
    const msReplies = [];
    wsMs.on('message', (raw) => {
      try {
        msReplies.push(JSON.parse(String(raw)));
      } catch {}
    });
    // A CALL is answered by CALLRESULT (3) or CALLERROR (4). Matching only the first
    // shape turned any legitimate rejection into a 3s "timeout" with no evidence, so
    // the failure message now quotes every answer that actually came back for the uid.
    const answersFor = (uid) => msReplies.filter((m) => Array.isArray(m) && (m[0] === 3 || m[0] === 4) && m[1] === uid);
    // The gateway rate-limits each identity to 10 CALL/s (SEC-042) and answers the
    // overflow with FormationViolation. This suite drives a whole session's frames in a
    // few milliseconds, so the helper paces itself rather than tripping the limiter and
    // failing an unrelated assertion.
    const sentAt = [];
    const pace = async () => {
      for (;;) {
        const now = Date.now();
        if (sentAt.filter((t) => now - t < 1000).length < 9) break;
        await sleep(100);
      }
      sentAt.push(Date.now());
    };
    const msCall = async (uid, action, payload) => {
      await pace();
      return new Promise((resolve, reject) => {
        wsMs.send(JSON.stringify([2, uid, action, payload]));
        const t0 = Date.now();
        const iv = setInterval(() => {
          const hit = msReplies.find((m) => Array.isArray(m) && m[0] === 3 && m[1] === uid);
          if (hit) {
            clearInterval(iv);
            resolve(hit[2]);
          } else if (Date.now() - t0 > 3000) {
            clearInterval(iv);
            reject(new Error(`timeout waiting for ${action}: ${JSON.stringify(answersFor(uid))}`));
          }
        }, 50);
      });
    };
    const startAck = await msCall('ms-start', 'StartTransaction', {
      connectorId: free.connector_no,
      idTag: `TAG-${drvUid}`,
      meterStart: 500000, // Wh — the charger's register did NOT start at zero
      timestamp: new Date().toISOString(),
    });
    assert.ok(startAck.transactionId > 0, `StartTransaction must be Accepted, got ${JSON.stringify(startAck)}`);
    const msSid = startAck.transactionId;
    assert.equal(store.sessions.get(msSid).start_meter_kwh, 500, 'meterStart must persist as the register base (kWh)');
    await msCall('ms-tick', 'MeterValues', {
      transactionId: msSid,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: '502000' }],
        },
      ],
    });
    await msCall('ms-stop', 'StopTransaction', {
      transactionId: msSid,
      meterStop: 502500, // Wh absolute
      timestamp: new Date().toISOString(),
      reason: 'Local',
    });
    await sleep(150);
    assert.equal(store.sessions.get(msSid).state, 'COMPLETED');
    const bill = await api(`/sessions/${msSid}/bill`, {
      method: 'POST',
      headers: H,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(bill.status, 201, `bill must be 201, got ${bill.status} ${JSON.stringify(bill.j)}`);
    const energyLine = store.lines.find((l) => l.invoice_id === bill.j.invoice.invoice_id && l.kind === 'ENERGY');
    assert.ok(energyLine, 'invoice must carry an ENERGY line');
    assert.ok(
      Math.abs(energyLine.quantity - 2.5) < 0.001,
      `delivered energy is 2.5 kWh (502.5 - 500), billed ${energyLine.quantity}`
    );
    console.log('  close 10 - meterStart is captured: a 500 kWh register base is not billed (2.5 kWh delivered)');

    // --- t11: BUG-061 + BUG-062 — power-only frames persist; NoError clears faults ---
    const ms2 = await msCall('ms2-start', 'StartTransaction', {
      connectorId: free.connector_no,
      idTag: `TAG-${drvUid}`,
      meterStart: 700000, // register base 700 kWh
      timestamp: new Date().toISOString(),
    });
    const ms2Sid = ms2.transactionId;
    assert.ok(ms2Sid > 0, `second StartTransaction must be Accepted, got ${JSON.stringify(ms2)}`);
    await msCall('ms2-mv', 'MeterValues', {
      transactionId: ms2Sid,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{ measurand: 'Power.Active.Import', value: '11000' }], // NO energy measurand
        },
      ],
    });
    const powRows = store.readings.filter((r) => r.session_id === ms2Sid);
    assert.equal(powRows.length, 1, 'a power-only MeterValues frame must be recorded, not ACKed-and-dropped');
    assert.ok(Math.abs(powRows[0].meter_kwh - 700) < 0.001, 'energy register carries forward from the start register');
    assert.ok(Math.abs(powRows[0].power_kw - 11) < 0.001, 'the power sample itself must survive');
    await msCall('ms2-fault', 'StatusNotification', {
      connectorId: free.connector_no,
      errorCode: 'GroundFailure',
      status: 'Faulted',
      timestamp: new Date().toISOString(),
    });
    const openFault = [...store.faults.values()].find(
      (f) => f.connector_ref === `${fcp.cp_id}:${free.connector_no}` && !f.cleared_at
    );
    assert.ok(openFault, 'the GroundFailure must create an open fault row');
    await msCall('ms2-clear', 'StatusNotification', {
      connectorId: free.connector_no,
      errorCode: 'NoError',
      status: 'Available',
      timestamp: new Date().toISOString(),
    });
    assert.ok(openFault.cleared_at, 'a NoError report must clear the open OCPP fault (BUG-062)');
    await msCall('ms2-stop', 'StopTransaction', {
      transactionId: ms2Sid,
      meterStop: 700500,
      timestamp: new Date().toISOString(),
      reason: 'Local',
    });
    await sleep(150);
    console.log('  close 11 - power-only frames recorded (register carry-forward); NoError clears open faults');

    // --- t12 (TELEM-02): an unparsable energy register is a malformed frame, not a tick ---
    // SampledValue.value is a string, so Number('n/a') is NaN. Before the boundary guard
    // that NaN travelled readings → outbox → Timescale, where float8 stores it as an
    // ordinary-looking row and NaN = NaN is TRUE, so nothing downstream detects it while
    // every SUM above it becomes NaN. Oracle rejects the same bind outright — one frame
    // must not get two answers from two engines. The CP now gets TypeMismatch and the
    // sequence cursor is NOT advanced, so the next honest sample still lands at seq 1.
    const msAny = async (uid, action, payload) => {
      await pace();
      return new Promise((resolve, reject) => {
        wsMs.send(JSON.stringify([2, uid, action, payload]));
        const t0 = Date.now();
        const iv = setInterval(() => {
          const hit = msReplies.find((m) => Array.isArray(m) && (m[0] === 3 || m[0] === 4) && m[1] === uid);
          if (hit) {
            clearInterval(iv);
            resolve(hit);
          } else if (Date.now() - t0 > 3000) {
            clearInterval(iv);
            reject(new Error(`timeout waiting for ${action}: ${JSON.stringify(answersFor(uid))}`));
          }
        }, 50);
      });
    };
    const t12Sid = (
      await msCall('t12-start', 'StartTransaction', {
        connectorId: free.connector_no,
        idTag: `TAG-${drvUid}`,
        meterStart: 800000,
        timestamp: new Date().toISOString(),
      })
    ).transactionId;
    const t12Rows = () => store.readings.filter((r) => r.session_id === t12Sid);
    const refuse = await msAny('t12-bad', 'MeterValues', {
      transactionId: t12Sid,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: 'n/a' }],
        },
      ],
    });
    assert.strictEqual(
      refuse[0],
      4,
      `a refused frame must answer CALLERROR, not a silent CALLRESULT — got ${JSON.stringify(refuse)}`
    );
    assert.strictEqual(refuse[2], 'TypeMismatch', `expected TypeMismatch, got ${JSON.stringify(refuse)}`);
    assert.strictEqual(t12Rows().length, 0, 'nothing may be stored for a refused frame');
    await msCall('t12-good', 'MeterValues', {
      transactionId: t12Sid,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: '800250' }],
        },
      ],
    });
    assert.deepEqual(
      t12Rows().map((r) => [r.seq_no, r.meter_kwh]),
      [[1, 800.25]],
      'the refused frame must not spend a sequence number — the honest sample is still seq 1'
    );
    // A NaN auxiliary channel must not cost the session its register: it lands as NULL.
    await msCall('t12-pow', 'MeterValues', {
      transactionId: t12Sid,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            { measurand: 'Energy.Active.Import.Register', value: '800300' },
            { measurand: 'Power.Active.Import', value: '???' },
          ],
        },
      ],
    });
    assert.strictEqual(t12Rows().length, 2, 'a broken power field must not reject the whole frame');
    assert.strictEqual(t12Rows()[1].power_kw, null, 'a NaN power sample is stored as NULL, never NaN');
    const t12Queued = store.outbox.filter((e) => e.kind === 'METER_TICK' && e.payload.session_id === t12Sid);
    assert.equal(t12Queued.length, 2, 'only the two accepted ticks are queued for the sink');
    assert.ok(
      t12Queued.every(
        (e) =>
          Number.isFinite(e.payload.meter_kwh) && (e.payload.power_kw === null || Number.isFinite(e.payload.power_kw))
      ),
      'the outbox cannot carry a non-finite value to the sink'
    );
    await msCall('t12-stop', 'StopTransaction', {
      transactionId: t12Sid,
      meterStop: 800500,
      timestamp: new Date().toISOString(),
      reason: 'Local',
    });
    await sleep(150);
    console.log('  close 12 - unparsable register → TypeMismatch, no row, no sequence number spent');
    wsMs.close();

    ws6.close();
    await sleep(250);
    console.log('\nOCPP gateway-close tests: 12 passed');
  } finally {
    // The watchdog stays armed until the very end: a failed assertion leaves its WS
    // client open, and server.close() then waits forever for that socket — the exact
    // silent hang the header comment warns about. Forcing the connections closed lets
    // the rejection reach main().catch, so the failure is printed instead of parked.
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
    clearTimeout(watchdog);
  }
  process.exitCode = 0;
}
main().catch((e) => {
  console.error('GATEWAY-CLOSE FAIL', e);
  process.exitCode = 1;
});
