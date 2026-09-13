// ADR-0010 closed-loop probe: connects a compliant CP to the live gateway, then an
// ENFORCED plan cycle (fired separately) must deliver its compiled profile over the
// wire. Proves gateway dispatch end-to-end beyond the fake-socket unit tests.
// Usage: node apps/simulator/src/profile-probe.js --api http://localhost:4600
'use strict';
const WebSocket = require('ws');
const { call } = require('@volthub/ocpp-messages');

const API = (process.argv[2] || process.env.API_BASE || 'http://localhost:4600').replace(/\/$/, '');
const WS = API.replace('http', 'ws').replace(/\/api\/v1$/, '');
const identity = process.env.PROBE_ID || 'VH-1-CP1';
const secret = process.env.PROBE_SECRET || `dev-${identity}`;

const ws = new WebSocket(`${WS}/ocpp/${identity}`, {
  headers: { Authorization: `Basic ${Buffer.from(`${identity}:${secret}`).toString('base64')}` },
});
ws.on('open', () => {
  console.log(`[probe] CP ${identity} connected`);
  ws.send(call('b1', 'BootNotification', { chargePointVendor: 'VoltHub', chargePointModel: 'VH-AC22' }));
});
ws.on('message', (raw) => {
  let m;
  try {
    m = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (m[0] !== 2) return;
  const [, uid, action, payload] = m;
  if (action === 'SetChargingProfile') {
    const p = payload.csChargingProfiles;
    const periods = p?.chargingSchedule?.chargingSchedulePeriods || [];
    console.log(
      `[probe] RECEIVED SetChargingProfile id=${p.chargingProfileId} periods=${periods.length} firstLimit=${periods[0]?.limit}W duration=${p.chargingSchedule.duration}s`
    );
    ws.send(JSON.stringify([3, uid, { status: 'Accepted' }]));
    setTimeout(() => {
      console.log('CLOSED-LOOP-OK');
      process.exit(0);
    }, 300);
  } else {
    ws.send(JSON.stringify([3, uid, { status: 'Accepted' }]));
  }
});
ws.on('error', (e) => {
  console.error('[probe] ws error', e.message);
  process.exit(1);
});
setTimeout(() => {
  console.log('[probe] TIMEOUT — no profile received (is control mode ENFORCED with an active session?)');
  process.exit(1);
}, 20000);
