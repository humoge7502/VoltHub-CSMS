// E1b — Cost, peak and certificate calibration: the SHIPPED solver vs baselines.
// ============================================================================
// PRE-REGISTRATION (ADR-0013 — committed before results; edit = new experiment id)
//
// Why a new id (e1b) instead of editing e1: e1 measured a solver implemented *inside*
// the bench script, not the one that ships. Two things change here, both material to a
// cost claim, so the old receipt stands as history and this one supersedes it:
//   1. the schedule under test is imported from apps/api/src/control/model.solveSchedule
//      (single source of truth: the benchmark measures the code that runs);
//   2. arrivals, deadlines, battery state, CC-CV acceptance and ToU prices come from the
//      deterministic twin (apps/simulator/src/twin.js), so the workload is generated
//      rather than hand-picked and every number is reproducible from its seed.
//
// HYPOTHESES (fixed before the first run)
//   H1 total cost   — total_cost = energy_cost + BETA*peak_kw (BETA = 10 $/kW, stated
//      assumption: mid-market CPO demand charge). Controller <= static-cap AND
//      <= price-blind EDF on >= 70% of seeds (paired: same seed => same fleet).
//   H2 fairness     — the cost win is not bought by starving anyone:
//      jain(controller) >= 0.90 * jain(static-cap) on >= 70% of seeds.
//   H3 envelope     — the schedule the CSMS COMMANDS never exceeds the site cap on any
//      seed (hard abort: safety is not a statistic).
//   H4 calibration  — of the vehicles the controller ADMITTED, at most 5% may end up
//      under-delivering the promised floor energy once real physics (CC-CV taper,
//      non-compliant chargers) is applied. This is the claim that makes the mechanism
//      research rather than engineering.
//
// ARMS (pre-registered ablations, reported separately — never merged)
//   A. compliant fleet      non_compliant_fraction = 0.00
//   B. adversarial fleet    non_compliant_fraction = 0.25  (chargers ignore the profile)
//
// STRATEGIES under identical physics (twin.applyActuatorReality applied to every one)
//   controller      — shipped model.solveSchedule + certifyVehicle admission
//   static_cap      — equal split of the site cap among active vehicles (industry default)
//   price_blind_edf — same feasibility discipline, no tariff awareness (the ablation:
//                     the delta vs it is attributable to pricing)
//   uncontrolled    — no cap at all (demand-charge argument, NOT a fair cost comparator)
//   cost_lower_bound— site cap relaxed away; a valid lower bound on ENERGY cost only
//
// PROTOCOL: 200 seeds, 24-hour horizon at 15-minute intervals, 6 charge points,
//   40 kW site cap, arrivals ~3.6/h, batteries 30-90 kWh, arrival SoC 15-60%,
//   target 80%, dwell 45 min - 8 h.
// ACCEPTANCE: H1/H2/H4 as above; H3 as a hard abort. NOTE the deliberate asymmetry:
//   a failed HYPOTHESIS exits 0 and is published as a negative result (ADR-0013);
//   only an H3 safety violation exits non-zero.
// Run: node bench/e1b-cost.js   (writes bench/results/e1b-cost.json)
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const twin = require('../apps/simulator/src/twin');
const offline = require('../apps/simulator/src/offline');

const SEEDS = 200;
const DT_MIN = 15;
const HORIZON_MIN = 24 * 60;
const CPS = 6;
const SITE_CAP_KW = 40;
const BETA = 10; // $/kW of window peak — stated assumption, not a measured price
const ARMS = [
  { id: 'A_compliant', nonCompliantFraction: 0 },
  { id: 'B_adversarial', nonCompliantFraction: 0.25 },
];

function makeScenario(seed, nonCompliantFraction) {
  return twin.makeScenario({
    seed,
    dtMin: DT_MIN,
    horizonMin: HORIZON_MIN,
    cps: CPS,
    siteCapKw: SITE_CAP_KW,
    arrivalsPerHour: 3.6,
    nonCompliantFraction,
  });
}

