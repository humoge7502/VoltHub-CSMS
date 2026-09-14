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
// Admission margin (kWh): the certificate promises the floor only if the worst case
// clears need + margin. Tunable; the benchmark sweeps it.
const DEFAULT_MARGIN_KWH = Number(process.env.FCHCC_MARGIN_KWH || 2);
// Target state of charge assumed when a vehicle declares only a battery size.
const TARGET_SOC = Number(process.env.FCHCC_TARGET_SOC || 0.8);
// Certificate replan cadence bound (minutes): hysteresis that stops a site from
// replanning on every meter tick once deviation is detected.
const DEFAULT_HYSTERESIS_MIN = Number(process.env.FCHCC_HYSTERESIS_MIN || 5);
// Acceptance-envelope scheduling (ADR-0015): the allocator consumes the same CC-CV
// acceptance curve the certifier and the twin already share, so plan-time feasibility
// equals realised feasibility. Default ON for the shipped controller — a promise and a
// plan that disagree about physics is the defect, not the configuration. Set
// FCHCC_ACCEPTANCE_AWARE=0 to reproduce the pre-ADR-0015 power-based allocator (the
// ablation arm in bench/e4-taper.js).
const ACCEPTANCE_AWARE = process.env.FCHCC_ACCEPTANCE_AWARE !== '0';

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

// ---- requirement / deadline resolvers -------------------------------------
// The 40 kWh seed default used to be the ONLY requirement the optimizer ever saw.
// These resolvers make the constraint real: energy from the connected vehicle's
// battery size + target SoC, deadline from the reservation that owns the connector.
function requirementKwhFor(store) {
  return (sess) => {
    const veh = sess.vehicle_id != null ? store.vehicles.get(Number(sess.vehicle_id)) : null;
    const battery = veh ? Number(veh.battery_kwh) : NaN;
    if (!(battery > 0)) return null; // no declared vehicle -> documented default
    return +(battery * TARGET_SOC).toFixed(3);
  };
}

// Richer requirement source: energy + the battery/SoC reference the certifier needs to
// be taper-aware. The SoC reference is the conservative one — the target SoC, or the
// delivered/nameplate ratio when that is already higher — because an unknown present
// SoC must not be assumed favourable when the promise is being made.
function vehicleStateFor(store) {
  return (sess, delivered) => {
    const veh = sess.vehicle_id != null ? store.vehicles.get(Number(sess.vehicle_id)) : null;
    const battery = veh ? Number(veh.battery_kwh) : NaN;
    if (!(battery > 0)) return { requiredKwh: null, batteryKwh: null, socRef: null };
    const socRef = Math.min(1, Math.max(TARGET_SOC, (Number(delivered) || 0) / battery));
    return { requiredKwh: +(battery * TARGET_SOC).toFixed(3), batteryKwh: battery, socRef: +socRef.toFixed(4) };
  };
}

function deadlineFor(store) {
  return (v) => {
    const sess = store.sessions.get(Number(v.sessionId));
    if (!sess) return null;
    const own = sess.reservation_id != null ? store.reservations.get(Number(sess.reservation_id)) : null;
    if (own && Number.isFinite(Date.parse(own.end_at))) return Date.parse(own.end_at);
    // M3-ish fallback: the earliest live booking on the same connector bounds how
    // long this session may hold it, even when the session adopted the window
    // without carrying the id.
    let earliest = null;
    for (const r of store.reservations.values()) {
      if (r.connector_ref !== v.connectorRef) continue;
      if (!['BOOKED', 'CONVERTED'].includes(r.status)) continue;
      const end = Date.parse(r.end_at);
      if (Number.isFinite(end) && (earliest === null || end < earliest)) earliest = end;
    }
    return earliest;
  };
}

function certifiedFloorFor(store) {
  return (v) => {
    let floor = 0;
    for (const c of store.certificates.values()) {
      if (c.session_id === Number(v.sessionId) && c.status === 'ACTIVE') floor += Number(c.floor_kw) || 0;
    }
    return floor;
  };
}

function latestCertFor(store, sessionId) {
  let best = null;
  for (const c of store.certificates.values()) {
    if (c.session_id !== Number(sessionId)) continue;
    if (!best || c.cert_id > best.cert_id) best = c;
  }
  return best;
}

