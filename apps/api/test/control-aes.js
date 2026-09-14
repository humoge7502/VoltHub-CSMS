// ADR-0015 / Acceptance-envelope scheduling (AES) property suite.
// The mechanism's claims, pinned as deterministic properties (not statistics):
//   A1 NO-OP BELOW THE KNEE — when no vehicle's SoC ever passes the CC-CV knee
//      (acceptanceFactor == 1 throughout), solveSchedule(acceptanceAware=true) is
//      UNIT-IDENTICAL to solveSchedule(acceptanceAware=false): same schedule, same
//      metrics. A fix that cannot regress the compliant case is a prerequisite for
//      shipping it.
//   A2 PLAN HONESTY — above the knee, the AES plan's own deliverability claim
//      (absorbable_kwh) equals what the same physics (twin.applyActuatorReality)
//      delivers on a fully compliant fleet: the plan stops claiming energy the
//      vehicle cannot take. This is the exact property whose absence was the E3
//      failure (42.6% shortfall), so it is pinned here AND measured end-to-end in
//      bench/e6-taper.js.
//   A3 ENVELOPE + WINDOWS STILL HOLD — with AES on, no interval exceeds the site
//      cap, and no vehicle is scheduled before arrival or at/after its deadline.
//   A4 THE PROMISE IS DELIVERABLE — on a taper-bound vehicle, the energy the AES
//      schedule absorbs by the deadline is >= the certificate floor promise
//      (min(floor_kw * dt_h * slots, remaining_kwh)).
// Run: node apps/api/test/control-aes.js
'use strict';
const assert = require('assert');
const model = require('../src/control/model');
const twin = require('../../simulator/src/twin');

const dtMin = 15;
const dtH = dtMin / 60;

function horizonNow() {
  return twin.SCENARIO_EPOCH + 6 * 3600e3; // 06:00 UTC: mid-shoulder, stable window
}

function solve(
  vehicles,
  { acceptanceAware, siteCapKw = Infinity, prices = null, horizon = model.DEFAULT_HORIZON, now = horizonNow() } = {}
) {
  const now0 = now;
  const cpCaps = new Map([...new Set(vehicles.map((v) => v.cpId))].map((cpId) => [cpId, 22])); // one vehicle per CP
  return model.solveSchedule({
    vehicles,
    siteCapKw,
    cpCaps,
    priceSeries: prices ? () => prices : () => Array(horizon).fill(0.3),
    dtMin,
    horizon,
    now: now0,
    acceptanceAware,
  });
}

let pass = 0;
const t = (name, fn) => {
  fn();
  pass++;
  console.log(`  ok ${pass} - ${name}`);
};

