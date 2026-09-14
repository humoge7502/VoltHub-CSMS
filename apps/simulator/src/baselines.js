// Baseline charging strategies for the twin (ADR-0013 baselines).
//
// Every function returns a *requested* schedule keyed by sessionId -> kWh per slot and
// nothing else. Actuator reality (CC-CV acceptance, non-compliant chargers) is applied
// identically to every strategy afterwards by twin.applyActuatorReality, so no baseline
// can be scored under kinder physics than the controller. That symmetry is the whole
// reason these live in a separate module instead of inside each experiment.
'use strict';

const dtHours = (scenario) => scenario.dtMin / 60;

const emptySchedule = (scenario) =>
  Object.fromEntries(scenario.vehicles.map((v) => [v.sessionId, Array(scenario.horizon).fill(0)]));

// Uncontrolled: each vehicle takes its connector maximum from arrival until its own
// need is met. This is the "do nothing" baseline — deliberately not capped, because
// pretending the uncontrolled case respects the site cap would hide the entire
// demand-charge argument.
function uncontrolled(scenario) {
  const s = emptySchedule(scenario);
  const dtH = dtHours(scenario);
  for (const v of scenario.vehicles) {
    let need = v.remainingKwh;
    for (let t = v.arrivalSlot; t < v.deadlineSlot && need > 1e-9; t++) {
      const give = Math.min(v.maxKw * dtH, need);
      s[v.sessionId][t] += give;
      need -= give;
    }
  }
  return s;
}

// Static-cap load balancing: the site cap is split equally among vehicles plugged in
// during the slot. The industry-default behaviour, and the baseline that matters most:
// it is cheap, obvious, and hard to beat on fairness.
function staticCap(scenario) {
  const s = emptySchedule(scenario);
  const dtH = dtHours(scenario);
  const need = new Map(scenario.vehicles.map((v) => [v.sessionId, v.remainingKwh]));
  for (let t = 0; t < scenario.horizon; t++) {
    const active = scenario.vehicles.filter(
      (v) => t >= v.arrivalSlot && t < v.deadlineSlot && need.get(v.sessionId) > 1e-9
    );
    if (!active.length) continue;
    const share = (scenario.siteCapKw * dtH) / active.length;
    for (const v of active) {
      const give = Math.max(0, Math.min(share, v.maxKw * dtH, need.get(v.sessionId)));
      s[v.sessionId][t] += give;
      need.set(v.sessionId, need.get(v.sessionId) - give);
    }
  }
  return s;
}

// EDF (earliest-deadline-first), chronological, price-blind. This is the ablation of
// the price-shift pass: same feasibility discipline as the controller, no tariff
// awareness — so the cost difference between this and the controller is attributable
// to pricing alone.
function priceGreedyEdf(scenario) {
  const s = emptySchedule(scenario);
  const dtH = dtHours(scenario);
  const need = new Map(scenario.vehicles.map((v) => [v.sessionId, v.remainingKwh]));
  const edf = [...scenario.vehicles].sort((a, b) => a.deadlineSlot - b.deadlineSlot || a.sessionId - b.sessionId);
  for (let t = 0; t < scenario.horizon; t++) {
    let used = 0;
    for (const v of edf) {
      if (t < v.arrivalSlot || t >= v.deadlineSlot || need.get(v.sessionId) <= 1e-9) continue;
      const give = Math.max(0, Math.min(v.maxKw * dtH, scenario.siteCapKw * dtH - used, need.get(v.sessionId)));
      if (give <= 1e-9) continue;
      s[v.sessionId][t] += give;
      need.set(v.sessionId, need.get(v.sessionId) - give);
      used += give;
    }
  }
  return s;
}

// Cost lower bound: each vehicle fills its cheapest in-window slots with the site cap
// *relaxed away*. Removing a constraint cannot make the optimum worse, so its ENERGY
// cost is a lower bound on the energy cost of any schedule that serves the SAME total
// demand under the same windows.
//
// Scope caveat, stated because it is easy to get wrong: this is NOT a bound against
// strategies that serve less energy. A strategy that misses deadlines is cheaper partly
// because it does less work, so comparing its absolute cost to this number is invalid;
// cost comparisons across strategies must always be read next to delivered_kwh /
// deadline-miss (which is why bench/e1b reports those beside every cost figure). Its
// peak and deadline metrics are meaningless by construction and are not reported.
function costLowerBound(scenario) {
  const s = emptySchedule(scenario);
  const dtH = dtHours(scenario);
  for (const v of scenario.vehicles) {
    let need = v.remainingKwh;
    const slots = [];
    for (let t = v.arrivalSlot; t < v.deadlineSlot; t++) slots.push(t);
    slots.sort((a, b) => (scenario.prices[a] ?? 0) - (scenario.prices[b] ?? 0) || a - b);
    for (const t of slots) {
      if (need <= 1e-9) break;
      const give = Math.min(v.maxKw * dtH, need);
      s[v.sessionId][t] += give;
      need -= give;
    }
  }
  return s;
}

module.exports = { uncontrolled, staticCap, priceGreedyEdf, costLowerBound, emptySchedule };