// ---- certify: admission control (blueprint H.2.4 / I.5-H1) ----------------
// Issues one certificate per active vehicle per admission attempt. Certificates are
// persisted rows with a legal state machine — not log lines — because the promise is
// the product: the floor is honoured by the scheduler (constraint 8) and graded
// against enforcement telemetry (verifyCompliance below).
//
// The certificate is computed against the RESERVED cap (the cap the scheduler will
// actually deliver under), never the raw site cap: a promise stronger than the plan
// would be a lie with a signature on it.
function certifySite(store, siteIdN, vehicles, usableCapKw, now, opts = {}) {
  const marginKwh = opts.marginKwh != null ? Number(opts.marginKwh) : DEFAULT_MARGIN_KWH;
  const issued = [];
  for (const v of [...vehicles].sort((a, b) => a.sessionId - b.sessionId)) {
    const prior = latestCertFor(store, v.sessionId);
    if (prior && ['ACTIVE', 'ERODED'].includes(prior.status)) {
      issued.push({ session_id: v.sessionId, cert_id: prior.cert_id, status: prior.status, reused: true });
      continue;
    }
    const othersFloor = vehicles
      .filter((o) => o.sessionId !== v.sessionId)
      .reduce((a, o) => a + (o.certifiedFloorKw || 0), 0);
    const verdict = model.certifyVehicle({
      vehicle: v,
      siteCapKw: usableCapKw,
      certifiedFloorKw: othersFloor,
      now,
      deadlineAt: v.deadlineAt,
      marginKwh,
    });
    // A previous FAILED attempt stays FAILED while the verdict is still negative —
    // re-inserting identical rejections every plan cycle would be noise, not audit.
    if (prior && prior.status === 'FAILED' && !verdict.admitted) {
      issued.push({ session_id: v.sessionId, cert_id: prior.cert_id, status: 'FAILED', reused: true });
      continue;
    }
    const row = store.issueCertificate({
      sessionId: v.sessionId,
      stationId: siteIdN,
      cpId: v.cpId,
      connectorNo: v.connectorNo,
      floorKw: verdict.floorKw,
      marginKwh: verdict.marginKwh,
      worstCaseKwh: verdict.worstCaseKwh,
      requiredKwh: verdict.requiredKwh,
      deadlineAt: v.deadlineAt ? new Date(v.deadlineAt).toISOString() : null,
      decisionId: null,
      admitted: verdict.admitted,
    });
    if (row.status === 'ACTIVE') {
      // Persist the promise where the scheduler reads it, so the next plan cycle
      // protects it as a floor (constraint 8) rather than rediscovering it.
      const target = vehicles.find((x) => x.sessionId === v.sessionId);
      if (target) target.certifiedFloorKw = row.floor_kw;
      store.notify(v.userId, 'CONTROL', 'Charging guarantee issued', {
        cert_id: row.cert_id,
        floor_kw: row.floor_kw,
        worst_case_kwh: row.worst_case_kwh,
        deadline_at: row.deadline_at,
      });
    }
    issued.push({
      session_id: v.sessionId,
      cert_id: row.cert_id,
      status: row.status,
      admitted: verdict.admitted,
      slack_kwh: verdict.slackKwh,
      reused: false,
    });
  }
  return issued;
}

// Certify ONE session on demand (plug-in admission / re-admission after a rejection).
// Shares certifySite with the plan cycle so a certificate issued here is identical to
// one issued in planning — the promise must not depend on who asked for it.
function certifySession(store, sessionId, opts = {}) {
  const sid = Number(sessionId);
  const sess = store.sessions.get(sid);
  if (!sess) {
    const e = new Error('session not found');
    e.code = 'NOT_FOUND';
    e.status = 404;
    throw e;
  }
  const cpId = Number(String(sess.connector_ref).split(':')[0]);
  const cp = store.cps.get(cpId);
  const siteIdN = cp ? cp.station_id : null;
  const capRaw = store.siteCapKw(siteIdN);
  const usable = capRaw === Infinity ? Infinity : capRaw * (1 - FORECAST_RESERVE_FRACTION);
  const vehicles = model
    .estimateVehicles(store, siteIdN, Date.now(), {
      requirementKwhFor: opts.requirementKwhFor || requirementKwhFor(store),
      vehicleStateFor: opts.vehicleStateFor || vehicleStateFor(store),
    })
    .filter((v) => v.sessionId === sid)
    .map((v) => ({
      ...v,
      deadlineAt: (opts.deadlineFor || deadlineFor(store))(v) || null,
      certifiedFloorKw: (opts.certifiedFloorFor || certifiedFloorFor(store))(v),
    }));
  if (!vehicles.length) {
    const e = new Error('session is not active (nothing to certify)');
    e.code = 'NOT_CERTIFIABLE';
    e.status = 409;
    throw e;
  }
  return { site_id: siteIdN, certifications: certifySite(store, siteIdN, vehicles, usable, Date.now(), opts) };
}

