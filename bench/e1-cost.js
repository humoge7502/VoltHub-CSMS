// E1/E2 — Energy cost + peak demand: FC-HCC (merit-order LP) vs baselines.
// ============================================================================
// PRE-REGISTRATION (ADR-0013 — committed before results; edit = new experiment id)
//   Hypothesis H1 (total cost): total_cost = ToU energy cost + BETA * window peak
//     (blueprint K.3 objective: `sum pi_t x + beta * P`). The demand-charge term is
//     the market structure that makes uncontrolled charging structurally unprofitable
//     (blueprint R.1) — omitting it would misprice a 37 kW peak as "free".
//     BETA = 10 $/kW (stated assumption, mid-market CPO demand charge).
//     Under capacity-feasible contention (~75% of cap-energy), FC-HCC achieves
//     total_cost <= static-cap on >= 70% of seeds and < uncontrolled on >= 90%.
//   Hypothesis H2 (peak): peak(FCHCC) <= min(peak(static), peak(uncontrolled))
//     on every seed, and peak(FCHCC) <= SITE_CAP_KW always.
//   Metrics per seed (energy and demand components reported separately):
//     energy_cost_units, peak_kw, demand_charge_units = BETA*peak_kw,
//     total_cost_units, unmet_kwh. Paired across baselines (same seed => same fleet).
//   Acceptance: H1 on total_cost_units as above; H2 as stated on all seeds.
//   Baselines: uncontrolled (no cap), static-cap (equal split among active).
//   Protocol: 20 seeds x 2-hour horizon, 15-min intervals, 5-vehicle fleet.
//   Note: overload ladders (demand > cap-energy) are reported (unmet_kwh) but the
//     cost hypothesis is defined only where scheduling freedom exists — a fairness
//     / deadline-satisfaction study (E3) owns the overload regime.
// Run: node bench/e1-cost.js   (writes bench/results/e1-cost.json)
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');

// Deterministic PRNG (mulberry32) — same seed => same arrival stream.
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DT_MIN = 15;
const H = 8; // 2-hour horizon at 15-min intervals (scenario scale)
const SITE_CAP_KW = 10;
const CONN_MAX_KW = 22;
const SEEDS = 20;
const ToU = [0.18, 0.32, 0.18, 0.32, 0.55, 0.55, 0.55, 0.32]; // $/kWh per interval (synthetic block tariff)
const BETA = 10; // $ per kW of window peak (demand charge, stated assumption — K.3 `beta * P`)

function makeFleet(seed, n = 5) {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => ({
    sessionId: 1000 + i,
    cpId: (i % 4) + 1,
    maxKw: CONN_MAX_KW,
    // arrivals staggered inside the first interval; deadlines spread over the horizon
    arrivalSlot: Math.floor(rng() * 2),
    deadlineSlot: H - Math.floor(rng() * 2), // last 2 slots = deadline pressure
    remainingKwh: 2 + Math.round(rng() * 2), // 2..4 kWh needs (~75% of cap-energy: feasible)
    certifiedFloorKw: 0,
  }));
}

// FC-HCC surrogate LP (same code path as production; local, no store needed).

function fchcc(fleet) {
  // Merit-order LP surrogate: intervals in price order (cheapest first, index as
  // tie-break for determinism); within an interval, earliest-deadline-first so
  // urgent vehicles win scarce cheap capacity (feasibility-first EDF discipline).
  const need = new Map(fleet.map((v) => [v.sessionId, v.remainingKwh]));
  const x = new Map(fleet.map((v) => [v.sessionId, Array(H).fill(0)]));
  const capPerT = SITE_CAP_KW * (DT_MIN / 60);
  const intervals = Array.from({ length: H }, (_v, t) => t).sort((a, b) => ToU[a] - ToU[b] || a - b);
  for (const t of intervals) {
    const byDeadline = fleet
      .filter((v) => t >= v.arrivalSlot && t < v.deadlineSlot && need.get(v.sessionId) > 1e-9)
      .sort((a, b) => a.deadlineSlot - b.deadlineSlot || a.sessionId - b.sessionId);
    let used = [...x.values()].reduce((a, arr) => a + (arr[t] || 0), 0);
    for (const v of byDeadline) {
      if (capPerT - used <= 1e-9) break;
      const give = Math.min(v.maxKw * (DT_MIN / 60), capPerT - used, need.get(v.sessionId));
      if (give > 0) {
        x.get(v.sessionId)[t] += give;
        need.set(v.sessionId, need.get(v.sessionId) - give);
        used += give;
      }
    }
  }
  const energy = ToU.reduce((a, p, t) => a + p * [...x.values()].reduce((s, arr) => s + (arr[t] || 0), 0), 0);
  const peak = Math.max(
    0,
    ...Array.from({ length: H }, (_v, t) => [...x.values()].reduce((s, arr) => s + (arr[t] || 0), 0) / (DT_MIN / 60))
  );
  return {
    schedule: Object.fromEntries(x),
    energy_cost_units: +energy.toFixed(4),
    peak_kw: +peak.toFixed(3),
    demand_charge_units: +(BETA * peak).toFixed(4),
    total_cost_units: +(energy + BETA * peak).toFixed(4),
    unmet_kwh: +[...need.values()].reduce((a, b) => a + b, 0).toFixed(4),
  };
}

