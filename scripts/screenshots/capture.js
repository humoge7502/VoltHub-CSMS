// Round-3 evidence capture: real UI screenshots @2x + live OCPP-driven GIF frames.
// Every pixel comes from the running stack (API :4000, web :3120, demo seed).
// Ticks travel the genuine path: WS OCPP MeterValues -> gateway -> store -> UI poll.
// Run: node capture.js
'use strict';
const fs = require('fs');
const WebSocket = require('ws');
const { chromium } = require('playwright');

const API = 'http://localhost:4000/api/v1';
const WS = 'ws://localhost:4000';
const WEB = 'http://localhost:3120';
const path = require('path');
const OUT = path.join(__dirname, '..', '..', 'docs', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

async function api(path, opts = {}) {
  const { headers, ...rest } = opts;
  const r = await fetch(API + path, {
    ...rest,
    headers: { 'content-type': 'application/json', ...(headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

let uid = 0;
function ocppCall(ws, action, payload) {
  return new Promise((resolve, reject) => {
    const id = String(++uid);
    ws.send(JSON.stringify([2, id, action, payload]));
    const t = setTimeout(() => reject(new Error('ocpp timeout ' + action)), 15000);
    const h = (raw) => {
      try {
        const m = JSON.parse(String(raw));
        if (m[1] === id) {
          clearTimeout(t);
          ws.off('message', h);
          if (m[0] === 4) reject(new Error('CALLERROR ' + m[2]));
          else resolve(m[2]);
        }
      } catch {}
    };
    ws.on('message', h);
  });
}

// Try to boot one candidate charge point with the demo dev secret. The live feed
// also lists stations provisioned via the admin surface, whose secrets are
// generated (not dev-<identity>) — those get skipped here instead of failing the
// whole capture. Resolves the open socket (with keep-alive attached) or null.
function tryBoot(candidate) {
  return new Promise((resolve) => {
    const identity = candidate.ocpp_identity;
    const ws = new WebSocket(`${WS}/ocpp/${identity}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${identity}:dev-${identity}`).toString('base64')}` },
    });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (ok) resolve(ws);
      else {
        try {
          ws.terminate();
        } catch {}
        resolve(null);
      }
    };
    const t = setTimeout(() => finish(false), 8000);
    ws.on('open', () => {
      ws.send(
        JSON.stringify([2, 'b1', 'BootNotification', { chargePointVendor: 'VoltHub', chargePointModel: 'VH-DC60' }])
      );
    });
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw));
        if (!Array.isArray(m)) return;
        if (m[0] === 3 && m[1] === 'b1' && m[2]?.status === 'Accepted') {
          clearTimeout(t);
          finish(true);
        }
        if (m[0] === 4) {
          clearTimeout(t);
          finish(false);
        }
        // Keep-alive: answer any inbound CSMS CALLs.
        if (m[0] === 2) ws.send(JSON.stringify([3, m[1], { status: 'Accepted' }]));
      } catch {}
    });
    ws.on('error', () => {
      clearTimeout(t);
      finish(false);
    });
    ws.on('close', () => {
      clearTimeout(t);
      finish(false);
    });
  });
}

async function main() {
  // Cleanup: stop leftover live sessions from prior partial runs (admin bypasses ownership).
  const adminLogin = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@volthub.in', password: 'Admin@123' }),
  });
  const AH = { Authorization: `Bearer ${adminLogin.accessToken}` };
  try {
    const { sessions } = await api('/sessions', { headers: AH });
    for (const s of sessions || []) {
      if (['PREPARING', 'CHARGING', 'SUSPENDED'].includes(s.state)) {
        await api(`/sessions/${s.session_id}/remote-stop`, { method: 'POST', headers: AH }).catch(() => {});
      }
    }
  } catch {}
  const driver = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: `shot${Date.now()}@example.in`, password: 'Driver@123', full_name: 'Shot Driver' }),
  });
  const H = { Authorization: `Bearer ${driver.accessToken}` };
  const tag = `TAG-${driver.user.user_id}`;
  const { stations } = await api('/stations');
  // Resolve OCPP identities via the live feed (identity lives on the charge point).
  const live = [];
  for (const s of stations) {
    const { connectors } = await api(`/stations/${s.station_id}/connectors/live`);
    connectors.forEach((c) => live.push(c));
  }
  // First live session: boot-probe candidates until one accepts (demo-secret CPs only).
  const candidates = live.filter((c) => c.status === 'AVAILABLE' && c.ocpp_identity);
  let ws = null;
  let pick = null;
  for (const cand of candidates) {
    ws = await tryBoot(cand);
    if (ws) {
      pick = cand;
      break;
    }
    console.log(`skipping ${cand.ocpp_identity} (boot/auth failed — generated secret?)`);
  }
  if (!pick) throw new Error('no AVAILABLE connector accepted BootNotification');
  const [, connNo] = pick.connector_ref.split(':').map(Number);

  await ocppCall(ws, 'StatusNotification', { connectorId: connNo, status: 'Available', errorCode: 'NoError' });
  await ocppCall(ws, 'Authorize', { idTag: tag });
  const { transactionId } = await ocppCall(ws, 'StartTransaction', {
    connectorId: connNo,
    idTag: tag,
    meterStart: 0,
    timestamp: new Date().toISOString(),
  });
  console.log(`OCPP tx=${transactionId} on ${pick.connector_ref}`);
  const meter = async (i) =>
    ocppCall(ws, 'MeterValues', {
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
  for (let i = 1; i <= 3; i++) await meter(i);

  // Second session must run on a DIFFERENT charge point — two sockets sharing one OCPP identity
  // would trip the gateway duplicate-connection guard and kill the first session's socket.
  let ws2 = null;
  let avail2 = null;
  for (const cand of candidates.filter((c) => c.ocpp_identity !== pick.ocpp_identity)) {
    ws2 = await tryBoot(cand);
    if (ws2) {
      avail2 = cand;
      break;
    }
  }
  if (!avail2) throw new Error('no second AVAILABLE connector accepted BootNotification');
  const [, no2] = avail2.connector_ref.split(':').map(Number);
  await ocppCall(ws2, 'Authorize', { idTag: tag });
  const started2 = await ocppCall(ws2, 'StartTransaction', {
    connectorId: no2,
    idTag: tag,
    meterStart: 0,
    timestamp: new Date().toISOString(),
  });
  const sid2 = started2.transactionId;
  for (let i = 1; i <= 3; i++) {
    await ocppCall(ws2, 'MeterValues', {
      connectorId: no2,
      transactionId: sid2,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{ value: String(i * 3000), measurand: 'Energy.Active.Import.Register', unit: 'Wh' }],
        },
      ],
    });
  }
  await ocppCall(ws2, 'StopTransaction', {
    transactionId: sid2,
    meterStop: 9000,
    timestamp: new Date().toISOString(),
  });
  ws2.close();
  await api(`/sessions/${sid2}/bill`, { method: 'POST', headers: H });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(`${WEB}/login`);
  await page.getByLabel('Email').fill('arjun@volthub.in');
  await page.getByLabel('Password').fill('Operator@123');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL('**/discover', { timeout: 15000 });

  await page.goto(`${WEB}/dashboard`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/dashboard.png` });

  await page.goto(`${WEB}/telemetry`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/telemetry.png` });

  await page.goto(`${WEB}/invoices`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/invoice.png` });

  // Live session GIF frames: real MeterValues between frames, UI re-polls.
  await page.goto(`${WEB}/session/${transactionId}`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/live-session.png` });
  const framesDir = `${OUT}/gif-frames`;
  fs.mkdirSync(framesDir, { recursive: true });
  for (let i = 4; i <= 11; i++) {
    await meter(i);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${framesDir}/f${i - 3}.png` });
  }
  await ocppCall(ws, 'StopTransaction', {
    transactionId,
    meterStop: 11 * 2500,
    timestamp: new Date().toISOString(),
  });
  ws.close();
  await browser.close();
  console.log(
    JSON.stringify({ tx: transactionId, billed: sid2, shots: fs.readdirSync(OUT), frames: fs.readdirSync(framesDir) })
  );
}
main().catch((e) => {
  console.error('CAPTURE FAIL', e);
  process.exit(1);
});
