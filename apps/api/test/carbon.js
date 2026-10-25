// CarbonPilot (ADR-0017) contract tests.
// Pins the claims that make carbon accounting useful rather than decorative:
//   C1  the signal is deterministic and region-aware (no random plan-to-plan drift);
//   C2  a receipt is arithmetic over the meter trail, not a re-estimate;
//   C3  carbon is an ADDITIONAL price — weight 0 is bit-identical to no carbon;
//   C4  carbon can move energy into cleaner hours without breaking the deadline;
//   C5  a missed budget is reported, never used to strand a vehicle;
//   C6  the HTTP surface enforces owner/staff/scope rules and documents its model.
// Run: node apps/api/test/carbon.js (RATE_LIMIT_OFF=1)
'use strict';
process.env.RATE_LIMIT_OFF = '1';
const assert = require('assert');
const { createStore } = require('../src/db/store');
const { seedStore } = require('../src/db/seed');
const carbon = require('../src/carbon/intensity');
const model = require('../src/control/model');
const control = require('../src/control/controller');

function stageSession(store, ref, { readings = [], startKwh = 0, endKwh = null, state = 'COMPLETED' } = {}) {
  const sid = 8000 + store.sessions.size;
  const cpId = Number(String(ref).split(':')[0]);
  const sess = {
    session_id: sid,
    user_id: 1,
    connector_ref: ref,
    cp_id: cpId,
    connector_no: Number(String(ref).split(':')[1]),
    tariff_plan_id: store.defaultPlanId(),
    state,
    billing_state: 'UNBILLED',
    started_at: new Date('2026-10-20T12:00:00.000Z').toISOString(),
    ended_at: state === 'COMPLETED' ? new Date('2026-10-20T20:00:00.000Z').toISOString() : null,
    start_meter_kwh: startKwh,
    end_meter_kwh: endKwh,
    energy_kwh: endKwh != null ? endKwh - startKwh : null,
  };
  store.sessions.set(sid, sess);
  readings.forEach((r, i) =>
    store.readings.push({
      session_id: sid,
      seq_no: i + 1,
      taken_at: r.at,
      meter_kwh: r.kwh,
      power_kw: 7,
      source: 'OCPP',
    })
  );
  return sess;
}

