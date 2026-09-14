// Deterministic generative twin (ADR-0012 §"Consequences" Phase 6 / blueprint M).
//
// The scripted fleet in index.js replays fixed OCPP flows; it is the right tool for
// protocol conformance and the wrong tool for experiments, because a controller
// validated against obedient, hand-scripted chargers proves nothing. This module
// generates the honest workload instead:
//
//   * arrivals       — inhomogeneous Poisson over the horizon (morning/late peaks)
//   * battery state  — battery size, arrival SoC, target SoC => a real energy need
//   * dwell/deadline — plug-in to departure, so deadlines bind and can be missed
//   * acceptance     — a CC-CV taper, so 22 kW is not deliverable at 95% SoC
//   * prices         — ToU bands over the day, so cheap/expensive is real
//   * compliance     — a fraction of vehicles that ignores the schedule entirely
//
// Pure and deterministic: the same seed yields the same scenario, byte for byte, which
// is what makes paired comparisons across strategies legitimate (ADR-0013).
//
// Two things are needed for that sentence to be true, and both bit us in practice:
//   1. a FIXED epoch (SCENARIO_EPOCH). Defaulting to `Date.now()` meant the horizon slid
//      with the wall clock, so the same command produced different receipts minutes
//      apart — the ToU bands and commute peaks the horizon covered had moved.
//   2. diurnal quantities in UTC (`getUTCHours`). `getHours()` made the scenario depend on
//      the runner's timezone, so CI (UTC) and a laptop (UTC+5:30) disagreed.
// A receipt you cannot regenerate is not evidence, so the default anchor is now a stated
// constant and only an explicit `now` opts back into wall-clock behaviour.
'use strict';

// The experiment anchor: Monday 2026-03-02 00:00 UTC. A 24-hour horizon from midnight
// covers every ToU band and both commute peaks exactly once — stated here because the
// pre-registration depends on it (ADR-0013).
const SCENARIO_EPOCH_ISO = '2026-03-02T00:00:00.000Z';
const SCENARIO_EPOCH = Date.parse(SCENARIO_EPOCH_ISO);

// The acceptance curve is imported from the certificate implementation rather than
// duplicated: the promise (apps/api/src/control/model.js) and the experiment that holds
// it to account must not be able to disagree about physics.
const { acceptanceFactor } = require('../../api/src/control/model');

// mulberry32 — small, fast, well-distributed; the same PRNG the bench suite uses so
// one seed stream drives every experiment.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ToU price for the interval starting at `tMs`: peak 17:00-22:00, off-peak 23:00-06:00,
// shoulder otherwise — the shape that makes arbitrage worth doing and demand charges
// worth shaving.
function touPrice(tMs, { peak = 0.55, shoulder = 0.32, offpeak = 0.16 } = {}) {
  const h = new Date(tMs).getUTCHours();
  if (h >= 23 || h < 6) return offpeak;
  if (h >= 17 && h < 22) return peak;
  return shoulder;
}

// Inhomogeneous arrival rate multiplier over a day: two commute peaks. UTC, so the
// scenario is identical on every runner (see the header note).
function arrivalIntensity(tMs) {
  const d = new Date(tMs);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const gauss = (mu, sigma) => Math.exp(-((h - mu) ** 2) / (2 * sigma * sigma));
  return 0.35 + 1.6 * gauss(9, 2.2) + 1.3 * gauss(18, 2.6);
}

function pick(rng, lo, hi) {
  return lo + rng() * (hi - lo);
}

