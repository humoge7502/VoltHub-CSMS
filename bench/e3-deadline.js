// E3 — Promise-keeping under overload: admission control vs load, at a ladder of
// demand-to-capacity ratios.
// ============================================================================
// PRE-REGISTRATION (ADR-0013 — committed before results; edit = new experiment id)
//
// RESEARCH QUESTION
//   When demand exceeds the site's energy capacity over a day (the normal case for a
//   busy depot, not an edge case), does admitting vehicles against a worst-case
//   certificate keep the CSMS more honest than the industry-default static cap — and
//   does the admission mechanism actually distinguish feasible from infeasible demand?
//
// WHY IT MATTERS
//   Every CSMS can schedule; the failure mode operators actually suffer is a silent
//   deadline miss discovered by the driver. If a controller cannot say "I cannot
//   guarantee this vehicle" BEFORE plug-in, its deadlines are hopes with timestamps.
//
// HYPOTHESES (fixed before the first run)
//   H1 admission responds to load — the controller's refusal rate is non-decreasing in
//      the demand ratio (rho = required energy / site energy capacity). A flat refusal
//      rate means the "certificate" is not measuring feasibility at all.
//   H2 promise-keeping — the certificate calibration shortfall rate stays <= 5% on
//      admitted vehicles at EVERY load level, including rho > 1.
//   H3 deadline advantage — on the population the controller admitted, its promised
//      deadline-miss rate is lower than static-cap's at every load level, with a paired
//      95% bootstrap CI whose upper bound is below zero.
//
// PROTOCOL: 100 seeds per load level, 24-hour horizon at 15-minute intervals, 6 charge
//   points, arrivals ~3.6/h, batteries 30-90 kWh, arrival SoC 15-60%, target 80%.
//   rho is set precisely by capping site power at (total required energy) / (rho * 24h),
//   so rho = 1.2 means the fleet needs 20% more energy than the site can deliver.
//   LOAD LEVELS: rho in {0.6, 0.9, 1.2}.
//
//   TARGET-SoC FAMILY (added deliberately before the run, to make the claim falsifiable):
//   the base config asks for 80% SoC, which is exactly where the CC-CV taper knee sits,
//   so the taper can barely bite and the certificate looks better than it is. The family
//   "target95" asks for 95% SoC — the taper binds by construction — at rho {0.9, 1.2}.
//   A mechanism that only works below the knee is not a mechanism; this family is where
//   H2 is allowed to fail.
// ACCEPTANCE: as above; a failed hypothesis exits 0 and is published as a negative
//   result (ADR-0013). Only an envelope (planned-peak) violation exits non-zero.
// Run: node bench/e3-deadline.js   (writes bench/results/e3-deadline.json)
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

