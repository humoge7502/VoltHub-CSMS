// Charger fleet simulator: scripted OCPP 1.6J scenarios against the gateway.
// Scenarios: normal | race | fault-mid-session | no-show | burst
// Usage: node src/index.js --api http://localhost:4000 --scenario normal --chargers 2
'use strict';
const { call } = require('@volthub/ocpp-messages');
const WebSocket = require('ws');

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, arr) =>
      a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []
    )
    .filter(Boolean)
);
const API = (args.api || process.env.API_BASE || 'http://localhost:4000/api/v1').replace(/\/$/, '');
const WS = API.replace('http', 'ws').replace('/api/v1', '');
const SCENARIO = args.scenario || 'normal';
const N = Number(args.chargers || 2);

async function api(path, opts = {}) {
  const { headers, ...rest } = opts;
  const r = await fetch(`${API}${path}`, {
    ...rest,
    headers: { 'content-type': 'application/json', ...(headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error?.message || r.status);
    e.body = j;
    e.status = r.status;
    throw e;
  }
  return j;
}
let uid = 0;
function ocppCall(ws, action, payload) {
  return new Promise((resolve, reject) => {
    const id = String(++uid);
    ws.send(call(id, action, payload));
    const t = setTimeout(() => reject(new Error('ocpp timeout ' + action)), 8000);
    const h = (raw) => {
      try {
        const m = JSON.parse(String(raw));
        if (m[1] === id) {
          clearTimeout(t);
          ws.off('message', h);
          m[0] === 4 ? reject(new Error('CALLERROR ' + m[2])) : resolve(m[2]);
        }
      } catch {}
    };
    ws.on('message', h);
  });
}

async function loginDriver() {
  // seed drivers use Driver@123; pick first driver via register (idempotent-ish)
  const email = `sim.${Date.now()}@example.in`;
  const { accessToken } = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'Driver@123', full_name: 'Sim Driver' }),
  });
  return accessToken;
}