// makeScenario — the single entry point benches and the CLI share.
// Returns the exact vehicle shape apps/api/src/control/model.solveSchedule consumes
// (sessionId/cpId/maxKw/remainingKwh/arrivalAt/deadlineAt) plus the provenance a
// receipt needs (params + seed) so any table in a paper can be regenerated.
function makeScenario(opts = {}) {
  const seed = Number(opts.seed || 1);
  const rng = mulberry32(seed);
  const dtMin = Number(opts.dtMin || 15);
  const horizonMin = Number(opts.horizonMin || 24 * 60);
  const horizon = Math.ceil(horizonMin / dtMin);
  const cps = Math.max(1, Number(opts.cps || 4));
  const siteCapKw = opts.siteCapKw == null ? cps * 22 : Number(opts.siteCapKw);
  // Fixed by default: a scenario must be reproducible from its seed alone.
  const now = opts.now == null ? SCENARIO_EPOCH : Number(opts.now);
  const gridStart = Math.floor(now / (dtMin * 60000)) * (dtMin * 60000);
  const dtMs = dtMin * 60000;
  const maxKw = Number(opts.maxKw || 22);
  const batteryMin = Number(opts.batteryKwhMin || 30);
  const batteryMax = Number(opts.batteryKwhMax || 90);
  const socMin = Number(opts.arrivalSocMin || 0.15);
  const socMax = Number(opts.arrivalSocMax || 0.6);
  const targetSoc = Number(opts.targetSoc || 0.8);
  const dwellMinMin = Number(opts.dwellMinMin || 45);
  const dwellMaxMin = Number(opts.dwellMaxMin || 8 * 60);
  const ratePerHour = Number(opts.arrivalsPerHour == null ? cps * 0.6 : opts.arrivalsPerHour);
  const nonCompliantFraction = Number(opts.nonCompliantFraction || 0);
  const vehicleCount = Number(opts.vehicles == null ? cps * 6 : opts.vehicles);

  const prices = [];
  for (let i = 0; i < horizon; i++) prices.push(+touPrice(gridStart + i * dtMs).toFixed(4));

  // Arrivals: thinning-free per-interval Bernoulli with the diurnal intensity, then
  // sorted by time. Deterministic because it consumes one rng stream in order.
  const arrivals = [];
  for (let i = 0; i < horizon; i++) {
    const tMs = gridStart + i * dtMs;
    const lambda = ratePerHour * (dtMin / 60) * arrivalIntensity(tMs) * 0.5;
    if (rng() < Math.min(0.95, lambda)) arrivals.push(i);
  }
  while (arrivals.length < 2) arrivals.push(Math.floor(rng() * horizon)); // degenerate seeds still produce a fleet
  arrivals.sort((a, b) => a - b);

  const vehicles = [];
  for (let k = 0; k < Math.min(vehicleCount, arrivals.length); k++) {
    const arrivalSlot = arrivals[k];
    const batteryKwh = +pick(rng, batteryMin, batteryMax).toFixed(2);
    const startSoc = +pick(rng, socMin, socMax).toFixed(3);
    const dwellSlots = Math.max(1, Math.round(pick(rng, dwellMinMin, dwellMaxMin) / dtMin));
    const deadlineSlot = Math.min(horizon, arrivalSlot + dwellSlots);
    const remainingKwh = +Math.max(0, batteryKwh * (targetSoc - startSoc)).toFixed(3);
    if (remainingKwh <= 1e-6) continue; // nothing to do; not a charging event
    const nonCompliant = rng() < nonCompliantFraction;
    vehicles.push({
      sessionId: 1000 + k,
      // Every vehicle gets its own charge point: one session per connector is the
      // physical reality the fleet mode already enforces.
      cpId: k + 1,
      connectorNo: 1,
      maxKw,
      batteryKwh,
      startSoc,
      targetSoc,
      remainingKwh,
      arrivalAt: gridStart + arrivalSlot * dtMs,
      deadlineAt: gridStart + deadlineSlot * dtMs,
      deadlineSlot,
      arrivalSlot,
      nonCompliant,
      certifiedFloorKw: 0,
    });
  }

  return {
    seed,
    dtMin,
    horizon,
    cps: Math.max(cps, vehicles.length),
    siteCapKw,
    gridStart,
    gridStartIso: new Date(gridStart).toISOString(),
    prices,
    vehicles,
    params: {
      seed,
      dtMin,
      horizonMin,
      cps,
      siteCapKw,
      arrivalsPerHour: ratePerHour,
      batteryKwhMin: batteryMin,
      batteryKwhMax: batteryMax,
      arrivalSocMin: socMin,
      arrivalSocMax: socMax,
      targetSoc,
      dwellMinMin,
      dwellMaxMin,
      nonCompliantFraction,
      demandRatio: +(vehicles.reduce((a, v) => a + v.remainingKwh, 0) / (siteCapKw * (horizonMin / 60))).toFixed(4),
    },
  };
}

// expandToVehicles — a schedule keyed by sessionId -> kWh[] collapsed into per-vehicle
// delivered energy. Shared by every evaluator so baselines and the controller are
// scored by identical arithmetic.
function deliveredByVehicle(scenario, schedule) {
  const out = new Map();
  for (const v of scenario.vehicles) {
    const arr = schedule[v.sessionId] || [];
    out.set(v.sessionId, +arr.reduce((a, b) => a + (Number(b) || 0), 0).toFixed(4));
  }
  return out;
}