function uncontrolled(fleet) {
  // Every vehicle draws flat max from arrival to need-satisfaction (no coordination).
  const need = new Map(fleet.map((v) => [v.sessionId, v.remainingKwh]));
  const x = new Map(fleet.map((v) => [v.sessionId, Array(H).fill(0)]));
  for (let t = 0; t < H; t++) {
    for (const v of fleet) {
      if (t < v.arrivalSlot || need.get(v.sessionId) <= 1e-9) continue;
      const give = Math.min(v.maxKw * (DT_MIN / 60), need.get(v.sessionId));
      x.get(v.sessionId)[t] += give;
      need.set(v.sessionId, need.get(v.sessionId) - give);
    }
  }
  const energy = ToU.reduce((a, p, t) => a + p * [...x.values()].reduce((s, arr) => s + (arr[t] || 0), 0), 0);
  const peak = Math.max(
    0,
    ...Array.from({ length: H }, (_v, t) => [...x.values()].reduce((s, arr) => s + (arr[t] || 0), 0) / (DT_MIN / 60))
  );
  return {
    schedule: Object.fromEntries(x),
    energy_cost_units: +energy.toFixed(4),
    peak_kw: +peak.toFixed(3),
    demand_charge_units: +(BETA * peak).toFixed(4),
    total_cost_units: +(energy + BETA * peak).toFixed(4),
    unmet_kwh: +[...need.values()].reduce((a, b) => a + b, 0).toFixed(4),
  };
}

function staticCap(fleet) {
  // Static site-cap load balancing: equal share of the cap among active vehicles.
  const need = new Map(fleet.map((v) => [v.sessionId, v.remainingKwh]));
  const x = new Map(fleet.map((v) => [v.sessionId, Array(H).fill(0)]));
  for (let t = 0; t < H; t++) {
    const active = fleet.filter((v) => t >= v.arrivalSlot && t < v.deadlineSlot && need.get(v.sessionId) > 1e-9);
    if (!active.length) continue;
    const per = (SITE_CAP_KW * (DT_MIN / 60)) / active.length;
    for (const v of active) {
      const give = Math.min(per, v.maxKw * (DT_MIN / 60), need.get(v.sessionId));
      x.get(v.sessionId)[t] += give;
      need.set(v.sessionId, need.get(v.sessionId) - give);
    }
  }
  const energy = ToU.reduce((a, p, t) => a + p * [...x.values()].reduce((s, arr) => s + (arr[t] || 0), 0), 0);
  const peak = Math.max(
    0,
    ...Array.from({ length: H }, (_v, t) => [...x.values()].reduce((s, arr) => s + (arr[t] || 0), 0) / (DT_MIN / 60))
  );
  return {
    schedule: Object.fromEntries(x),
    energy_cost_units: +energy.toFixed(4),
    peak_kw: +peak.toFixed(3),
    demand_charge_units: +(BETA * peak).toFixed(4),
    total_cost_units: +(energy + BETA * peak).toFixed(4),
    unmet_kwh: +[...need.values()].reduce((a, b) => a + b, 0).toFixed(4),
  };
}

