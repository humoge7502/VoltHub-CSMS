// ADR-0010 / FC-HCC controller loop (blueprint H.2): sense -> estimate -> predict
// -> optimize -> certify -> actuate -> verify. Runs against the store port only —
// the same code the twin drives in closed-loop experiments.
// Failure semantics (O.3): the optimizer being down never lifts the envelope;
// controllers are advisory inputs to a gateway that independently enforces caps.
'use strict';
const crypto = require('crypto');
const model = require('./model');

// Quantile bounds (blueprint H.2.2): honest defaults until the quantile
// forecaster lands (Phase 5). A reserve fraction shrinks usable site headroom;
// the provenance hash makes every decision reproducible/auditable.
const FORECAST_RESERVE_FRACTION = Number(process.env.FCHCC_RESERVE || 0.1);

function priceSeriesFactory(store, planId) {
  // ToU price path from the tariff resolver; falls back to flat 1.0 when the
  // plan/band lookup fails (control must not crash the money path).
  return (ticks) => {
    try {
      return ticks.map((t) => {
        const d = new Date(t);
        return Number(store.resolveBandPrice(planId || store.defaultPlanId(), d.toISOString())) || 1;
      });
    } catch {
      return ticks.map(() => 1);
    }
  };
}

function hashBounds(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

// One full plan cycle for a site. Returns { decision, pushes } — pushes are the
// compiled OCPP SetChargingProfile payloads per charge point (callers actuate via
// ocpp/smart-charging.js; ADVISORY mode stops short of sending).
function planSite(store, siteId, opts = {}) {
  const siteIdN = Number(siteId);
  const mode = store.getControlMode(siteIdN);
  const t0 = Date.now();
  const dtMin = opts.dtMin || model.DEFAULT_INTERVAL_MIN;
  const horizon = opts.horizon || model.DEFAULT_HORIZON;

  // 1) Sense + estimate.
  const vehicles = model.estimateVehicles(store, siteIdN, t0).map((v) => ({
    ...v,
    deadlineAt: opts.deadlineFor ? opts.deadlineFor(v) : null,
    certifiedFloorKw: opts.certifiedFloorFor ? opts.certifiedFloorFor(v) : 0,
  }));

  // 2) Predict with bounds: shrink the site cap by the forecast reserve.
  const capRaw = store.siteCapKw(siteIdN);
  const siteCapKw = capRaw === Infinity ? Infinity : capRaw * (1 - FORECAST_RESERVE_FRACTION);
  const bounds = { site_cap_kw: capRaw, reserve_fraction: FORECAST_RESERVE_FRACTION, usable_cap_kw: siteCapKw };
  const bounds_hash = hashBounds(bounds);

  // 3) Optimize (deterministic surrogate LP; HiGHS upgrade compiles the same vocab).
  const cpCaps = new Map();
  for (const v of vehicles) if (!cpCaps.has(v.cpId)) cpCaps.set(v.cpId, capRaw);
  const solved = model.solveSchedule({
    vehicles,
    siteCapKw,
    cpCaps,
    priceSeries: priceSeriesFactory(store, opts.planId),
    dtMin,
    horizon,
    now: t0,
  });

  // 4) Persist the decision (append-only) with full provenance.
  const decision = store.recordDecision(siteIdN, {
    horizon_start: new Date(solved.grid.start).toISOString(),
    interval_min: dtMin,
    payload_json: JSON.stringify({ bounds, vehicles, schedule: solved.schedule, metrics: solved.metrics }),
    bounds_hash,
    solver: opts.solver || 'fchcc-lp-merit',
    runtime_ms: +(Date.now() - t0).toFixed(2),
    state_version: store.outbox.length,
  });

  // 5) Compile to OCPP charging profiles per charge point (H.2.5).
  const pushes = compileToProfiles(store, siteIdN, decision, solved, dtMin, horizon);
  return { mode, decision, solved, pushes };
}

// Compiler (blueprint H.2.5): x[v][t] kWh -> per-CP chargingSchedule with
// chargingRateUnit 'W'. Envelope clamping happens HERE and at the gateway —
// defense in depth: compiled profile can never exceed the asset cap.
function compileToProfiles(store, siteIdN, decision, solved, dtMin, horizon) {
  const capRaw = store.siteCapKw(siteIdN);
  const byCp = new Map();
  for (const [sid, arr] of Object.entries(solved.schedule)) {
    const v = store.sessions.get(Number(sid));
    if (!v) continue;
    const cpId = Number(String(v.connector_ref).split(':')[0]);
    if (!byCp.has(cpId)) byCp.set(cpId, Array(horizon).fill(0));
    const dst = byCp.get(cpId);
    arr.forEach((kwh, i) => (dst[i] += kwh));
  }
  const out = [];
  for (const [cpId, arr] of byCp) {
    let clamped = false;
    const chargingSchedulePeriods = arr.map((kwh, i) => {
      // kW = kWh / dtH; W = kW * 1000. Clamp to the hierarchy cap (constraint 5).
      const kwRaw = kwh / (dtMin / 60);
      const kw = capRaw === Infinity ? kwRaw : Math.min(kwRaw, capRaw);
      if (kw < kwRaw - 1e-9) clamped = true;
      return { startPeriod: i * dtMin * 60, limit: Math.round(kw * 1000), numberPhases: 3 };
    });
    const profile = {
      chargingProfileId: decision.decision_id,
      stackLevel: 1,
      chargingProfilePurpose: 'TxDefaultProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: {
        duration: horizon * dtMin * 60,
        startSchedule: new Date(solved.grid.start).toISOString(),
        chargingRateUnit: 'W',
        chargingSchedulePeriods,
        minChargingRate: 0,
      },
    };
    const payload = { chargePointId: cpId, txProfile: profile };
    out.push({
      cpId,
      profile,
      clamped,
      payloadSha256: crypto.createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
      payload,
    });
  }
  return out;
}