function scenarioAtLoad(seed, rho, targetSoc) {
  // Build the fleet first (the cap does not influence arrivals), then set the site cap
  // so that required energy / capacity equals rho exactly. That makes the ladder a
  // controlled variable instead of a side effect of arrival randomness.
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

function main() {
  const results = {
    experiment: 'e3-deadline',
    preregistration: 'see file header (ADR-0013)',
    args: {
      seeds: SEEDS,
      dt_min: DT_MIN,
      horizon_min: HORIZON_MIN,
      load_levels: LOAD_LEVELS,
      beta_per_kw: BETA,
      // Part of the protocol, not an ambient detail: scenarios are generated at a fixed
      // UTC epoch so this receipt is reproducible from its seeds alone (see twin.js).
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
        const scored = offline.scoreAll(scenario, { betaPerKw: BETA });
        if (scored.strategies.controller.planned_peak_kw > scenario.siteCapKw + 1e-6) {
          hardFail = `ENVELOPE VIOLATED at rho=${rho} seed ${seed}: planned peak ${scored.strategies.controller.planned_peak_kw} > cap ${scenario.siteCapKw}`;
          break;
        }
        rows.push(offline.compactRow({ seed, rho_realized: scenario.params.rho_realized, ...scored }));
      }
      if (hardFail) break;

      const promisedPop = rows.reduce((a, r) => a + r.calibration.promised_population, 0);
      const missRate = (strategy) =>
        +(
          rows.reduce((a, r) => a + r.calibration_by_strategy[strategy].promised_deadline_misses, 0) /
          Math.max(1, promisedPop)
        ).toFixed(4);
      const shortfallRate =
        promisedPop > 0
          ? +(rows.reduce((a, r) => a + r.calibration.shortfall_vehicles, 0) / promisedPop).toFixed(4)
          : 0;
      const admitted = rows.reduce((a, r) => a + r.calibration.admitted, 0);
      const refused = rows.reduce((a, r) => a + r.calibration.refused, 0);
      const mean = (s, f) => twin.bootstrapCI(rows.map((r) => r.strategies[s][f])).mean;
      const deltaMissVsStatic = twin.bootstrapCI(
        rows.map(
          (r) =>
            r.calibration_by_strategy.controller.promised_deadline_miss_rate -
            r.calibration_by_strategy.static_cap.promised_deadline_miss_rate
        )
      );
      const level = {
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
          shortfall_rate: shortfallRate,
          max_shortfall_kwh: +Math.max(0, ...rows.map((r) => r.calibration.max_shortfall_kwh)).toFixed(4),
          promised_kwh: +rows.reduce((a, r) => a + r.calibration.promised_kwh, 0).toFixed(3),
          realized_kwh: +rows.reduce((a, r) => a + r.calibration.realized_kwh, 0).toFixed(3),
        },
        promised_deadline_miss_rate: {
          controller: missRate('controller'),
          static_cap: missRate('static_cap'),
          price_blind_edf: missRate('price_blind_edf'),
          uncontrolled: missRate('uncontrolled'),
        },
        mean: {
          cost_total: {
            controller: mean('controller', 'total_cost_units'),
            static_cap: mean('static_cap', 'total_cost_units'),
            price_blind_edf: mean('price_blind_edf', 'total_cost_units'),
          },
          cost_per_kwh_delivered: {
            controller: mean('controller', 'cost_per_kwh_delivered'),
            static_cap: mean('static_cap', 'cost_per_kwh_delivered'),
            price_blind_edf: mean('price_blind_edf', 'cost_per_kwh_delivered'),
          },
          jain: {
            controller: mean('controller', 'jain_fairness'),
            static_cap: mean('static_cap', 'jain_fairness'),
          },
          realized_unmet_kwh: {
            controller: mean('controller', 'unmet_kwh'),
            static_cap: mean('static_cap', 'unmet_kwh'),
          },
        },
        paired_delta_deadline_miss_vs_static_cap: deltaMissVsStatic,
      };
      level.acceptance = {
        H2_promise_keeping: `${(shortfallRate * 100).toFixed(2)}% shortfall (threshold <= 5%)`,
        H2_pass: shortfallRate <= 0.05,
        H3_deadline_advantage: `paired delta ${deltaMissVsStatic.mean} (95% CI ${deltaMissVsStatic.lo} .. ${deltaMissVsStatic.hi})`,
        H3_pass: deltaMissVsStatic.hi != null && deltaMissVsStatic.hi < 0,
      };
      level.family = family.id;
      level.target_soc = family.targetSoc;
      results.levels[`${family.id}_rho_${rho}`] = { ...level, rows };
    }
  }

  // H1 is a cross-level property within the base family: refusal must respond to load.
  const refusalRates = LOAD_LEVELS.map(
    (rho) => results.levels[`base_target80_rho_${rho}`]?.admission.refusal_rate ?? null
  );
  const nonDecreasing = refusalRates.every(
    (v, i) => i === 0 || v == null || refusalRates[i - 1] == null || v >= refusalRates[i - 1] - 1e-9
  );
  results.cross_level = {
    refusal_rate_by_load: Object.fromEntries(LOAD_LEVELS.map((rho, i) => [`rho_${rho}`, refusalRates[i]])),
    H1_admission_responds_to_load: nonDecreasing,
    H1_pass: nonDecreasing,
  };

  const out = path.join(__dirname, 'results', 'e3-deadline.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
  console.log(`E3 complete — ${out}`);
  for (const key of Object.keys(results.levels)) {
    const L = results.levels[key];
    console.log(`\n[${key}] seeds=${L.seeds} realized rho=${L.rho_realized_mean} usable cap ${L.site_cap_kw_mean} kW`);
    console.log(
      `  admission: ${L.admission.admitted} admitted / ${L.admission.refused} refused (refusal rate ${(L.admission.refusal_rate * 100).toFixed(1)}%)`
    );
    console.log(`  promised-population deadline miss: ${JSON.stringify(L.promised_deadline_miss_rate)}`);
    console.log(`  cost per kWh delivered: ${JSON.stringify(L.mean.cost_per_kwh_delivered)}`);
    console.log(`  fairness (jain): ${JSON.stringify(L.mean.jain)}`);
    console.log(`  max shortfall ${L.calibration.max_shortfall_kwh} kWh`);
    console.log(`  H2 ${L.acceptance.H2_pass ? 'PASS' : 'FAIL'} (${L.acceptance.H2_promise_keeping})`);
    console.log(`  H3 ${L.acceptance.H3_pass ? 'PASS' : 'FAIL'} (${L.acceptance.H3_deadline_advantage})`);
  }
  console.log(
    `\nH1 admission responds to load: ${results.cross_level.H1_pass ? 'PASS' : 'FAIL'} — refusal by load ${JSON.stringify(results.cross_level.refusal_rate_by_load)}`
  );
  if (hardFail) {
    console.error(`\n${hardFail}`);
    process.exitCode = 1;
  }
}
main();
