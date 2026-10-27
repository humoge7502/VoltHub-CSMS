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
  const seen = { auth: [], forecast: [], drift: [], explain: [] };
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.auth.push(req.headers['x-internal']);
      const parsed = (() => {
        try {
          return JSON.parse(body);
        } catch {
          return null;
        }
      })();
      if (req.url === '/v1/forecast') seen.forecast.push(parsed);
      if (req.url === '/v1/drift') seen.drift.push(parsed);
      if (req.url === '/v1/explain') seen.explain.push(parsed);
      const j =
        req.url === '/v1/forecast'
          ? { advisory: true, stations: { 1: { hours: [1, 2, 3], model: 'mlp_128x64' } } }
          : req.url === '/v1/anomalies'
            ? { advisory: true, checked: 2, flagged: [{ session_id: 1, reasons: ['meter delta z=9.00'] }] }
            : req.url === '/v1/optimize'
              ? { advisory: true, feasible: true, objective_cost: 42.5, schedule_kwh: { v1: [11, 11, 11, 0] } }
              : req.url === '/v1/model-card'
                ? {
                    advisory: true,
                    model: { name: 'vh-demand-mlp', loaded: true },
                    training_data: { stations: 87, sources: ['korea', 'norway', 'tennessee'] },
                    evaluation: { intervals: { empirical_coverage: 0.8029 } },
                  }
                : req.url === '/v1/drift'
                  ? {
                      advisory: true,
                      verdict: 'stable',
                      retrain_recommended: false,
                      psi: 0.04,
                      reasons: ['no material distribution shift detected'],
                    }
                  : req.url === '/v1/explain'
                    ? {
                        advisory: true,
                        forecast_kwh: [10, 11],
                        attributions: [{ group: 'history_last_6h', mean_delta_kwh: 4.2 }],
                        top_driver: 'history_last_6h',
                      }
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

  await t(
    'TEST-AI-7: forecast sends timestamped hourly kWh on a contiguous grid, clamped to the trained horizon',
    async () => {
      // The model is trained on hourly ENERGY with real clock anchors. This route once
      // sent hourly session COUNTS with no timestamps, so the sidecar scored a
      // different quantity than it was fitted for and derived hour-of-day from the
      // array length. This test is the pin that keeps the two halves in step.
      const r = await api(`/ai/forecast?stationId=${stId}&hours=48`, { headers: OH });
      assert.equal(r.status, 200);
      assert.equal(r.j.history_hours, 240, 'the proxy must state how much history it sent');
      const sent = seen.forecast[seen.forecast.length - 1];
      assert.equal(sent.hours, 24, 'hours must clamp to contract.HORIZON (24), not 48');
      const h = sent.history[String(stId)];
      assert.ok(h && Array.isArray(h.timestamps) && Array.isArray(h.kwh), 'history must be {timestamps, kwh}');
      assert.equal(h.timestamps.length, h.kwh.length);
      assert.ok(h.kwh.length >= 168, `contract.MIN_HISTORY_H is 168, sent ${h.kwh.length}`);
      assert.ok(
        h.kwh.every((v) => Number.isFinite(v) && v >= 0),
        'kWh history must be finite and non-negative'
      );
      for (let i = 1; i < h.timestamps.length; i++) {
        const gap = Date.parse(h.timestamps[i]) - Date.parse(h.timestamps[i - 1]);
        // The sidecar rejects a holed grid outright (422), so the proxy must never send one.
        assert.equal(gap, 3600000, `history grid must be contiguous hourly, gap at ${i}: ${gap} ms`);
        assert.equal(h.timestamps[i].slice(-1), 'Z', 'timestamps must be UTC-anchored RFC-3339');
      }
    }
  );

  await t('TEST-AI-8: model card is staff-only and exposes the receipt, not just a version', async () => {
    const driver = await api('/ai/model-card', { headers: DH });
    assert.equal(driver.status, 403);
    const r = await api('/ai/model-card', { headers: OH });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.equal(r.j.advisory, true);
    assert.equal(r.j.model.loaded, true);
    assert.equal(r.j.training_data.stations, 87);
    assert.ok(r.j.evaluation.intervals.empirical_coverage > 0.7);
    assert.ok(seen.auth.every((tok) => tok === 'dev-internal'));
  });

  await t('TEST-AI-9: drift proxy splits a contiguous 21-day grid into baseline + recent', async () => {
    const out = await api(`/ai/drift?stationId=${other.station_id}`, { headers: OH });
    assert.equal(out.status, 403);
    const r = await api(`/ai/drift?stationId=${stId}&baselineDays=14&recentDays=7`, { headers: OH });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.equal(r.j.station_id, stId);
    assert.equal(r.j.baseline_days, 14);
    assert.equal(r.j.recent_days, 7);
    const sent = seen.drift[seen.drift.length - 1];
    assert.equal(sent.station_id, stId);
    assert.equal(sent.baseline.timestamps.length, 14 * 24);
    assert.equal(sent.recent.timestamps.length, 7 * 24);
    assert.equal(sent.baseline.timestamps.length, sent.baseline.kwh.length);
    assert.equal(sent.recent.timestamps.length, sent.recent.kwh.length);
    // The split must be the SAME series: recent starts where baseline ended, one hour later.
    assert.equal(
      Date.parse(sent.recent.timestamps[0]) - Date.parse(sent.baseline.timestamps.at(-1)),
      3600000,
      'baseline and recent must be contiguous halves of one hourly grid'
    );
  });

  await t('TEST-AI-10: explain is station-scoped and sends the same 240 h history as forecast', async () => {
    const out = await api('/ai/explain', {
      method: 'POST',
      headers: OH,
      body: JSON.stringify({ stationId: other.station_id, hours: 6 }),
    });
    assert.equal(out.status, 403);
    const r = await api('/ai/explain', {
      method: 'POST',
      headers: OH,
      body: JSON.stringify({ stationId: stId, hours: 6 }),
    });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.equal(r.j.station_id, stId);
    assert.equal(r.j.top_driver, 'history_last_6h');
    assert.equal(r.j.history_hours, 240);
    const sent = seen.explain[seen.explain.length - 1];
    assert.equal(sent.station_id, stId);
    assert.equal(sent.hours, 6);
    assert.equal(sent.history.timestamps.length, 240);
    assert.equal(sent.history.kwh.length, 240);
  });

  await t('TEST-AI-11: production refuses to dial the sidecar with a published or missing AI_TOKEN', async () => {
    // The sidecar already fails fast without a >=24-byte secret in production
    // (apps/ai/service.py). The proxy used to paper over the gap by falling back to
    // the literal 'dev-internal' — a value published in .env.example — so a
    // misconfigured deploy silently sent a well-known string to an internal endpoint
    // instead of erroring. Demo boots keep the fallback; production fails closed.
    const origToken = process.env.AI_TOKEN;
    const devSeen = seen.auth.length;

    const r = await api(`/ai/forecast?stationId=${stId}`, { headers: OH });
    assert.ok(
      seen.auth.slice(devSeen).every((tok) => tok === 'dev-internal'),
      'with NODE_ENV unset the demo fallback must still ride'
    );
    assert.equal(r.status, 200);

    process.env.NODE_ENV = 'production';
    try {
      delete process.env.AI_TOKEN;
      const before = seen.auth.length;
      const unset = await api(`/ai/forecast?stationId=${stId}`, { headers: OH });
      assert.equal(unset.status, 503, `unset AI_TOKEN must be 503, got ${unset.status}`);
      assert.equal(unset.j.error.code, 'AI_UNAVAILABLE');
      assert.match(unset.j.error.message, /AI_TOKEN/, `the outage must name the secret: ${unset.j.error.message}`);
      assert.equal(seen.auth.length, before, 'a misconfigured proxy must not reach the sidecar at all');

      process.env.AI_TOKEN = 'dev-internal';
      const literal = await api(`/ai/forecast?stationId=${stId}`, { headers: OH });
      assert.equal(literal.status, 503, 'the published dev literal is not a production credential');

      process.env.AI_TOKEN = 'a'.repeat(32);
      const wired = await api(`/ai/forecast?stationId=${stId}`, { headers: OH });
      assert.equal(wired.status, 200, `a real secret must work, got ${wired.status}`);
      assert.equal(seen.auth.at(-1), 'a'.repeat(32), 'the configured secret must be the one that rides');
    } finally {
      delete process.env.NODE_ENV;
      if (origToken === undefined) delete process.env.AI_TOKEN;
      else process.env.AI_TOKEN = origToken;
    }
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
