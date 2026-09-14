// E6 — Acceptance-envelope scheduling (AES, ADR-0015): does making the ALLOCATOR consume
// the same CC-CV acceptance curve as the CERTIFIER remove the promise shortfall above the
// taper knee — without changing anything below it?
// ============================================================================
// PRE-REGISTRATION (ADR-0013 — committed before results; edit = new experiment id)
//
// WHY THIS EXPERIMENT EXISTS
//   E3 published a failure against itself: on the target-95% family (where the CC-CV taper
//   binds by construction) the controller's certificate shortfall rate was 42.6% at rho=0.9
//   and 40.7% at rho=1.2, and it had no deadline advantage over the industry-default
//   static cap. The mechanism, diagnosed from the code rather than inferred from the
//   metric: `certifyVehicle` was taper-aware but `solveSchedule` was not, so the planner
//   allocated nameplate power in every slot. Above the knee that energy is not physically
//   acceptable, so PLAN-time feasibility and REALISED feasibility disagreed — and the
//   disagreement never appeared in any planned metric (planned shortfall was 0).
//
//   E6 tests the repair. It does NOT edit E3: E1b/E3 remain the committed pre-fix record
//   and their receipts stay regenerable from their own scripts (ADR-0013), because the AES
//   behaviour is gated behind an explicit `acceptanceAware` flag, default off.
//
// RESEARCH QUESTION
//   Is power-based allocation, rather than admission control, the binding constraint on
//   promise-keeping above the taper knee — and can a taper-aware allocator fix it without
//   regressing the sub-knee case or buying the fix with cost?
//
// HYPOTHESES (fixed before the first run)
//   H0 NO REGRESSION — below the knee (target 80% SoC, where acceptanceFactor == 1 across
//      the whole window) AES reproduces the power-based allocator exactly: paired per-seed
//      delta in delivered kWh AND total cost is 0.
//   H1 PROMISE KEEPING — on the taper-binding family (target 95%) the certificate shortfall
//      rate falls to <= 5% (E3 measured 42.62% / 40.67%).
//   H2 DEADLINE ADVANTAGE — on the taper family, the paired (AES − static-cap) delta in
//      promised-population deadline-miss rate has a 95% bootstrap CI with upper bound < 0
//      (E3 H3 FAILED here at rho=0.9 with delta +0.0167).
//   H3 COST IS NOT THE PRICE — AES keeps cost/kWh at or below static-cap's at every level,
//      and never exceeds the site cap in any interval (envelope is a safety property, and
//      a violation exits non-zero).
//   H4 PLAN HONESTY — the AES plan's own deliverability claim (absorbable_kwh) matches what
//      physics then delivers, i.e. the plan stops claiming energy the vehicle cannot take.
//
// PROTOCOL: identical to E3 — 100 seeds per level, 24 h horizon at 15-min intervals,
//   6 charge points, arrivals 3.6/h, batteries 30-90 kWh, arrival SoC 15-60%, rho set by
//   capping site power at (total required energy)/(rho*24h). Families: base_target80 at
//   rho {0.6, 0.9, 1.2}; target95_taper_binds at rho {0.9, 1.2}.
// ACCEPTANCE: a failed hypothesis exits 0 and is published as a negative result
//   (ADR-0013). Only an envelope/planned-peak violation exits non-zero.
// Run: node bench/e6-taper.js   (writes bench/results/e6-taper.json)
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const twin = require('../apps/simulator/src/twin');
const offline = require('../apps/simulator/src/offline');

const SEEDS = 100;
const DT_MIN = 15;
const HORIZON_MIN = 24 * 60;
const LOAD_LEVELS = [0.6, 0.9, 1.2];
const BETA = 10;
const SHORTFALL_THRESHOLD = 0.05;