async function normalFlow(identity, cpId, connNo, token, faultMid = false) {
  // SEC-003: Security Profile 1 — Basic(identity:secret) on the WS upgrade.
  // Demo seeds use deterministic `dev-<identity>`; provisioned CPs use the secret
  // returned once by POST /admin/stations|charge-points (env OCPP_SECRET_<n> override for fleets).
  const secret = process.env[`OCPP_SECRET_${identity}`] || process.env.OCPP_SECRET || `dev-${identity}`;
  const ws = new WebSocket(`${WS}/ocpp/${identity}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${identity}:${secret}`).toString('base64')}` },
  });
  await new Promise((r, j) => {
    ws.on('open', r);
    ws.on('error', j);
  });
  // B2G-009: honor inbound CSMS→CP CALLs (RemoteStop/Start). Answers CALLRESULT so the
  // gateway's fire-and-forget send is observable in tests; RemoteStop ends metering early.
  let remoteStopTx = null;
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(String(raw));
      if (!Array.isArray(m) || m[0] !== 2) return; // only CALLs
      const [, uid, action, payload] = m;
      if (action === 'RemoteStopTransaction') {
        remoteStopTx = Number(payload?.transactionId);
        ws.send(JSON.stringify([3, uid, { status: 'Accepted' }]));
        console.log(`[sim:${identity}] RemoteStopTransaction tx=${remoteStopTx} — stopping`);
      } else if (action === 'RemoteStartTransaction') {
        ws.send(JSON.stringify([3, uid, { status: 'Accepted' }]));
        console.log(`[sim:${identity}] RemoteStartTransaction accepted`);
      } else {
        ws.send(JSON.stringify([4, uid, 'NotSupported', action, {}]));
      }
    } catch {}
  });
  await ocppCall(ws, 'BootNotification', { chargePointVendor: 'VoltHub', chargePointModel: 'VH-DC60' });
  await ocppCall(ws, 'StatusNotification', { connectorId: connNo, status: 'Available', errorCode: 'NoError' });
  const start = new Date(Date.now() + 20 * 60000),
    end = new Date(Date.now() + 60 * 60000);
  let reservation = null;
  try {
    ({ reservation } = await api('/reservations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ cpId, connectorNo: connNo, startAt: start.toISOString(), endAt: end.toISOString() }),
    }));
  } catch (e) {
    console.log(`[sim:${identity}] reserve skipped: ${e.message}`);
  }
  await ocppCall(ws, 'Authorize', { idTag: 'TAG-1' });
  const { transactionId } = await ocppCall(ws, 'StartTransaction', {
    connectorId: connNo,
    idTag: 'TAG-1',
    meterStart: 0,
    timestamp: new Date().toISOString(),
  });
  console.log(`[sim:${identity}] charging tx=${transactionId} res=${reservation?.reservation_id ?? '-'}`);
  const ticks = faultMid ? 6 : 12;
  for (let i = 1; i <= ticks; i++) {
    if (remoteStopTx) {
      console.log(`[sim:${identity}] stopped by CSMS at tick ${i}`);
      break;
    }
    if (faultMid && i === 5) {
      await ocppCall(ws, 'StatusNotification', {
        connectorId: connNo,
        status: 'Faulted',
        errorCode: 'GroundFailure',
        info: 'simulated ground fault',
      });
      console.log(`[sim:${identity}] FAULT injected mid-session`);
      break;
    }
    await ocppCall(ws, 'MeterValues', {
      connectorId: connNo,
      transactionId,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            { value: String(i * 2500), measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
            { value: String(30000 + i * 500), measurand: 'Power.Active.Import', unit: 'W' },
          ],
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 700));
  }
  if (!faultMid)
    await ocppCall(ws, 'StopTransaction', {
      transactionId,
      meterStop: ticks * 2500,
      timestamp: new Date().toISOString(),
    });
  ws.close();
  return transactionId;
}

async function main() {
  const token = await loginDriver();
  const { stations } = await api('/stations');
  // resolve per-connector OCPP identities via live feed (identity lives on charge point)
  const cps = [];
  for (const s of stations) {
    try {
      const { connectors } = await api(`/stations/${s.station_id}/connectors/live`);
      connectors.forEach((c) => cps.push({ ...c, station_id: s.station_id }));
    } catch {}
  }
  if (SCENARIO === 'race') {
    // R1: two parallel reserves, same connector+window -> exactly 1x201 + 1x409
    const c = cps[0];
    const [cp, no] = c.connector_ref.split(':').map(Number);
    const s = new Date(Date.now() + 20 * 60000).toISOString(),
      e = new Date(Date.now() + 60 * 60000).toISOString();
    const mk = () =>
      api('/reservations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `race-${Math.random()}` },
        body: JSON.stringify({ cpId: cp, connectorNo: no, startAt: s, endAt: e }),
      });
    const out = await Promise.allSettled([mk(), mk()]);
    console.log(
      out
        .map((x) => (x.status === 'fulfilled' ? '201 BOOKED' : `${x.reason.status || '?'} ${x.reason.message}`))
        .join(' | ')
    );
    const ok = out.filter((x) => x.status === 'fulfilled').length;
    console.log(ok === 1 ? 'RACE-OK: exactly one winner (no double-book)' : `RACE-FAIL: ${ok} winners`);
    process.exit(ok === 1 ? 0 : 1);
  }
  if (SCENARIO === 'no-show') {
    const c = cps[0];
    const [cp, no] = c.connector_ref.split(':').map(Number);
    const { reservation } = await api('/reservations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        cpId: cp,
        connectorNo: no,
        startAt: new Date(Date.now() + 20 * 60000).toISOString(),
        endAt: new Date(Date.now() + 50 * 60000).toISOString(),
      }),
    });
    console.log('booked (will expire, no plug-in):', reservation.reservation_id);
    return;
  }
  if (SCENARIO === 'burst') {
    // DA3 burst: N chargers x fast ticks to show relay lag <30s
    const jobs = cps.slice(0, N).map((c) => {
      const [cp, no] = c.connector_ref.split(':').map(Number);
      return normalFlow(c.ocpp_identity, cp, no, token).catch((e) => console.log('burst charger err', e.message));
    });
    await Promise.all(jobs);
    console.log('burst done');
    return;
  }
  if (SCENARIO === 'fault-mid-session') {
    const c = cps[0];
    const [cp, no] = c.connector_ref.split(':').map(Number);
    await normalFlow(c.ocpp_identity, cp, no, token, true);
    return;
  }
  for (let i = 0; i < N; i++) {
    const c = cps[i % cps.length];
    const [cp, no] = c.connector_ref.split(':').map(Number);
    await normalFlow(c.ocpp_identity, cp, no, token);
  }
}
main().catch((e) => {
  console.error('[sim] fatal', e.message, e.body || '');
  process.exit(1);
});