async function main() {
  let pass = 0;
  const t = async (name, fn) => {
    await fn();
    pass++;
    console.log(`  carbon ${pass} - ${name}`);
  };

  await t('C1 intensity is deterministic, bounded and region-aware', async () => {
    const t0 = Date.parse('2026-10-25T12:00:00Z');
    const a = carbon.intensityAt('IN-TN', t0);
    const b = carbon.intensityAt('in-tn', t0);
    assert.deepEqual(a, b, 'same region+instant must be identical');
    assert.ok(a.g_per_kwh >= 5 && a.g_per_kwh <= 1400, 'bounded');
    const no = carbon.intensityAt('NO', t0);
    assert.ok(no.g_per_kwh < a.g_per_kwh, 'hydro Norway must be cleaner than Tamil Nadu');
    const f1 = carbon.forecast({ region: 'IN-TN', from: t0, hours: 48, stepMin: 60 });
    const f2 = carbon.forecast({ region: 'IN-TN', from: t0, hours: 48, stepMin: 60 });
    assert.deepEqual(f1, f2, 'forecast must be reproducible');
    assert.equal(f1.points.length, 48);
    assert.ok(f1.summary.spread_pct > 5, 'diurnal shape must produce a real spread');
    // Tamil Nadu has a solar dip at midday and a coal-heavy evening peak.
    const noon = carbon.intensityAt('IN-TN', Date.parse('2026-10-25T06:30:00Z')); // 12:00 IST
    const eve = carbon.intensityAt('IN-TN', Date.parse('2026-10-25T13:30:00Z')); // 19:00 IST
    assert.ok(noon.g_per_kwh < eve.g_per_kwh, 'evening must be dirtier than the solar midday');
  });

  await t('C2 station region mapping is explicit, never a flattering guess', async () => {
    assert.equal(carbon.regionForStation({ state: 'Tamil Nadu' }), 'IN-TN');
    assert.equal(carbon.regionForStation({ state: 'Tennessee' }), 'US-TN');
    assert.equal(carbon.regionForStation({ city: 'Oslo' }), 'NO');
    assert.equal(carbon.regionForStation({ carbon_region: 'KR' }), 'KR');
    assert.equal(carbon.regionForStation({ city: 'Atlantis' }), 'GLOBAL');
    assert.equal(carbon.regionForStation(null), 'GLOBAL');
  });

  const store = createStore();
  seedStore(store, 'demo');
  const ref = [...store.connectors.keys()][0];
  const dirty = stageSession(store, ref, {
    startKwh: 10,
    endKwh: 20,
    readings: [
      { at: '2026-10-20T13:30:00Z', kwh: 15 }, // 19:00 IST, evening peak
      { at: '2026-10-20T19:30:00Z', kwh: 18 }, // 01:00 IST, clean night
    ],
  });

  await t('C3 receipt is meter arithmetic with a stable, verifiable hash', async () => {
    const rec = carbon.receiptForSession(store, dirty.session_id);
    assert.equal(rec.session_id, dirty.session_id);
    assert.equal(rec.region, 'IN-TN');
    assert.equal(rec.energy_kwh, 10, 'start 10 -> stop 20 = 10 kWh');
    const manual = rec.intervals.reduce((a, x) => a + x.carbon_g, 0);
    assert.ok(Math.abs(manual - rec.carbon_g) < 1e-6, 'total equals the sum of intervals');
    assert.match(rec.receipt_sha256, /^[a-f0-9]{64}$/);
    const again = carbon.receiptForSession(store, dirty.session_id);
    assert.equal(again.receipt_sha256, rec.receipt_sha256, 'same data must hash the same');
    const dirtySlot = rec.intervals[0];
    const cleanSlot = rec.intervals[1];
    assert.ok(dirtySlot.g_per_kwh > cleanSlot.g_per_kwh, '19:00 IST must be dirtier than 01:00 IST');
    // The synthetic final segment (last reading 18 -> stop 20) is booked at ended_at.
    assert.equal(rec.intervals.length, 3);
    assert.equal(carbon.receiptForSession(store, 999999), null);
  });

  await t('C4 weight 0 is bit-identical; carbon shifts load into cleaner slots', async () => {
    const now = Date.parse('2026-10-25T00:00:00Z');
    const dtMin = 60;
    const horizon = 24;
    // A car that needs 10 kWh before hour 20; flat tariff isolates the carbon signal.
    const vehicles = [
      {
        sessionId: 1,
        cpId: 1,
        maxKw: 10,
        remainingKwh: 10,
        arrivalAt: now,
        deadlineAt: now + 20 * 3600000,
        certifiedFloorKw: 0,
      },
    ];
    const cpCaps = new Map([[1, 10]]);
    const ticks = model.intervalGrid(now, dtMin, horizon).ticks;
    const price = () => ticks.map(() => 1);
    // Dirtiest 00:00–06:00, clean 12:00–18:00, moderate elsewhere.
    const series = ticks.map((_t, i) => (i < 6 ? 700 : i >= 12 && i < 18 ? 80 : 400));
    const plain = model.solveSchedule({
      vehicles,
      siteCapKw: 10,
      cpCaps,
      priceSeries: price,
      dtMin,
      horizon,
      now,
      carbonSeries: series,
      carbonWeight: 0,
    });
    const noSeries = model.solveSchedule({ vehicles, siteCapKw: 10, cpCaps, priceSeries: price, dtMin, horizon, now });
    assert.deepEqual(plain.schedule, noSeries.schedule, 'weight 0 must not move a single kWh');
    assert.equal(plain.metrics.carbon_g, noSeries.metrics.carbon_g ?? plain.metrics.carbon_g);
    const clean = model.solveSchedule({
      vehicles,
      siteCapKw: 10,
      cpCaps,
      priceSeries: price,
      dtMin,
      horizon,
      now,
      carbonSeries: series,
      carbonWeight: 1,
    });
    assert.ok(clean.metrics.carbon_g < plain.metrics.carbon_g, 'carbon-aware plan must emit less');
    assert.equal(clean.metrics.delivered_kwh, plain.metrics.delivered_kwh, 'same energy delivered');
    const late = Object.values(clean.schedule)[0]
      .slice(20)
      .reduce((a, b) => a + b, 0);
    assert.equal(late, 0, 'deadline slot is still a hard boundary');
    const early = clean.schedule[1].slice(0, 6).reduce((a, b) => a + b, 0);
    assert.ok(early < plain.schedule[1].slice(0, 6).reduce((a, b) => a + b, 0), 'dirty early slots must yield');
  });

  await t('C5 planSite exposes the carbon block only when requested; budget misses are honest', async () => {
    const s2 = createStore();
    seedStore(s2, 'demo');
    const siteId = [...s2.stations.keys()][0];
    const c2 = [...s2.connectors.keys()][0];
    stageSession(s2, c2, {
      startKwh: 0,
      endKwh: 8,
      readings: [{ at: new Date().toISOString(), kwh: 4 }],
      state: 'CHARGING',
    });
    const plain = control.planSite(s2, siteId, {});
    assert.equal(plain.carbon, undefined, 'default planning must not add a carbon block');
    assert.ok(!plain.decision.solver.includes('carbon'));

    const s3 = createStore();
    seedStore(s3, 'demo');
    const c3 = [...s3.connectors.keys()][0];
    stageSession(s3, c3, {
      startKwh: 0,
      endKwh: 8,
      readings: [{ at: new Date().toISOString(), kwh: 4 }],
      state: 'CHARGING',
    });
    const aware = control.planSite(s3, siteId, { carbonWeight: 1 });
    assert.ok(aware.carbon, 'requested plan must carry a carbon block');
    assert.equal(aware.carbon.region, 'IN-TN');
    assert.ok(aware.carbon.carbon_kg >= 0);
    assert.ok(aware.carbon.plan_saved_kg >= -1e-9, 'carbon-aware cannot be worse than its own baseline');
    assert.ok(aware.decision.solver.includes('-carbon'));
    const payload = JSON.parse(aware.decision.payload_json);
    assert.ok(payload.carbon && payload.carbon.carbon_series_g_per_kwh.length === 24, 'carbon provenance is persisted');

    const s4 = createStore();
    seedStore(s4, 'demo');
    const c4 = [...s4.connectors.keys()][0];
    stageSession(s4, c4, {
      startKwh: 0,
      endKwh: 8,
      readings: [{ at: new Date().toISOString(), kwh: 4 }],
      state: 'CHARGING',
    });
    const budget = control.planSite(s4, siteId, { carbonBudgetKg: 0 });
    assert.ok(budget.carbon, 'budget mode must report carbon');
    assert.equal(budget.carbon.budget_met, false, 'zero budget is physically impossible and must say so');
    assert.equal(budget.carbon.weight_applied, 1, 'budget mode escalates to the strongest legitimate preference');
  });

  await t('C6 summary aggregates receipts over a window and validates the range', async () => {
    const sum = carbon.summarize(store, {
      stationId: store.cps.get(Number(String(ref).split(':')[0])).station_id,
      from: '2026-10-19T00:00:00Z',
      to: '2026-10-22T00:00:00Z',
    });
    assert.ok(sum.sessions >= 1);
    assert.ok(sum.energy_kwh >= 10, 'staged 10 kWh must be included');
    assert.ok(sum.carbon_kg > 0 && sum.by_day.length >= 1);
    const bad = carbon.summarize(store, { from: '2026-10-22T00:00:00Z', to: '2026-10-21T00:00:00Z' });
    assert.equal(bad.error, 'INVALID_WINDOW');
  });

  // ---- HTTP surface ---------------------------------------------------------
  process.env.PORT = '4114';
  const { server } = require('../src/server');
  await new Promise((r) => server.listen(4114, r));
  const B = 'http://localhost:4114/api/v1';
  const api = async (p, o = {}) => {
    const { headers, ...rest } = o;
    const r = await fetch(B + p, { ...rest, headers: { 'content-type': 'application/json', ...(headers || {}) } });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  try {
    const login = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@volthub.in', password: 'Admin@123' }),
    });
    assert.equal(login.status, 200, 'admin login');
    const A = { Authorization: `Bearer ${login.j.accessToken}` };
    const reg = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: `carbondrv${Date.now()}@example.in`,
        password: 'Driver@123',
        full_name: 'Carbon Driver',
      }),
    });
    const D = { Authorization: `Bearer ${reg.j.accessToken}` };
    const stations = await api('/admin/stations', { headers: A });
    const st = stations.j.stations[0];
    const liveStore = require('../src/server').store;
    const lref = [...liveStore.connectors.keys()][0];
    const sess = stageSession(liveStore, lref, {
      startKwh: 0,
      endKwh: 5,
      readings: [{ at: new Date().toISOString(), kwh: 2 }],
    });

    await t('C7 HTTP: regions + station card + forecast are authenticated reads', async () => {
      const regions = await api('/carbon/regions', { headers: D });
      assert.equal(regions.status, 200);
      assert.ok(regions.j.regions.length >= 8);
      assert.ok(regions.j.regions.find((x) => x.region === 'IN-TN'));
      const card = await api(`/stations/${st.station_id}/carbon`, { headers: D });
      assert.equal(card.status, 200);
      assert.equal(card.j.region, 'IN-TN');
      assert.equal(card.j.forecast.points.length, 48);
      assert.equal(card.j.advisory, true);
      const fc = await api('/carbon/forecast?region=NO&hours=6', { headers: D });
      assert.equal(fc.status, 200);
      assert.equal(fc.j.points.length, 6);
      const out = await api('/carbon/forecast?region=NO', {});
      assert.equal(out.status, 401, 'no anonymous carbon reads');
    });

    await t('C8 HTTP: receipt is owner-or-staff; summary is operator-only', async () => {
      const own = await api(`/carbon/receipt/${sess.session_id}`, { headers: A });
      assert.equal(own.status, 200);
      assert.match(own.j.receipt.receipt_sha256, /^[a-f0-9]{64}$/);
      const forbidden = await api(`/carbon/receipt/${sess.session_id}`, { headers: D });
      assert.equal(forbidden.status, 403, 'a driver must not read another driver receipt');
      const sum = await api('/carbon/summary', { headers: A });
      assert.equal(sum.status, 200);
      assert.ok(sum.j.summary.sessions >= 0);
      const denied = await api('/carbon/summary', { headers: D });
      assert.equal(denied.status, 403);
      const bad = await api('/carbon/summary?from=2026-10-22T00:00:00Z&to=2026-10-21T00:00:00Z', { headers: A });
      assert.equal(bad.status, 400);
    });
  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log(`\ncarbon: ${pass}/${pass} passed`);
}

main().catch((e) => {
  console.error('CARBON TEST FAILED', e);
  process.exitCode = 1;
});
