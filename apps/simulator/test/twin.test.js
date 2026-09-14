// Twin + baselines + offline-harness tests.
// The twin is what every experiment's legitimacy rests on, so its properties are pinned
// like any other invariant: determinism, window discipline, monotone acceptance, and the
// evaluator's arithmetic.
// Run: node apps/simulator/test/twin.test.js
'use strict';
const assert = require('assert');
const twin = require('../src/twin');
const baselines = require('../src/baselines');
const offline = require('../src/offline');
const model = require('../../api/src/control/model');

const SCENARIO = () =>
  twin.makeScenario({ seed: 42, dtMin: 15, horizonMin: 24 * 60, cps: 6, siteCapKw: 40, arrivalsPerHour: 3.6 });

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

const realityTotal = (sched, v) => (sched[v.sessionId] || []).reduce((a, b) => a + b, 0);

async function main() {
  let pass = 0;
  const t = (name, fn) => {
    fn();
    pass++;
    console.log(`  twin ${pass} - ${name}`);
  };

  t('determinism: the same seed yields a byte-identical scenario', () => {
    const a = twin.makeScenario({ seed: 7, dtMin: 15, horizonMin: 1440, cps: 6 });
    const b = twin.makeScenario({ seed: 7, dtMin: 15, horizonMin: 1440, cps: 6 });
    assert.deepEqual(a, b, 'same seed => same scenario (paired comparisons depend on it)');
    const c = twin.makeScenario({ seed: 8, dtMin: 15, horizonMin: 1440, cps: 6 });
    assert.notDeepEqual(a.vehicles, c.vehicles, 'a different seed yields a different fleet');
  });

  t('reproducibility: the default anchor is a fixed epoch, not the wall clock', () => {
    // The receipt claim is "reproducible from its seed". That was false while the default
    // anchor was Date.now(): the same command returned different numbers minutes apart
    // (the horizon slid across ToU bands and commute peaks). Assert the anchor is the
    // stated constant and that no call consults the clock.
    assert.ok(Number.isFinite(twin.SCENARIO_EPOCH), 'the epoch is a stated constant');
    assert.equal(new Date(twin.SCENARIO_EPOCH).toISOString(), twin.SCENARIO_EPOCH_ISO);
    const s = twin.makeScenario({ seed: 11, dtMin: 15, horizonMin: 1440, cps: 6 });
    assert.equal(s.gridStart, twin.SCENARIO_EPOCH, 'the scenario starts at the fixed epoch');
    // Half-open check: a scenario built now and one built after a wall-clock tick are the
    // same object, which is only true if nothing in the path reads the current time.
    const before = JSON.stringify(twin.makeScenario({ seed: 11, dtMin: 15, horizonMin: 1440, cps: 6 }));
    const busyUntil = Date.now() + 5;
    while (Date.now() < busyUntil);
    const after = JSON.stringify(twin.makeScenario({ seed: 11, dtMin: 15, horizonMin: 1440, cps: 6 }));
    assert.equal(before, after, 'a wall-clock tick cannot change the scenario');
  });

  t('timezone independence: diurnal prices and arrivals are computed in UTC', () => {
    // The same run must produce the same receipt on a UTC CI runner and on a laptop in
    // UTC+5:30. touPrice/arrivalIntensity therefore use getUTCHours, and a 24-hour horizon
    // from the fixed epoch covers each band a fixed number of times.
    const at = (iso) => twin.touPrice(Date.parse(iso));
    assert.equal(at('2026-03-02T18:00:00Z'), 0.55, 'peak band (17:00-22:00 UTC)');
    assert.equal(at('2026-03-02T03:00:00Z'), 0.16, 'off-peak band (23:00-06:00 UTC)');
    assert.equal(at('2026-03-02T12:00:00Z'), 0.32, 'shoulder otherwise');
    assert.equal(at('2026-03-02T23:30:00Z'), 0.16, 'off-peak wraps midnight');
    const s = twin.makeScenario({ seed: 3, dtMin: 15, horizonMin: 1440, cps: 6 });
    const counts = {};
    for (const p of s.prices) counts[p] = (counts[p] || 0) + 1;
    // 96 intervals starting 00:00 UTC: 7 off-peak hours (23-06), 5 peak (17-22), rest shoulder.
    assert.equal(counts[0.16], 28, 'off-peak interval count is fixed by UTC, not by the runner');
    assert.equal(counts[0.55], 20, 'peak interval count is fixed by UTC');
    assert.equal(counts[0.32], 48, 'shoulder interval count is fixed by UTC');
  });

  t('scenario shape: arrivals precede departures, needs are positive and satisfied-in-principle', () => {
    const s = SCENARIO();
    assert.ok(s.vehicles.length > 0, 'a fleet is generated');
    for (const v of s.vehicles) {
      assert.ok(v.arrivalSlot < v.deadlineSlot, 'plug-in before departure');
      assert.ok(v.deadlineSlot <= s.horizon, 'departure inside the horizon');
      assert.ok(v.remainingKwh > 0, 'only charging events are emitted');
      assert.ok(v.maxKw > 0 && v.batteryKwh > 0);
      assert.ok(v.targetSoc > v.startSoc, 'the target is above the arrival SoC');
    }
    assert.ok(
      s.prices.every((p) => p > 0),
      'prices are positive'
    );
    assert.ok(new Set(s.prices).size > 1, 'the tariff is not flat (arbitrage must be possible)');
  });

  t('acceptance taper: monotone non-increasing, full below the knee', () => {
    assert.equal(twin.acceptanceFactor(0.2), 1);
    assert.equal(twin.acceptanceFactor(0.8), 1);
    assert.ok(twin.acceptanceFactor(0.9) < 1, 'above the knee acceptance drops');
    assert.ok(twin.acceptanceFactor(1) < twin.acceptanceFactor(0.9), 'monotone decay');
    assert.ok(twin.acceptanceFactor(null) === 1, 'unknown SoC must not silently throttle');
  });

  t('actuator reality: a compliant vehicle never exceeds acceptance or its own need', () => {
    const s = SCENARIO();
    const requested = baselines.uncontrolled(s); // deliberately aggressive
    const reality = twin.applyActuatorReality(s, requested);
    for (const v of s.vehicles) {
      const total = reality.schedule[v.sessionId].reduce((a, b) => a + b, 0);
      assert.ok(total <= v.batteryKwh * (1 - v.startSoc) + 1e-6, 'never exceeds the battery headroom');
      assert.ok(approx(total, reality.deliveredByVehicle.get(v.sessionId), 1e-4));
      // Nothing delivered outside the plug-in window.
      for (let i = 0; i < v.arrivalSlot; i++) assert.equal(reality.schedule[v.sessionId][i], 0);
      for (let i = v.deadlineSlot; i < s.horizon; i++) assert.equal(reality.schedule[v.sessionId][i], 0);
    }
  });

  t('actuator reality: a non-compliant charger ignores the schedule (the adversarial case)', () => {
    const s = twin.makeScenario({
      seed: 3,
      dtMin: 15,
      horizonMin: 1440,
      cps: 4,
      siteCapKw: 20,
      nonCompliantFraction: 1,
    });
    assert.ok(
      s.vehicles.every((v) => v.nonCompliant),
      'every vehicle is non-compliant in this arm'
    );
    const zeros = Object.fromEntries(s.vehicles.map((v) => [v.sessionId, Array(s.horizon).fill(0)]));
    const reality = twin.applyActuatorReality(s, zeros);
    const moved = [...reality.deliveredByVehicle.values()].reduce((a, b) => a + b, 0);
    assert.ok(moved > 0, 'a charger that ignores the profile still draws power — the deviation is measurable');
    // And it draws IMMEDIATELY rather than following the (empty) schedule.
    const v0 = s.vehicles[0];
    assert.ok(reality.schedule[v0.sessionId][v0.arrivalSlot] > 0, 'natural draw starts at plug-in');
  });

  t('baselines: every strategy respects the plug-in window and the site cap where claimed', () => {
    const s = SCENARIO();
    for (const [name, fn] of Object.entries({
      static_cap: baselines.staticCap,
      price_blind_edf: baselines.priceGreedyEdf,
      uncontrolled: baselines.uncontrolled,
      cost_lower_bound: baselines.costLowerBound,
    })) {
      const sched = fn(s);
      for (const v of s.vehicles) {
        for (let i = 0; i < v.arrivalSlot; i++) assert.equal(sched[v.sessionId][i], 0, `${name}: before arrival`);
        for (let i = v.deadlineSlot; i < s.horizon; i++)
          assert.equal(sched[v.sessionId][i], 0, `${name}: after deadline`);
      }
      const metrics = twin.evaluate(s, sched, { betaPerKw: 10 });
      assert.ok(metrics.delivered_kwh > 0, `${name}: delivers something`);
      if (name !== 'uncontrolled' && name !== 'cost_lower_bound') {
        assert.ok(metrics.peak_kw <= s.siteCapKw + 1e-6, `${name}: respects the site cap`);
      }
      if (name === 'cost_lower_bound') {
        // Properties that actually hold for the relaxed bound: it never over-delivers a
        // vehicle, it respects every window and rate, and it fills cheapest slots first.
        // (It is NOT comparable in absolute cost to strategies that serve less energy —
        // see the scope caveat in baselines.js.)
        for (const v of s.vehicles)
          assert.ok(realityTotal(sched, v) <= v.remainingKwh + 1e-6, 'lower bound never over-delivers');
        for (const v of s.vehicles) {
          const slots = [];
          for (let t = v.arrivalSlot; t < v.deadlineSlot; t++) slots.push(t);
          const filled = slots.filter((t) => sched[v.sessionId][t] > 1e-9);
          if (!filled.length) continue;
          const maxFilledPrice = Math.max(...filled.map((t) => s.prices[t]));
          const cheaperEmpty = slots.filter(
            (t) => s.prices[t] < maxFilledPrice - 1e-9 && sched[v.sessionId][t] <= 1e-9
          );
          // A cheaper empty slot may exist only when the rate cap already filled the need
          // earlier: i.e. the vehicle is fully served.
          if (cheaperEmpty.length) {
            assert.ok(
              realityTotal(sched, v) >= v.remainingKwh - 1e-6,
              'cheapest-first: no cheap slot is skipped while the need remains'
            );
          }
        }
      }
    }
  });

  t('offline harness: controller schedule respects the envelope and certifies before scheduling', () => {
    const s = SCENARIO();
    const run = offline.certifyAndSchedule(s, { reserveFraction: 0.1, marginKwh: 2 });
    const dtH = s.dtMin / 60;
    for (let i = 0; i < s.horizon; i++) {
      const total = Object.values(run.schedule).reduce((a, arr) => a + (arr[i] || 0), 0);
      assert.ok(total <= s.siteCapKw * (1 - 0.1) * dtH + 1e-6, `interval ${i} within the reserved cap`);
    }
    assert.ok(run.certs.length === s.vehicles.length, 'every vehicle gets an admission verdict');
    for (const c of run.certs) {
      if (c.admitted)
        assert.ok(
          c.worstCaseKwh + 1e-6 >= c.requiredKwh + c.marginKwh,
          'admission implies the worst case clears need+margin'
        );
      // The flat floor promise may never exceed the connector.
      const v = s.vehicles.find((x) => x.sessionId === c.sessionId);
      assert.ok(c.floorKw <= v.maxKw + 1e-6, 'floor cannot exceed the connector rating');
    }
  });

  t('calibration: float-level gaps are not broken promises; kWh-scale ones are', () => {
    const s = SCENARIO();
    const run = offline.certifyAndSchedule(s, {});
    const ids = run.certs.filter((c) => c.admitted).map((c) => c.sessionId);
    // Perfect delivery: no shortfall.
    const perfect = offline.calibration(s, run.certs, run.schedule, ids);
    assert.equal(perfect.shortfall_vehicles, 0);
    assert.equal(perfect.shortfall_rate, 0);
    // Strip 0.0005 kWh from every vehicle: still within the materiality tolerance.
    const noise = Object.fromEntries(
      Object.entries(run.schedule).map(([sid, arr]) => [sid, arr.map((k) => Math.max(0, k - 0.0005))])
    );
    assert.equal(offline.calibration(s, run.certs, noise, ids).shortfall_vehicles, 0, 'noise is not a failure');
    // Remove a real 2 kWh from each: that IS a broken promise.
    const broken = Object.fromEntries(
      Object.entries(run.schedule).map(([sid, arr]) => {
        const copy = [...arr];
        let left = 2;
        for (let i = copy.length - 1; i >= 0 && left > 0; i--) {
          const take = Math.min(copy[i], left);
          copy[i] -= take;
          left -= take;
        }
        return [sid, copy];
      })
    );
    const bad = offline.calibration(s, run.certs, broken, ids);
    assert.equal(bad.shortfall_vehicles, ids.length, 'material shortfalls are counted');
    assert.ok(bad.max_shortfall_kwh > 0.05, 'and the magnitude is reported');
  });

  t('bootstrap CI: brackets the mean and shrinks with sample size', () => {
    const small = twin.bootstrapCI([1, 2, 3, 4, 5], { seed: 1 });
    const big = twin.bootstrapCI(
      Array.from({ length: 500 }, (_, i) => 1 + (i % 5)),
      { seed: 1 }
    );
    assert.ok(small.lo <= small.mean && small.mean <= small.hi, 'mean inside the interval');
    assert.ok(big.hi - big.lo <= small.hi - small.lo, 'more samples => a tighter interval');
    assert.equal(twin.bootstrapCI([]).mean, null, 'no data => no claim');
  });

  t('model/simulator agreement: the certificate and the twin share one acceptance curve', () => {
    // If these ever diverge, every calibration number is measuring two different physics.
    for (const soc of [0, 0.5, 0.8, 0.85, 0.95, 1]) {
      assert.equal(twin.acceptanceFactor(soc), model.acceptanceFactor(soc), `acceptance at SoC ${soc}`);
    }
  });

  console.log(`\nTwin tests: ${pass} passed`);
  process.exit(0);
}
main().catch((e) => {
  console.error('TWIN-TEST FAIL', e);
  process.exit(1);
});