function mean(a) {
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function main() {
  const rows = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const fleet = makeFleet(seed);
    const a = fchcc(fleet);
    const u = uncontrolled(fleet);
    const s = staticCap(fleet);
    rows.push({ seed, fchcc: a, uncontrolled: u, static_cap: s });
    // acceptance gate (H2): fchcc peak <= cap on every seed
    if (a.peak_kw > SITE_CAP_KW + 1e-6) throw new Error(`H2 VIOLATED on seed ${seed}: peak ${a.peak_kw} kW`);
    if (a.peak_kw > u.peak_kw + 1e-6 || a.peak_kw > s.peak_kw + 1e-6)
      throw new Error(`H2 VIOLATED on seed ${seed}: fchcc peak ${a.peak_kw} > baseline`);
  }
  const h1Wins = rows.filter((r) => r.fchcc.total_cost_units <= r.static_cap.total_cost_units).length;
  const h1bWins = rows.filter((r) => r.fchcc.total_cost_units < r.uncontrolled.total_cost_units).length;
  const h2Wins = rows.filter(
    (r) =>
      r.fchcc.peak_kw <= r.static_cap.peak_kw + 1e-6 &&
      r.fchcc.peak_kw <= r.uncontrolled.peak_kw + 1e-6 &&
      r.fchcc.peak_kw <= SITE_CAP_KW + 1e-6
  ).length;
  const summary = {
    experiment: 'e1-cost/e2-peak',
    preregistration: 'see file header (ADR-0013)',
    seeds: SEEDS,
    site_cap_kw: SITE_CAP_KW,
    horizon_intervals: H,
    interval_min: DT_MIN,
    beta_per_kw: BETA,
    mean: {
      fchcc: {
        energy_cost_units: +mean(rows.map((r) => r.fchcc.energy_cost_units)).toFixed(4),
        peak_kw: +mean(rows.map((r) => r.fchcc.peak_kw)).toFixed(3),
        demand_charge_units: +mean(rows.map((r) => r.fchcc.demand_charge_units)).toFixed(4),
        total_cost_units: +mean(rows.map((r) => r.fchcc.total_cost_units)).toFixed(4),
        unmet_kwh: +mean(rows.map((r) => r.fchcc.unmet_kwh)).toFixed(4),
      },
      uncontrolled: {
        energy_cost_units: +mean(rows.map((r) => r.uncontrolled.energy_cost_units)).toFixed(4),
        peak_kw: +mean(rows.map((r) => r.uncontrolled.peak_kw)).toFixed(3),
        demand_charge_units: +mean(rows.map((r) => r.uncontrolled.demand_charge_units)).toFixed(4),
        total_cost_units: +mean(rows.map((r) => r.uncontrolled.total_cost_units)).toFixed(4),
        unmet_kwh: +mean(rows.map((r) => r.uncontrolled.unmet_kwh)).toFixed(4),
      },
      static_cap: {
        energy_cost_units: +mean(rows.map((r) => r.static_cap.energy_cost_units)).toFixed(4),
        peak_kw: +mean(rows.map((r) => r.static_cap.peak_kw)).toFixed(3),
        demand_charge_units: +mean(rows.map((r) => r.static_cap.demand_charge_units)).toFixed(4),
        total_cost_units: +mean(rows.map((r) => r.static_cap.total_cost_units)).toFixed(4),
        unmet_kwh: +mean(rows.map((r) => r.static_cap.unmet_kwh)).toFixed(4),
      },
    },
    acceptance: {
      H1_cost_le_static: `${h1Wins}/${SEEDS} seeds (threshold >= ${Math.ceil(SEEDS * 0.7)})`,
      H1_cost_lt_uncontrolled: `${h1bWins}/${SEEDS} seeds (threshold >= ${Math.ceil(SEEDS * 0.9)})`,
      H1_pass: h1Wins >= Math.ceil(SEEDS * 0.7) && h1bWins >= Math.ceil(SEEDS * 0.9),
      H2_peak_min_of_baselines: `${h2Wins}/${SEEDS} seeds (must be ${SEEDS}/${SEEDS})`,
      H2_pass: h2Wins === SEEDS,
    },
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpus: require('os').cpus().length,
      timestamp: new Date().toISOString(),
    },
    rows,
  };
  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'e1-cost.json');
  fs.writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');
  console.log(`E1/E2 complete — ${out}`);
  console.log(JSON.stringify(summary.mean, null, 2));
  console.log(
    `H1 cost: ${summary.acceptance.H1_cost_le_static}, vs uncontrolled ${summary.acceptance.H1_cost_lt_uncontrolled} -> ${summary.acceptance.H1_pass ? 'PASS' : 'FAIL'}`
  );
  console.log(
    `H2 peak: ${summary.acceptance.H2_peak_min_of_baselines} -> ${summary.acceptance.H2_pass ? 'PASS' : 'FAIL'}`
  );
  if (!summary.acceptance.H1_pass) process.exitCode = 1; // negative result still published
}
main();