// Same scenario construction as bench/e3-deadline.js, reproduced rather than imported so
// that editing E6 can never silently move E3's protocol (ADR-0013: one script per id).
function scenarioAtLoad(seed, rho, targetSoc) {
  const s = twin.makeScenario({
    seed,
    dtMin: DT_MIN,
    horizonMin: HORIZON_MIN,
    cps: 6,
    siteCapKw: 40,
    arrivalsPerHour: 3.6,
    targetSoc,
  });
  const demandKwh = s.vehicles.reduce((a, v) => a + v.remainingKwh, 0);
  const capacityKwh = demandKwh / rho;
  s.siteCapKw = +(capacityKwh / (HORIZON_MIN / 60)).toFixed(4);
  s.params.siteCapKw = s.siteCapKw;
  s.params.rho_target = rho;
  s.params.rho_realized = +(demandKwh / (s.siteCapKw * (HORIZON_MIN / 60))).toFixed(4);
  return s;
}

// Paired per-seed delta helper: mean + 95% percentile bootstrap CI over per-seed diffs.
const pairedDelta = (rows, fn) => twin.bootstrapCI(rows.map(fn));

function main() {
  const results = {
    experiment: 'e6-taper',
    preregistration: 'see file header (ADR-0013 / ADR-0015)',
    supersedes: 'e3-deadline (target95 family) — e3 remains the committed pre-fix record',
    args: {
      seeds: SEEDS,
      dt_min: DT_MIN,
      horizon_min: HORIZON_MIN,
      load_levels: LOAD_LEVELS,
      beta_per_kw: BETA,
      arms: ['controller (power-based, pre-AES)', 'controller_aes (acceptance-envelope)'],
      scenario_epoch: twin.SCENARIO_EPOCH_ISO,
    },
    levels: {},
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpus: require('os').cpus().length,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timestamp: new Date().toISOString(),
    },
  };
  let hardFail = null;

  const FAMILIES = [
    { id: 'base_target80', targetSoc: 0.8, levels: LOAD_LEVELS },
    { id: 'target95_taper_binds', targetSoc: 0.95, levels: [0.9, 1.2] },
  ];

  for (const family of FAMILIES) {
    for (const rho of family.levels) {
      const rows = [];
      for (let seed = 1; seed <= SEEDS; seed++) {
        const scenario = scenarioAtLoad(seed, rho, family.targetSoc);
        if (!scenario.vehicles.length) continue;
        const scored = offline.scoreAll(scenario, { betaPerKw: BETA, aesArm: true });
        // Safety is not a statistic: BOTH arms must stay inside the realized envelope.
        for (const arm of ['controller', 'controller_aes']) {
          if (scored.strategies[arm].planned_peak_kw > scenario.siteCapKw + 1e-6) {
            hardFail = `ENVELOPE VIOLATED [${arm}] at ${family.id} rho=${rho} seed ${seed}: planned peak ${scored.strategies[arm].planned_peak_kw} > cap ${scenario.siteCapKw}`;
            break;
          }
        }
        if (hardFail) break;
        rows.push(offline.compactRow({ seed, rho_realized: scenario.params.rho_realized, ...scored }));
      }
      if (hardFail) break;

      const promisedPop = rows.reduce((a, r) => a + r.calibration.promised_population, 0);
      const shortfallRate = (arm) =>
        promisedPop > 0
          ? +(rows.reduce((a, r) => a + r.calibration_by_strategy[arm].shortfall_vehicles, 0) / promisedPop).toFixed(4)
          : 0;
      const missRate = (arm) =>
        +(
          rows.reduce((a, r) => a + r.calibration_by_strategy[arm].promised_deadline_misses, 0) /
          Math.max(1, promisedPop)
        ).toFixed(4);
      const mean = (arm, f) => twin.bootstrapCI(rows.map((r) => r.strategies[arm][f])).mean;
      const maxShortfall = (arm) =>
        +Math.max(0, ...rows.map((r) => r.calibration_by_strategy[arm].max_shortfall_kwh)).toFixed(4);

      // H0: AES must reproduce the power-based allocator below the knee.
      const deltaDeliveredBase = pairedDelta(
        rows,
        (r) => r.strategies.controller_aes.delivered_kwh - r.strategies.controller.delivered_kwh
      );
      const deltaCostBase = pairedDelta(
        rows,
        (r) => r.strategies.controller_aes.total_cost_units - r.strategies.controller.total_cost_units
      );
      // H2: deadline advantage vs the industry-default static cap, on the SAME population.
      const deltaMissVsStaticAes = pairedDelta(
        rows,
        (r) =>
          r.calibration_by_strategy.controller_aes.promised_deadline_miss_rate -
          r.calibration_by_strategy.static_cap.promised_deadline_miss_rate
      );
      const deltaMissVsStaticPower = pairedDelta(
        rows,
        (r) =>
          r.calibration_by_strategy.controller.promised_deadline_miss_rate -
          r.calibration_by_strategy.static_cap.promised_deadline_miss_rate
      );
      // H4: plan honesty — the plan's own claim vs what physics delivered.
      const claimGap = (armKey) => {
        const claim = rows.reduce((a, r) => a + (r.plan_honesty[`${armKey}_claim_kwh`] || 0), 0);
        const got = rows.reduce((a, r) => a + (r.plan_honesty[`${armKey}_delivered_kwh`] || 0), 0);
        return { plan_kwh: +claim.toFixed(3), delivered_kwh: +got.toFixed(3), gap_kwh: +(claim - got).toFixed(3) };
      };
      const admitted = rows.reduce((a, r) => a + r.calibration.admitted, 0);
      const refused = rows.reduce((a, r) => a + r.calibration.refused, 0);

      const level = {
        family: family.id,
        target_soc: family.targetSoc,
        seeds: rows.length,
        rho_realized_mean: +(rows.reduce((a, r) => a + r.rho_realized, 0) / Math.max(1, rows.length)).toFixed(4),
        site_cap_kw_mean: +(rows.reduce((a, r) => a + r.usable_cap_kw, 0) / Math.max(1, rows.length)).toFixed(3),
        admission: {
          admitted,
          refused,
          refusal_rate: +(refused / Math.max(1, admitted + refused)).toFixed(4),
        },
        calibration: {
          promised_population: promisedPop,
          shortfall_rate: { controller: shortfallRate('controller'), controller_aes: shortfallRate('controller_aes') },
          max_shortfall_kwh: { controller: maxShortfall('controller'), controller_aes: maxShortfall('controller_aes') },
        },
        promised_deadline_miss_rate: {
          controller: missRate('controller'),
          controller_aes: missRate('controller_aes'),
          static_cap: missRate('static_cap'),
          price_blind_edf: missRate('price_blind_edf'),
        },
        mean: {
          cost_total: {
            controller: mean('controller', 'total_cost_units'),
            controller_aes: mean('controller_aes', 'total_cost_units'),
            static_cap: mean('static_cap', 'total_cost_units'),
          },
          cost_per_kwh_delivered: {
            controller: mean('controller', 'cost_per_kwh_delivered'),
            controller_aes: mean('controller_aes', 'cost_per_kwh_delivered'),
            static_cap: mean('static_cap', 'cost_per_kwh_delivered'),
          },
          delivered_kwh: {
            controller: mean('controller', 'delivered_kwh'),
            controller_aes: mean('controller_aes', 'delivered_kwh'),
          },
          peak_kw: {
            controller: mean('controller', 'peak_kw'),
            controller_aes: mean('controller_aes', 'peak_kw'),
          },
          jain: {
            controller: mean('controller', 'jain_fairness'),
            controller_aes: mean('controller_aes', 'jain_fairness'),
            static_cap: mean('static_cap', 'jain_fairness'),
          },
        },
        plan_honesty: { aes: claimGap('aes'), power_based: claimGap('power') },
        paired_delta: {
          aes_minus_power_delivered_kwh: deltaDeliveredBase,
          aes_minus_power_total_cost: deltaCostBase,
          aes_minus_static_deadline_miss_rate: deltaMissVsStaticAes,
          power_minus_static_deadline_miss_rate: deltaMissVsStaticPower,
        },
      };

      // Numeric tolerance, fixed in advance: schedules are rounded to 1e-4 kWh for
      // publication, so exact float equality is not the right assertion.
      const baseNoRegression = Math.abs(deltaDeliveredBase.mean) <= 1e-3 && Math.abs(deltaCostBase.mean) <= 1e-2;
      level.acceptance = {
        H0_no_regression: baseNoRegression
          ? `PASS — AES reproduces power-based below the knee (Δdelivered ${deltaDeliveredBase.mean}, Δcost ${deltaCostBase.mean})`
          : `n/a (base family only) or FAIL — Δdelivered ${deltaDeliveredBase.mean}, Δcost ${deltaCostBase.mean}`,
        H0_pass: family.id === 'base_target80' ? baseNoRegression : null,
        H1_promise_keeping: `${(shortfallRate('controller_aes') * 100).toFixed(2)}% shortfall (was ${(shortfallRate('controller') * 100).toFixed(2)}%; threshold <= 5%)`,
        H1_pass: shortfallRate('controller_aes') <= SHORTFALL_THRESHOLD,
        H2_deadline_advantage: `AES vs static-cap paired delta ${deltaMissVsStaticAes.mean} (95% CI ${deltaMissVsStaticAes.lo} .. ${deltaMissVsStaticAes.hi})`,
        H2_pass: deltaMissVsStaticAes.hi != null && deltaMissVsStaticAes.hi < 0,
        H3_cost_not_the_price: `AES cost/kWh ${level.mean.cost_per_kwh_delivered.controller_aes} vs static-cap ${level.mean.cost_per_kwh_delivered.static_cap}`,
        H3_pass: level.mean.cost_per_kwh_delivered.controller_aes <= level.mean.cost_per_kwh_delivered.static_cap,
        H4_plan_honesty: `AES plan ${level.plan_honesty.aes.plan_kwh} kWh vs delivered ${level.plan_honesty.aes.delivered_kwh} kWh (gap ${level.plan_honesty.aes.gap_kwh})`,
      };
      results.levels[`${family.id}_rho_${rho}`] = { ...level, rows };
    }
  }

  const out = path.join(__dirname, 'results', 'e6-taper.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
  console.log(`E6 complete — ${out}`);
  for (const key of Object.keys(results.levels)) {
    const L = results.levels[key];
    console.log(`\n[${key}] seeds=${L.seeds} realized rho=${L.rho_realized_mean} usable cap ${L.site_cap_kw_mean} kW`);
    console.log(
      `  shortfall: power-based ${(L.calibration.shortfall_rate.controller * 100).toFixed(2)}% -> AES ${(L.calibration.shortfall_rate.controller_aes * 100).toFixed(2)}%`
    );
    console.log(
      `  max shortfall kWh: power-based ${L.calibration.max_shortfall_kwh.controller} -> AES ${L.calibration.max_shortfall_kwh.controller_aes}`
    );
    console.log(`  promised-population deadline miss: ${JSON.stringify(L.promised_deadline_miss_rate)}`);
    console.log(`  cost per kWh delivered: ${JSON.stringify(L.mean.cost_per_kwh_delivered)}`);
    console.log(`  plan honesty (AES): ${JSON.stringify(L.plan_honesty.aes)}`);
    console.log(`  H1 ${L.acceptance.H1_pass ? 'PASS' : 'FAIL'} (${L.acceptance.H1_promise_keeping})`);
    console.log(`  H2 ${L.acceptance.H2_pass ? 'PASS' : 'FAIL'} (${L.acceptance.H2_deadline_advantage})`);
    console.log(`  H3 ${L.acceptance.H3_pass ? 'PASS' : 'FAIL'} (${L.acceptance.H3_cost_not_the_price})`);
    if (L.acceptance.H0_pass != null) {
      console.log(`  H0 ${L.acceptance.H0_pass ? 'PASS' : 'FAIL'} (${L.acceptance.H0_no_regression})`);
    }
  }
  if (hardFail) {
    console.error(`\n${hardFail}`);
    process.exitCode = 1;
  }
}
main();
