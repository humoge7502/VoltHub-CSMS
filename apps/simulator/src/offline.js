// Offline experiment harness: one place that turns a twin scenario into the numbers
// every benchmark reports.
//
// Both benches (e1b, e3) must score the controller and the baselines with identical
// arithmetic, or the comparison is not a comparison. This module owns:
//   * the admission + schedule sequence the plan cycle runs (certify, then solve),
//   * actuator reality (CC-CV taper + non-compliant chargers) applied to every strategy,
//   * certificate calibration measured on the population the controller PROMISED to serve,
//   * per-strategy scoring on the same population (strategy-specific populations are
//     how benchmarks accidentally lie).
'use strict';
const model = require('../../api/src/control/model');
const twin = require('./twin');
const baselines = require('./baselines');

const DEFAULT_RESERVE = 0.1; // mirrors FCHCC_RESERVE (controller default)
const DEFAULT_MARGIN_KWH = 2; // mirrors FCHCC_MARGIN_KWH

// Admission + schedule, exactly as the production plan cycle orders them.
// Contention for a candidate is the sum of floors granted to vehicles whose charging
// windows OVERLAP it — a vehicle that departs before another arrives cannot constrain it.
function certifyAndSchedule(scenario, opts = {}) {
  const reserve = opts.reserveFraction == null ? DEFAULT_RESERVE : opts.reserveFraction;
  const marginKwh = opts.marginKwh == null ? DEFAULT_MARGIN_KWH : opts.marginKwh;
  // ADR-0015: false = the pre-AES power-based allocator (what the committed E1b/E3
  // receipts measured), true = acceptance-envelope scheduling (what the controller
  // ships). The experiment carries BOTH so the difference is attributable.
  const acceptanceAware = !!opts.acceptanceAware;
  const usableCapKw = scenario.siteCapKw * (1 - reserve);
  const order = [...scenario.vehicles].sort((a, b) => a.sessionId - b.sessionId);
  const certs = [];
  const floors = new Map();
  for (const v of order) {
    let overlappingFloorKw = 0;
    for (const o of order) {
      if (o === v) continue;
      const f = floors.get(o.sessionId) || 0;
      if (f <= 0) continue;
      if (o.arrivalSlot < v.deadlineSlot && o.deadlineSlot > v.arrivalSlot) overlappingFloorKw += f;
    }
    const verdict = model.certifyVehicle({
      vehicle: v,
      siteCapKw: usableCapKw,
      certifiedFloorKw: overlappingFloorKw,
      now: scenario.gridStart,
      deadlineAt: v.deadlineAt,
      marginKwh,
    });
    floors.set(v.sessionId, verdict.admitted ? verdict.floorKw : 0);
    certs.push({
      sessionId: v.sessionId,
      ...verdict,
      deadlineSlot: v.deadlineSlot,
      arrivalSlot: v.arrivalSlot,
      remainingKwh: v.remainingKwh,
    });
  }
  const cpCaps = new Map();
  for (const v of scenario.vehicles) cpCaps.set(v.cpId, v.maxKw);
  const solved = model.solveSchedule({
    vehicles: scenario.vehicles.map((v) => ({ ...v, certifiedFloorKw: floors.get(v.sessionId) || 0 })),
    siteCapKw: usableCapKw,
    cpCaps,
    priceSeries: () => scenario.prices,
    dtMin: scenario.dtMin,
    horizon: scenario.horizon,
    now: scenario.gridStart,
    acceptanceAware,
  });
  return { schedule: solved.schedule, metrics: solved.metrics, certs, usableCapKw };
}

// Certificate calibration over the admitted set, scored on an arbitrary realized
// schedule so any strategy can be judged against the same promises.
function calibration(scenario, certs, realizedSchedule, ids) {
  const dtH = scenario.dtMin / 60;
  const promised = new Map();
  let admitted = 0;
  let refused = 0;
  for (const c of certs) {
    if (!c.admitted) {
      refused++;
      continue;
    }
    admitted++;
    const v = scenario.vehicles.find((x) => x.sessionId === c.sessionId);
    const slots = Math.max(0, c.deadlineSlot - c.arrivalSlot);
    promised.set(c.sessionId, Math.min(c.floorKw * dtH * slots, v.remainingKwh));
  }
  let promisedKwh = 0;
  let realizedKwh = 0;
  let shortfallVehicles = 0;
  let deadlineMisses = 0;
  let unmetKwh = 0;
  let maxShortfallKwh = 0;
  for (const sid of ids) {
    const v = scenario.vehicles.find((x) => x.sessionId === sid);
    const p = promised.get(sid) || 0;
    const got = (realizedSchedule[sid] || []).slice(0, v.deadlineSlot).reduce((a, b) => a + b, 0);
    promisedKwh += p;
    realizedKwh += Math.min(got, p);
    const shortfall = Math.max(0, p - got);
    maxShortfallKwh = Math.max(maxShortfallKwh, shortfall);
    // Materiality tolerance, fixed in advance: the schedule is emitted rounded to
    // 1e-4 kWh, so a 0.0001 kWh gap is arithmetic noise, not a broken promise. A
    // shortfall counts when it exceeds 1% of the promise or 0.05 kWh, whichever is
    // larger — and `max_shortfall_kwh` is always reported so a real failure (kWh-scale)
    // cannot hide behind the threshold.
    const tolerance = Math.max(0.05, 0.01 * p);
    if (shortfall > tolerance) shortfallVehicles++;
    if (got + tolerance < v.remainingKwh) deadlineMisses++;
    unmetKwh += Math.max(0, v.remainingKwh - got);
  }
  return {
    admitted,
    refused,
    promised_population: ids.length,
    promised_kwh: +promisedKwh.toFixed(4),
    realized_kwh: +realizedKwh.toFixed(4),
    shortfall_kwh: +Math.max(0, promisedKwh - realizedKwh).toFixed(4),
    shortfall_vehicles: shortfallVehicles,
    max_shortfall_kwh: +maxShortfallKwh.toFixed(4),
    shortfall_rate: ids.length ? +(shortfallVehicles / ids.length).toFixed(4) : 0,
    promised_deadline_misses: deadlineMisses,
    promised_deadline_miss_rate: ids.length ? +(deadlineMisses / ids.length).toFixed(4) : 0,
    promised_unmet_kwh: +unmetKwh.toFixed(4),
  };
}