function main() {
  const now = horizonNow();
  const grid = model.intervalGrid(now, dtMin, model.DEFAULT_HORIZON);

  const mkVehicle = (socRef, remainingKwh, batteryKwh = 60, deadlineSlots = 24) => ({
    sessionId: 1,
    cpId: 1,
    connectorNo: 1,
    maxKw: 22,
    batteryKwh,
    socRef,
    startSoc: socRef,
    remainingKwh,
    arrivalAt: grid.start,
    deadlineAt: grid.start + deadlineSlots * grid.dt,
    certifiedFloorKw: 0,
  });

  // Metrics minus the two AES-only provenance fields: below the knee the AES allocator
  // is the power-based allocator, so its metrics must be the legacy metrics plus exactly
  // {absorbable_kwh, acceptance_aware}.
  const strip = (m) => {
    const { absorbable_kwh: _a, acceptance_aware: _b, ...rest } = m;
    return rest;
  };

  t('A1 below the knee: AES is unit-identical to the power-based allocator', () => {
    // battery 60 kWh, SoC reference 0.50, need 12 kWh => SoC <= 0.70 < knee(0.8),
    // so acceptanceFactor == 1 across the whole window: the pre-AES behaviour,
    // exactly.
    const v = mkVehicle(0.5, 12);
    const legacy = solve([v], { acceptanceAware: false });
    const aes = solve([v], { acceptanceAware: true });
    assert.deepEqual(aes.schedule, legacy.schedule, 'schedules must be identical below the knee');
    assert.deepEqual(strip(aes.metrics), strip(legacy.metrics), 'core metrics identical below the knee');
    assert.equal(legacy.metrics.acceptance_aware, undefined, 'legacy metrics carry no AES fields');
    assert.equal(aes.metrics.acceptance_aware, true, 'AES metrics name the allocator');
    assert.ok(Number.isFinite(aes.metrics.absorbable_kwh), 'AES metrics carry the deliverability claim');
    // Below the knee everything planned IS absorbed: the claim equals the delivery.
    assert.ok(
      Math.abs(aes.metrics.absorbable_kwh - aes.metrics.delivered_kwh) < 1e-6,
      `claim ${aes.metrics.absorbable_kwh} == delivered ${aes.metrics.delivered_kwh}`
    );
  });

  t('A1b mixed fleet below knee: multiple vehicles, capped site', () => {
    const vs = [mkVehicle(0.45, 10, 60, 20), mkVehicle(0.55, 8, 45)].map((v, i) => ({
      ...v,
      sessionId: 10 + i,
      cpId: i + 1,
    }));
    const legacy = solve(vs, { acceptanceAware: false, siteCapKw: 30 });
    const aes = solve(vs, { acceptanceAware: true, siteCapKw: 30 });
    assert.deepEqual(aes.schedule, legacy.schedule);
    assert.deepEqual(strip(aes.metrics), strip(legacy.metrics));
  });

  t('A2 plan honesty above the knee: AES claim == actuator reality (twin scenarios)', () => {
    for (const seed of [1, 7, 42]) {
      const sc = twin.makeScenario({
        seed,
        dtMin,
        horizonMin: 24 * 60,
        cps: 6,
        siteCapKw: 40,
        arrivalsPerHour: 3.6,
        targetSoc: 0.95,
      });
      if (!sc.vehicles.length) continue;
      const solved = solve(sc.vehicles, {
        acceptanceAware: true,
        siteCapKw: sc.siteCapKw,
        prices: sc.prices,
        horizon: sc.horizon,
        now: sc.gridStart,
      });
      const reality = twin.applyActuatorReality(sc, solved.schedule); // fully compliant fleet
      const realized = [...reality.deliveredByVehicle.values()].reduce((a, b) => a + b, 0);
      assert.ok(
        Math.abs(solved.metrics.absorbable_kwh - realized) < 1e-3,
        `seed ${seed}: AES claim ${solved.metrics.absorbable_kwh} kWh vs physics ${realized} kWh`
      );
    }
  });

  t('A2b the defect it fixes: legacy plan claims energy the vehicle cannot take', () => {
    const sc = twin.makeScenario({
      seed: 3,
      dtMin,
      horizonMin: 24 * 60,
      cps: 2,
      siteCapKw: 30,
      arrivalsPerHour: 1.8,
      targetSoc: 0.95,
    });
    if (!sc.vehicles.length) return;
    const legacy = solve(sc.vehicles, {
      acceptanceAware: false,
      siteCapKw: sc.siteCapKw,
      prices: sc.prices,
      horizon: sc.horizon,
      now: sc.gridStart,
    });
    const aes = solve(sc.vehicles, {
      acceptanceAware: true,
      siteCapKw: sc.siteCapKw,
      prices: sc.prices,
      horizon: sc.horizon,
      now: sc.gridStart,
    });
    const blame = (sched) => {
      let absorbed = 0;
      for (const v of sc.vehicles) {
        absorbed += model.absorbedByVehicle(v, sched[v.sessionId] || [], dtH, v.startSoc);
      }
      return absorbed;
    };
    const legacyAbsorbed = blame(legacy.schedule);
    const aesAbsorbed = blame(aes.schedule);
    assert.ok(
      aesAbsorbed > legacyAbsorbed + 1e-6,
      `AES must absorb more than the taper-blind plan on a target-95 fleet (${aesAbsorbed} vs ${legacyAbsorbed} kWh)`
    );
    assert.ok(Math.abs(aesAbsorbed - aes.metrics.absorbable_kwh) < 1e-3, 'AES absorBable matches its own simulation');
  });

  t('A3 envelope + windows hold with AES on', () => {
    const sc = twin.makeScenario({
      seed: 11,
      dtMin,
      horizonMin: 24 * 60,
      cps: 6,
      siteCapKw: 40,
      arrivalsPerHour: 3.6,
      targetSoc: 0.95,
    });
    const solved = solve(sc.vehicles, {
      acceptanceAware: true,
      siteCapKw: sc.siteCapKw,
      prices: sc.prices,
      horizon: sc.horizon,
      now: sc.gridStart,
    });
    const capPerT = sc.siteCapKw * dtH;
    for (let t = 0; t < sc.horizon; t++) {
      const total = Object.values(solved.schedule).reduce((a, arr) => a + (arr[t] || 0), 0);
      assert.ok(total <= capPerT + 1e-6, `interval ${t} exceeds site cap: ${total}`);
    }
    const bySid = new Map(sc.vehicles.map((v) => [v.sessionId, v]));
    for (const [sid, arr] of Object.entries(solved.schedule)) {
      const v = bySid.get(Number(sid));
      if (!v) continue;
      for (let t = 0; t < arr.length; t++) {
        if (t < v.arrivalSlot) assert.equal(arr[t], 0, `energy before arrival (slot ${t})`);
        if (t >= v.deadlineSlot) assert.equal(arr[t], 0, `energy at/after deadline (slot ${t})`);
      }
    }
  });

  t('A4 the certificate promise is deliverable by an AES schedule', () => {
    // A taper-bound vehicle: SoC reference 0.85 (just past the knee), a battery whose
    // headroom makes the requirement physically possible (100 kWh at 0.85 keeps 15 kWh
    // of headroom for the 8 kWh request), 24-slot window, 10 kW site cap. Certify, then
    // schedule with the floor, then check the promise is absorbed.
    const v = mkVehicle(0.85, 8, 100, 24);
    const verdict = model.certifyVehicle({
      vehicle: v,
      siteCapKw: 10,
      certifiedFloorKw: 0,
      now: grid.start,
      deadlineAt: v.deadlineAt,
      marginKwh: 0.5,
    });
    if (!verdict.admitted) throw new Error('A4 fixture must admit (test bug, not assertion failure)');
    const promised = Math.min(verdict.floorKw * dtH * 24, v.remainingKwh);
    const solved = solve([{ ...v, certifiedFloorKw: verdict.floorKw }], { acceptanceAware: true, siteCapKw: 10 });
    const absorbed = model.absorbedByVehicle(v, solved.schedule[1] || [], dtH, v.socRef);
    assert.ok(absorbed + 1e-6 >= promised, `promised ${promised} kWh but AES schedule absorbs ${absorbed}`);
  });

  console.log(`\nControl-AES tests: ${pass} passed`);
  process.exit(0);
}

main();
