// B3G-001: OCPP remote-command contract test (ADR-0007).
// Mounts the real gateway, connects a fake charge point over WS with Basic auth,
// drives POST /sessions/:id/remote-stop + POST /sessions/remote-start, and asserts
// the CP socket received [2, uid, RemoteStopTransaction/RemoteStartTransaction, {...}].
// Run: node apps/api/test/ocpp-remote.js (RATE_LIMIT_OFF=1).
'use strict';
process.env.RATE_LIMIT_OFF = '1';
const assert = require('assert');
const WebSocket = require('ws');

async function main() {
  process.env.PORT = '4108';
  const { server, store } = require('../src/server');
  await new Promise((r) => server.listen(4108, r));
  const B = 'http://localhost:4108/api/v1';
  const api = async (p, o = {}) => {
    const { headers, ...rest } = o;
    const r = await fetch(B + p, {
      ...rest,
      headers: { 'content-type': 'application/json', ...(headers || {}) },
    });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  try {
    const reg = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: `ocpp${Date.now()}@example.in`, password: 'Driver@123', full_name: 'Ocpp Driver' }),
    });
    assert.equal(reg.status, 201);
    const H = { Authorization: `Bearer ${reg.j.accessToken}` };
    const driverTag = `TAG-${reg.j.user.user_id}`;
    // Pick a CP with an AVAILABLE connector.
    const cpEntry = [...store.cps.values()]
      .map((cp) => ({
        cp,
        conns: [...store.connectors.values()].filter((c) => c.cp_id === cp.cp_id && c.status === 'AVAILABLE'),
      }))
      .find((x) => x.conns.length);
    assert.ok(cpEntry, 'need a CP with AVAILABLE connector');
    const { cp } = cpEntry;
    const connNo = cpEntry.conns[0].connector_no;
    const secret = cp.auth_secret || `dev-${cp.ocpp_identity}`;
    const ws = new WebSocket(`ws://localhost:4108/ocpp/${cp.ocpp_identity}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${cp.ocpp_identity}:${secret}`).toString('base64')}` },
    });
    await new Promise((res, rej) => {
      ws.on('open', res);
      ws.on('error', rej);
    });
    const seen = [];
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw));
        seen.push(m);
        // Answer CSMS CALLs so fire-and-forget send is a full round-trip.
        if (Array.isArray(m) && m[0] === 2) ws.send(JSON.stringify([3, m[1], { status: 'Accepted' }]));
      } catch {}
    });
    const waitFor = async (action, timeoutMs = 3000) => {
      const t0 = Date.now();
      for (;;) {
        const hit = seen.find((m) => Array.isArray(m) && m[0] === 2 && m[2] === action);
        if (hit) return hit;
        if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${action}; seen=${JSON.stringify(seen)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    // Create a live session on that connector, then remote-stop it.
    const st = await api('/sessions/start', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ cpId: cp.cp_id, connectorNo: connNo }),
    });
    assert.equal(st.status, 201, `session start must be 201, got ${st.status}`);
    const sid = st.j.session.session_id;
    const stop = await api(`/sessions/${sid}/remote-stop`, { method: 'POST', headers: H });
    assert.equal(stop.status, 200);
    const call = await waitFor('RemoteStopTransaction');
    assert.equal(call[3].transactionId, sid, 'RemoteStopTransaction must carry the session id');
    console.log(`  ocpp 1 - RemoteStopTransaction received for tx=${sid}`);
    // Operator RemoteStart on the same CP.
    const opLogin = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'arjun@volthub.in', password: 'Operator@123' }),
    });
    assert.ok(opLogin.j.accessToken, 'seeded operator must login');
    const OH = { Authorization: `Bearer ${opLogin.j.accessToken}` };
    const start = await api('/sessions/remote-start', {
      method: 'POST',
      headers: OH,
      body: JSON.stringify({ cpId: cp.cp_id, connectorNo: connNo, idTag: driverTag }),
    });
    assert.equal(start.status, 202, `remote-start must be 202, got ${start.status}`);
    const call2 = await waitFor('RemoteStartTransaction');
    assert.equal(call2[3].connectorId, connNo);
    console.log('  ocpp 2 - RemoteStartTransaction received');
    ws.close();
    console.log('\nOCPP remote tests: 2 passed');
  } finally {
    server.close();
  }
  process.exit(0);
}
main().catch((e) => {
  console.error('OCPP-REMOTE FAIL', e);
  process.exit(1);
});