// One full plan cycle for a site. Returns { decision, pushes, certifications } —
// pushes are the compiled OCPP SetChargingProfile payloads per charge point
// (callers actuate via ocpp/smart-charging.js; ADVISORY mode stops short of sending).
function planSite(store, siteId, opts = {}) {
  const siteIdN = Number(siteId);
  const mode = store.getControlMode(siteIdN);
  const t0 = Date.now();
  const dtMin = opts.dtMin || model.DEFAULT_INTERVAL_MIN;
  const horizon = opts.horizon || model.DEFAULT_HORIZON;

  // 1) Sense + estimate, with the requirement/deadline/floor resolvers (opts may
  //    override for experiments; the production route uses the store-derived ones).
  const deadlineResolver = opts.deadlineFor || deadlineFor(store);
  const floorResolver = opts.certifiedFloorFor || certifiedFloorFor(store);
  const reqResolver = opts.requirementKwhFor || requirementKwhFor(store);
  const stateResolver = opts.vehicleStateFor || vehicleStateFor(store);
  const vehicles = model
    .estimateVehicles(store, siteIdN, t0, { requirementKwhFor: reqResolver, vehicleStateFor: stateResolver })
    .map((v) => ({
      ...v,
      deadlineAt: deadlineResolver(v) || null,
      certifiedFloorKw: floorResolver(v),
    }));

  // 2) Predict with bounds: shrink the site cap by the forecast reserve.
  const capRaw = store.siteCapKw(siteIdN);
  const siteCapKw = capRaw === Infinity ? Infinity : capRaw * (1 - FORECAST_RESERVE_FRACTION);
  const bounds = { site_cap_kw: capRaw, reserve_fraction: FORECAST_RESERVE_FRACTION, usable_cap_kw: siteCapKw };
  const bounds_hash = hashBounds(bounds);

  // 3) Certify: admission happens BEFORE scheduling, so the planner knows which
  //    floors are protocol-backed promises it must honour.
  const certifications = certifySite(store, siteIdN, vehicles, siteCapKw, t0, opts);

  // 4) Optimize (deterministic feasibility-first, price-aware; the benchmark imports
  //    THIS function — one solver, one truth).
  const cpCaps = new Map();
  for (const v of vehicles) if (!cpCaps.has(v.cpId)) cpCaps.set(v.cpId, capRaw);
  const acceptanceAware = opts.acceptanceAware == null ? ACCEPTANCE_AWARE : !!opts.acceptanceAware;
  const solved = model.solveSchedule({
    vehicles,
    siteCapKw,
    cpCaps,
    priceSeries: priceSeriesFactory(store, opts.planId),
    dtMin,
    horizon,
    now: t0,
    acceptanceAware,
  });

  // 5) Persist the decision (append-only) with full provenance.
  const decision = store.recordDecision(siteIdN, {
    horizon_start: new Date(solved.grid.start).toISOString(),
    interval_min: dtMin,
    payload_json: JSON.stringify({
      bounds,
      vehicles,
      schedule: solved.schedule,
      metrics: solved.metrics,
      certifications,
    }),
    bounds_hash,
    // The audit row names the allocator that produced it: a decision made with a
    // taper-blind allocator must be distinguishable from one made with AES, or a
    // receipt cannot say which mechanism was under test (ADR-0013/0015).
    solver: opts.solver || `fchcc-edf-priceshift${acceptanceAware ? '-aes' : ''}`,
    runtime_ms: +(Date.now() - t0).toFixed(2),
    state_version: store.outbox.length,
  });

  // 6) Compile to OCPP charging profiles per charge point (H.2.5).
  const pushes = compileToProfiles(store, siteIdN, decision, solved, dtMin, horizon);
  return { mode, decision, solved, pushes, certifications };
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
// verdict from the margin-erosion trigger. The hysteresis clock is the latest
// committed decision (durable), not a module variable.
function verifyCompliance(store, siteIdN, { toleranceKw, hysteresisMin, lastReplanAt } = {}) {
  let anchor = lastReplanAt;
  if (anchor == null) {
    const latest = store.latestDecisionFor ? store.latestDecisionFor(siteIdN) : null;
    if (latest?.created_at) anchor = Date.parse(latest.created_at);
  }
  const verdict = model.shouldReplan({
    certificates: store.certificates,
    enforcementTicks: store.enforcementTicks,
    toleranceKw,
    hysteresisMin: hysteresisMin == null ? DEFAULT_HYSTERESIS_MIN : hysteresisMin,
    lastReplanAt: anchor,
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
  certifySite,
  certifySession,
  compileToProfiles,
  envelopeCheck,
  verifyCompliance,
  hashBounds,
  requirementKwhFor,
  vehicleStateFor,
  deadlineFor,
  certifiedFloorFor,
  FORECAST_RESERVE_FRACTION,
  DEFAULT_MARGIN_KWH,
  TARGET_SOC,
  DEFAULT_HYSTERESIS_MIN,
  ACCEPTANCE_AWARE,
};
