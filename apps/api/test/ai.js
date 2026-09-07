// AI advisory surface contract tests (ADR-0008).
// The AI sidecar is STUBBED here on purpose: these tests pin the API's own
// behavior — RBAC, operator station scope, 503 degradation, advisory passthrough —
// not the Python service (that side has its own pytest suite in apps/ai/tests).
// Run: node apps/api/test/ai.js (RATE_LIMIT_OFF=1)
'use strict';
process.env.RATE_LIMIT_OFF = '1';
const assert = require('assert');
const http = require('http');

async function main() {
  // ---- stub AI sidecar (records the x-internal token handling too) ----
  const seen = { auth: [] };
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.auth.push(req.headers['x-internal']);
      const j =
        req.url === '/v1/forecast'
          ? { advisory: true, stations: { 1: { hours: [1, 2, 3], model: 'mlp_128x64' } } }
          : req.url === '/v1/anomalies'
            ? { advisory: true, checked: 2, flagged: [{ session_id: 1, reasons: ['meter delta z=9.00'] }] }
            : req.url === '/v1/optimize'
              ? { advisory: true, feasible: true, objective_cost: 42.5, schedule_kwh: { v1: [11, 11, 11, 0] } }
              : { ok: true };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(j));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubPort = stub.address().port;

  process.env.PORT = '4110';
  const { server } = require('../src/server');
  await new Promise((r) => server.listen(4110, r));
  const B = 'http://localhost:4110/api/v1';
  const api = async (p, o = {}) => {
    const { headers, ...rest } = o;
    const r = await fetch(B + p, { ...rest, headers: { 'content-type': 'application/json', ...(headers || {}) } });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  let pass = 0;
  const t = async (name, fn) => {
    await fn();
    pass++;
    console.log(`  ai ${pass} - ${name}`);
  };

  const reg = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: `aidrv${Date.now()}@example.in`, password: 'Driver@123', full_name: 'AI Driver' }),
  });
  assert.equal(reg.status, 201);
  const DH = { Authorization: `Bearer ${reg.j.accessToken}` };

  // admin for provisioning
  const adm = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@volthub.in', password: 'Admin@123' }),
  });
  const AH = { Authorization: `Bearer ${adm.j.accessToken}` };
  const stations = await api('/admin/stations', { headers: AH });
  const stId = Math.max(...stations.j.stations.map((s) => s.station_id));
  const other = stations.j.stations.find((s) => s.station_id !== stId);
  const op = await api('/admin/users', {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({
      email: `aiscope.${Date.now()}@volthub.in`,
      role: 'OPERATOR',
      stationId: stId,
      full_name: 'AI Scope Op',
    }),
  });
  const opLogin = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: op.j.user.email, password: 'Temp@1234' }),
  });
  const OH = { Authorization: `Bearer ${opLogin.j.accessToken}` };

  process.env.AI_URL = `http://127.0.0.1:${stubPort}`;

  await t('TEST-AI-1: drivers are 403 on the AI surface (staff-only advisory data)', async () => {
    const r = await api(`/ai/forecast?stationId=${stId}`, { headers: DH });
    assert.equal(r.status, 403, `driver must be 403, got ${r.status}`);
    const a = await api(`/ai/anomalies?stationId=${stId}`, { headers: DH });
    assert.equal(a.status, 403);
    const o = await api('/ai/optimize', {
      method: 'POST',
      headers: DH,
      body: JSON.stringify({ stationId: stId, vehicles: [{ id: 'v1', energyKwh: 10 }] }),
    });
    assert.equal(o.status, 403);
  });

  await t('TEST-AI-2: operator scope — in-scope 200, out-of-scope 403 OUT_OF_SCOPE', async () => {
    const ok = await api(`/ai/forecast?stationId=${stId}&hours=6`, { headers: OH });
    assert.equal(ok.status, 200, `in-scope forecast must be 200, got ${ok.status}`);
    assert.equal(ok.j.advisory, true, 'AI responses must be marked advisory');
    assert.equal(ok.j.station_id, stId);
    const out = await api(`/ai/forecast?stationId=${other.station_id}`, { headers: OH });
    assert.equal(out.status, 403);
    assert.equal(out.j.error.code, 'OUT_OF_SCOPE');
  });

  await t('TEST-AI-3: unknown station is 404 before any AI call', async () => {
    const r = await api('/ai/forecast?stationId=99999', { headers: AH });
    assert.equal(r.status, 404);
  });

  await t('TEST-AI-4: anomalies + optimize pass through advisory payloads (station-scoped ticks)', async () => {
    const a = await api(`/ai/anomalies?stationId=${stId}`, { headers: OH });
    assert.equal(a.status, 200);
    assert.equal(a.j.advisory, true);
    assert.ok('checked' in a.j);
    const o = await api('/ai/optimize', {
      method: 'POST',
      headers: OH,
      body: JSON.stringify({
        stationId: stId,
        windowHours: 4,
        vehicles: [{ id: 'v1', arriveHour: 0, deadlineHour: 4, energyKwh: 33, maxKw: 11 }],
      }),
    });
    assert.equal(o.status, 200);
    assert.equal(o.j.feasible, true);
    assert.equal(o.j.objective_cost, 42.5);
    // the proxy must have attached the shared internal token to the sidecar call
    assert.ok(
      seen.auth.every((tok) => tok === 'dev-internal'),
      'x-internal token must ride every sidecar call'
    );
  });

  await t('TEST-AI-5: sidecar down → 503 AI_UNAVAILABLE (graceful, never a 500)', async () => {
    process.env.AI_URL = 'http://127.0.0.1:9'; // nothing listens here
    const r = await api(`/ai/forecast?stationId=${stId}`, { headers: OH });
    assert.equal(r.status, 503, `sidecar-down must be 503, got ${r.status}`);
    assert.equal(r.j.error.code, 'AI_UNAVAILABLE');
    const o = await api('/ai/optimize', {
      method: 'POST',
      headers: OH,
      body: JSON.stringify({ stationId: stId, vehicles: [{ id: 'v1', energyKwh: 1 }] }),
    });
    assert.equal(o.status, 503);
    process.env.AI_URL = `http://127.0.0.1:${stubPort}`;
  });

  await t('TEST-AI-6: optimize without vehicles is 422 before the sidecar is consulted', async () => {
    const r = await api('/ai/optimize', { method: 'POST', headers: OH, body: JSON.stringify({ stationId: stId }) });
    assert.equal(r.status, 422);
    assert.equal(r.j.error.code, 'INVALID_VEHICLES');
  });

  console.log(`\nAI contract tests: ${pass} passed`);
  server.close();
  stub.close();
  process.exit(0);
}
main().catch((e) => {
  console.error('AI-TEST FAIL', e);
  process.exit(1);
});