// Envelope (blueprint I.5-H3 / N.2): optimizer-INDEPENDENT hard-cap enforcement.
// The gateway consults this before ANY outgoing SetChargingProfile and rejects
// (with the -20903 band) whatever would exceed the certified electrical caps.
// If the site has no grid asset, Infinity => allow (nothing certified to violate).
function envelopeCheck(store, cpId, profile) {
  const cp = store.cps.get(Number(cpId));
  const siteId = cp?.station_id;
  const cap = siteId != null ? store.siteCapKw(siteId) : Infinity;
  if (cap === Infinity) return { ok: true };
  const periods = profile?.chargingSchedule?.chargingSchedulePeriods || [];
  const bad = periods.find((p) => Number(p.limit) > cap * 1000 + 1e-6);
  if (bad) {
    return {
      ok: false,
      error: {
        num: -20903,
        code: 'ENVELOPE_REJECTED',
        message: `profile limit ${bad.limit} W exceeds site cap ${cap} kW`,
        status: 409,
      },
    };
  }
  return { ok: true };
}

// Compliance verification (H.2.5): compare scheduled vs actual kW from recent
// enforcement ticks; erode certificates beyond tolerance and return the replan
// verdict from the margin-erosion trigger.
function verifyCompliance(store, siteIdN, { toleranceKw, hysteresisMin, lastReplanAt } = {}) {
  const verdict = model.shouldReplan({
    certificates: store.certificates,
    enforcementTicks: store.enforcementTicks,
    toleranceKw,
    hysteresisMin,
    lastReplanAt,
  });
  if (verdict.replan && verdict.reason === 'MARGIN_EROSION') {
    for (const e of verdict.eroded || []) {
      try {
        store.transitionCertificate(e.cert_id, 'ERODED', `deviation ${e.deviation_kw} kW > tolerance`);
      } catch {}
    }
    store.emitOutbox('PROFILE_COMPLIANCE', `compliance:${siteIdN}:${Date.now()}`, {
      site_id: siteIdN,
      triggered_replan: true,
      eroded: verdict.eroded,
    });
  }
  return verdict;
}

module.exports = {
  planSite,
  compileToProfiles,
  envelopeCheck,
  verifyCompliance,
  hashBounds,
  FORECAST_RESERVE_FRACTION,
};