// Score every strategy on one scenario under identical physics.
// `aesArm` is an opt-in, NOT a default: E1b and E3 are pre-registered against the
// power-based allocator, and their committed receipts must regenerate byte-for-byte from
// their own scripts (ADR-0013). The AES comparison lives in E4, which passes aesArm: true
// and gets both arms on the same population; every earlier experiment is untouched.
function scoreAll(scenario, { betaPerKw = 10, reserveFraction, marginKwh, aesArm = false } = {}) {
  const ctrl = certifyAndSchedule(scenario, { reserveFraction, marginKwh });
  const promisedIds = ctrl.certs.filter((c) => c.admitted).map((c) => c.sessionId);
  const requested = {
    controller: ctrl.schedule,
    static_cap: baselines.staticCap(scenario),
    price_blind_edf: baselines.priceGreedyEdf(scenario),
    uncontrolled: baselines.uncontrolled(scenario),
  };
  // Same certificates, same population, same physics — only the allocator differs, which
  // is what makes the AES delta an attributable effect rather than a confound.
  const ctrlAes = aesArm ? certifyAndSchedule(scenario, { reserveFraction, marginKwh, acceptanceAware: true }) : null;
  if (ctrlAes) requested.controller_aes = ctrlAes.schedule;
  const strategies = {};
  const calibrationByStrategy = {};
  for (const [name, req] of Object.entries(requested)) {
    const reality = twin.applyActuatorReality(scenario, req);
    const planned = twin.evaluate(scenario, req, { betaPerKw });
    const actual = twin.evaluate(scenario, reality.schedule, { betaPerKw });
    const delivered = [...reality.deliveredByVehicle.values()].reduce((a, b) => a + b, 0);
    strategies[name] = {
      strategy: name,
      ...actual,
      planned_peak_kw: planned.peak_kw,
      // The envelope bounds what the CSMS COMMANDS. A charger that ignores its profile
      // can still overload the site physically — measured, not hand-waved.
      realized_peak_over_cap_kw: +Math.max(0, actual.peak_kw - scenario.siteCapKw).toFixed(3),
      delivered_kwh: +delivered.toFixed(4),
      cost_per_kwh_delivered: delivered > 1e-6 ? +(actual.total_cost_units / delivered).toFixed(4) : null,
    };
    calibrationByStrategy[name] = calibration(scenario, ctrl.certs, reality.schedule, promisedIds);
  }
  const lowerBound = twin.evaluate(scenario, baselines.costLowerBound(scenario), { betaPerKw: 0 });
  return {
    strategies,
    calibration: calibrationByStrategy.controller,
    calibration_by_strategy: calibrationByStrategy,
    promised_ids: promisedIds,
    usable_cap_kw: +ctrl.usableCapKw.toFixed(3),
    planner_metrics: ctrl.metrics,
    ...(ctrlAes
      ? {
          // The AES plan's own deliverability claim vs what physics then delivered.
          // Plan-honesty (claim == outcome) is the property ADR-0015 exists to restore, so
          // it is measured directly rather than inferred from the cost table.
          planner_metrics_aes: ctrlAes.metrics,
          plan_honesty: {
            aes_claim_kwh: ctrlAes.metrics.absorbable_kwh,
            aes_delivered_kwh: strategies.controller_aes.delivered_kwh,
            power_claim_kwh: ctrl.metrics.delivered_kwh,
            power_delivered_kwh: strategies.controller.delivered_kwh,
          },
        }
      : {}),
    cost_lower_bound_energy_units: lowerBound.energy_cost_units,
  };
}

// Receipt compaction. `evaluate()` returns the full per-slot schedule so a caller can
// re-score a strategy, and that is exactly what belongs in memory — not in a committed
// artefact. Embedding it for every seed, strategy and arm produced receipts of ~6-8 MB
// whose actual evidence (the per-seed metrics and the aggregates every hypothesis is
// computed from) is ~60 KB. The slot-level detail is reproducible by re-running the
// receipt's own command; the multi-megabyte blob would be paid for by every future clone,
// forever. So the metrics are kept and the slot arrays are dropped.
//
// No number moves: the summary loops already skip non-numeric fields (`typeof !== 'number'`),
// so aggregation is unaffected by removing an array-valued field.
function compactRow(row) {
  for (const s of Object.values(row.strategies || {})) delete s.per_slot_kwh;
  for (const key of ['planner_metrics', 'planner_metrics_aes']) {
    if (!row[key]) continue;
    delete row[key].per_slot_kwh;
    // The per-session arrival/departure slot maps are scenario INPUTS, not results — they
    // are regenerated exactly from the row's seed — and they were the single largest
    // field in the artefact.
    delete row[key].arrival_slots;
    delete row[key].deadline_slots;
  }
  return row;
}

module.exports = { certifyAndSchedule, calibration, scoreAll, compactRow, DEFAULT_RESERVE, DEFAULT_MARGIN_KWH };