function main() {
  const results = {
    experiment: 'e1b-cost/e2b-peak/e4-calibration',
    preregistration: 'see file header (ADR-0013)',
    args: {
      seeds: SEEDS,
      dt_min: DT_MIN,
      horizon_min: HORIZON_MIN,
      cps: CPS,
      site_cap_kw: SITE_CAP_KW,
      beta_per_kw: BETA,
      // The scenario anchor is part of the protocol, not an ambient detail: scenarios are
      // generated at a fixed UTC epoch so this receipt is reproducible from its seeds
      // alone (see twin.js header). Without it the same command returns different
      // numbers minutes apart, and a different number again in another timezone.
      scenario_epoch: twin.SCENARIO_EPOCH_ISO,
    },
    arms: {},
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpus: require('os').cpus().length,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timestamp: new Date().toISOString(),
    },
  };
  let hardFail = null;

  for (const arm of ARMS) {
    const rows = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const scenario = makeScenario(seed, arm.nonCompliantFraction);
      if (!scenario.vehicles.length) continue;
      const scored = offline.scoreAll(scenario, { betaPerKw: BETA });
      // H3 — hard safety property, checked on the schedule the CSMS commands.
      if (scored.strategies.controller.planned_peak_kw > scenario.siteCapKw + 1e-6) {
        hardFail = `H3 VIOLATED on ${arm.id} seed ${seed}: planned peak ${scored.strategies.controller.planned_peak_kw} kW > cap ${scenario.siteCapKw}`;
        break;
      }
      rows.push(
        offline.compactRow({
          seed,
          demand_ratio: scenario.params.demandRatio,
          vehicles: scenario.vehicles.length,
          ...scored,
        })
      );
    }
    if (hardFail) break;

    const col = (s, f) => rows.map((r) => r.strategies[s][f]);
    const winsVs = (other) =>
      rows.filter((r) => r.strategies.controller.total_cost_units <= r.strategies[other].total_cost_units).length;
    const winsVsStatic = winsVs('static_cap');
    const winsVsEdf = winsVs('price_blind_edf');
    const fairnessOk = rows.filter(
      (r) => r.strategies.controller.jain_fairness >= 0.9 * r.strategies.static_cap.jain_fairness
    ).length;
    const admitted = rows.reduce((a, r) => a + r.calibration.admitted, 0);
    const refused = rows.reduce((a, r) => a + r.calibration.refused, 0);
    const promisedPopulation = rows.reduce((a, r) => a + r.calibration.promised_population, 0);
    const shortfalls = rows.reduce((a, r) => a + r.calibration.shortfall_vehicles, 0);
    const shortfallRate = promisedPopulation ? shortfalls / promisedPopulation : 0;

    const summary = {
      seeds: rows.length,
      mean: {},
      ci95: {},
      energy_cost_lower_bound_units: twin.bootstrapCI(rows.map((r) => r.cost_lower_bound_energy_units)).mean,
      acceptance: {
        H1_cost_le_static: `${winsVsStatic}/${rows.length} seeds (threshold >= ${Math.ceil(rows.length * 0.7)})`,
        H1_cost_le_price_blind_edf: `${winsVsEdf}/${rows.length} seeds (threshold >= ${Math.ceil(rows.length * 0.7)})`,
        H2_fairness_held: `${fairnessOk}/${rows.length} seeds (threshold >= ${Math.ceil(rows.length * 0.7)})`,
        H4_calibration_shortfall_rate: `${(shortfallRate * 100).toFixed(2)}% of ${promisedPopulation} promised vehicles (threshold <= 5%)`,
      },
      calibration_totals: {
        admitted_certificates: admitted,
        refused_certificates: refused,
        refusal_rate: +(refused / Math.max(1, admitted + refused)).toFixed(4),
        promised_population: promisedPopulation,
        promised_kwh: +rows.reduce((a, r) => a + r.calibration.promised_kwh, 0).toFixed(3),
        realized_kwh: +rows.reduce((a, r) => a + r.calibration.realized_kwh, 0).toFixed(3),
        shortfall_kwh: +rows.reduce((a, r) => a + r.calibration.shortfall_kwh, 0).toFixed(3),
        // Deadline misses measured on the population the CONTROLLER PROMISED to serve,
        // computed for every strategy so the comparison is like-for-like.
        promised_deadline_miss_rate: Object.fromEntries(
          Object.keys(rows[0].strategies).map((s) => [
            s,
            +(
              rows.reduce((a, r) => a + r.calibration_by_strategy[s].promised_deadline_misses, 0) /
              Math.max(1, promisedPopulation)
            ).toFixed(4),
          ])
        ),
      },
    };
    summary.acceptance.H1_pass =
      winsVsStatic >= Math.ceil(rows.length * 0.7) && winsVsEdf >= Math.ceil(rows.length * 0.7);
    summary.acceptance.H2_pass = fairnessOk >= Math.ceil(rows.length * 0.7);
    summary.acceptance.H4_pass = shortfallRate <= 0.05;

    for (const s of Object.keys(rows[0].strategies)) {
      const first = rows[0].strategies[s];
      summary.mean[s] = {};
      summary.ci95[s] = {};
      for (const f of Object.keys(first)) {
        if (typeof first[f] !== 'number') continue;
        const ci = twin.bootstrapCI(col(s, f));
        summary.mean[s][f] = ci.mean;
        summary.ci95[s][f] = ci;
      }
    }
    // Paired deltas are the honest unit: same seeds, same fleets, no independence assumed.
    summary.paired_delta_vs_static_cap = {
      total_cost_units: twin.bootstrapCI(
        rows.map((r) => r.strategies.controller.total_cost_units - r.strategies.static_cap.total_cost_units)
      ),
      promised_deadline_miss_rate: twin.bootstrapCI(
        rows.map(
          (r) =>
            r.calibration_by_strategy.controller.promised_deadline_miss_rate -
            r.calibration_by_strategy.static_cap.promised_deadline_miss_rate
        )
      ),
      jain_fairness: twin.bootstrapCI(
        rows.map((r) => r.strategies.controller.jain_fairness - r.strategies.static_cap.jain_fairness)
      ),
    };
    summary.paired_delta_vs_price_blind_edf = {
      total_cost_units: twin.bootstrapCI(
        rows.map((r) => r.strategies.controller.total_cost_units - r.strategies.price_blind_edf.total_cost_units)
      ),
      energy_cost_units: twin.bootstrapCI(
        rows.map((r) => r.strategies.controller.energy_cost_units - r.strategies.price_blind_edf.energy_cost_units)
      ),
      cost_per_kwh_delivered: twin.bootstrapCI(
        rows.map(
          (r) => r.strategies.controller.cost_per_kwh_delivered - r.strategies.price_blind_edf.cost_per_kwh_delivered
        )
      ),
    };
    results.arms[arm.id] = { ...summary, rows };
  }

  const out = path.join(__dirname, 'results', 'e1b-cost.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
  console.log(`E1b complete — ${out}`);
  for (const [id, arm] of Object.entries(results.arms)) {
    console.log(`\n[${id}] seeds=${arm.seeds}`);
    console.log(
      `  cost (mean): controller ${arm.mean.controller.total_cost_units} | static-cap ${arm.mean.static_cap.total_cost_units} | EDF ${arm.mean.price_blind_edf.total_cost_units} | uncontrolled ${arm.mean.uncontrolled.total_cost_units}`
    );
    console.log(
      `  peak (mean): controller ${arm.mean.controller.peak_kw} | static-cap ${arm.mean.static_cap.peak_kw} | EDF ${arm.mean.price_blind_edf.peak_kw} | uncontrolled ${arm.mean.uncontrolled.peak_kw}`
    );
    console.log(
      `  fairness (jain): controller ${arm.mean.controller.jain_fairness} | static-cap ${arm.mean.static_cap.jain_fairness}`
    );
    console.log(
      `  H1 ${arm.acceptance.H1_pass ? 'PASS' : 'FAIL'} · H2 ${arm.acceptance.H2_pass ? 'PASS' : 'FAIL'} · H4 ${arm.acceptance.H4_pass ? 'PASS' : 'FAIL'}`
    );
    console.log(
      `  H1 vs static ${arm.acceptance.H1_cost_le_static}; vs EDF ${arm.acceptance.H1_cost_le_price_blind_edf}`
    );
    console.log(`  H4 ${arm.acceptance.H4_calibration_shortfall_rate}`);
    console.log(
      `  promised-population deadline miss: ${JSON.stringify(arm.calibration_totals.promised_deadline_miss_rate)}`
    );
    console.log(
      `  admitted ${arm.calibration_totals.admitted_certificates} / refused ${arm.calibration_totals.refused_certificates} (refusal rate ${(arm.calibration_totals.refusal_rate * 100).toFixed(1)}%)`
    );
    console.log(
      `  realized peak over cap by rogue chargers: controller ${arm.mean.controller.realized_peak_over_cap_kw} kW | static-cap ${arm.mean.static_cap.realized_peak_over_cap_kw} kW`
    );
    console.log(
      `  delta vs static-cap (paired, 95% CI): total_cost ${JSON.stringify(arm.paired_delta_vs_static_cap.total_cost_units)}`
    );
  }
  if (hardFail) {
    console.error(`\n${hardFail}`);
    process.exitCode = 1;
  }
}
main();