// applyActuatorReality — the step that makes claims falsifiable. Scheduled energy is
// what the CSMS *asked* for; delivered energy is what physics and the charger did:
//   compliant        — min(scheduled, CC-CV acceptance at the reached SoC)
//   non-compliant    — the schedule is ignored; the vehicle draws naturally in its
//                      window (the adversarial case ADR-0012 requires the verifier
//                      to detect and the controller to survive)
function applyActuatorReality(scenario, schedule) {
  const out = {};
  for (const v of scenario.vehicles) {
    const dtH = scenario.dtMin / 60;
    const scheduled = schedule[v.sessionId] || [];
    let soc = v.startSoc;
    const arr = [];
    for (let t = 0; t < scenario.horizon; t++) {
      const ask = Number(scheduled[t]) || 0;
      const acceptanceKw = v.maxKw * acceptanceFactor(soc);
      let kwh;
      if (v.nonCompliant) {
        // Ignores the profile: draws its natural rate whenever it is plugged in.
        const inWindow = t >= v.arrivalSlot && t < v.deadlineSlot;
        kwh = inWindow ? acceptanceKw * dtH : 0;
      } else {
        kwh = Math.min(ask, acceptanceKw * dtH);
      }
      // Can never exceed the vehicle's own need.
      kwh = Math.max(0, Math.min(kwh, v.batteryKwh * (1 - soc)));
      arr.push(+kwh.toFixed(4));
      soc += kwh / v.batteryKwh;
    }
    out[v.sessionId] = arr;
  }
  return { schedule: out, deliveredByVehicle: deliveredByVehicle(scenario, out) };
}

// evaluate — one metric dictionary for every strategy, so no comparison can quietly
// change its own scoring rules (the failure mode ADR-0013 exists to prevent).
function evaluate(scenario, schedule, opts = {}) {
  const beta = Number(opts.betaPerKw == null ? 10 : opts.betaPerKw);
  const dts = scenario.dtMin / 60;
  const delivered = deliveredByVehicle(scenario, schedule);
  let energyCost = 0;
  let peak = 0;
  const perSlot = [];
  for (let t = 0; t < scenario.horizon; t++) {
    let kwh = 0;
    for (const v of scenario.vehicles) kwh += Number(schedule[v.sessionId]?.[t]) || 0;
    perSlot.push(kwh);
    energyCost += (scenario.prices[t] ?? 0) * kwh;
    peak = Math.max(peak, kwh / dts);
  }
  let unmet = 0;
  let missed = 0;
  const ratios = [];
  for (const v of scenario.vehicles) {
    const got = delivered.get(v.sessionId) || 0;
    unmet += Math.max(0, v.remainingKwh - got);
    // Deadline miss: the guarantee is "charged by departure", not "charged eventually".
    const byDeadline = (schedule[v.sessionId] || []).slice(0, v.deadlineSlot).reduce((a, b) => a + (Number(b) || 0), 0);
    if (byDeadline + 1e-6 < v.remainingKwh) missed++;
    ratios.push(Math.min(1, got / Math.max(v.remainingKwh, 1e-9)));
  }
  const s = ratios.reduce((a, b) => a + b, 0);
  const sq = ratios.reduce((a, b) => a + b * b, 0);
  const jain = ratios.length && sq > 1e-12 ? +((s * s) / (ratios.length * sq)).toFixed(4) : 1;
  const demandCharge = beta * peak;
  return {
    energy_cost_units: +energyCost.toFixed(4),
    peak_kw: +peak.toFixed(3),
    demand_charge_units: +demandCharge.toFixed(4),
    total_cost_units: +(energyCost + demandCharge).toFixed(4),
    delivered_kwh: +[...delivered.values()].reduce((a, b) => a + b, 0).toFixed(4),
    unmet_kwh: +unmet.toFixed(4),
    deadline_misses: missed,
    deadline_miss_rate: scenario.vehicles.length ? +(missed / scenario.vehicles.length).toFixed(4) : 0,
    jain_fairness: jain,
    per_slot_kwh: perSlot.map((x) => +x.toFixed(4)),
  };
}

// bootstrapCI — percentile bootstrap over per-seed values. Reported instead of a bare
// mean so a 0.6% difference cannot be presented as a result without its interval.
function bootstrapCI(values, { iters = 2000, alpha = 0.05, seed = 12345 } = {}) {
  const xs = values.filter((v) => Number.isFinite(v));
  if (!xs.length) return { mean: null, lo: null, hi: null, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (xs.length === 1) return { mean: +mean.toFixed(4), lo: null, hi: null, n: 1 };
  const rng = mulberry32(seed);
  const means = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < xs.length; j++) s += xs[Math.floor(rng() * xs.length)];
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  const at = (q) => means[Math.min(means.length - 1, Math.max(0, Math.floor(q * means.length)))];
  return {
    mean: +mean.toFixed(4),
    lo: +at(alpha / 2).toFixed(4),
    hi: +at(1 - alpha / 2).toFixed(4),
    n: xs.length,
  };
}

module.exports = {
  SCENARIO_EPOCH,
  SCENARIO_EPOCH_ISO,
  mulberry32,
  acceptanceFactor, // re-exported so consumers have one import path
  touPrice,
  arrivalIntensity,
  makeScenario,
  deliveredByVehicle,
  applyActuatorReality,
  evaluate,
  bootstrapCI,
};
