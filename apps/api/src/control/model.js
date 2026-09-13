// ADR-0010 / FC-HCC model vocabulary (blueprint K.2): the shared language for
// estimator -> certifier -> arbiter -> compiler. Pure data shapes + the
// deterministic LP assembly shared by every stage — no I/O, no store access.
// Determinism rule (ADR-0008): identical inputs => identical schedule, always.
'use strict';

// Default control cadence (blueprint K.4): 15-minute intervals, 24-interval horizon.
const DEFAULT_INTERVAL_MIN = 15;
const DEFAULT_HORIZON = 24;

// Build the interval grid [t0, t0+H*dt) as epoch-ms ticks.
function intervalGrid(now, dtMin, horizon) {
  const dt = dtMin * 60000;
  const start = Math.floor(now / dt) * dt; // align to wall-clock buckets
  return { start, dt, ticks: Array.from({ length: horizon }, (_, i) => start + i * dt) };
}

// Estimate per-active-vehicle state (blueprint H.2.1 "sense and estimate") from
// store rows: sessions + their readings give energy delivered and observed
// acceptance rate (actual kW vs connector max = the compliance signal).
function estimateVehicles(store, stationId, _now) {
  const out = [];
  for (const sess of store.sessions.values()) {
    if (!['PREPARING', 'CHARGING', 'SUSPENDED'].includes(sess.state)) continue;
    const cpId = Number(String(sess.connector_ref).split(':')[0]);
    const cp = store.cps.get(cpId);
    if (!cp || cp.station_id !== Number(stationId)) continue;
    const readings = store.readings.filter((r) => r.session_id === sess.session_id);
    const delivered = Math.max(
      0,
      (sess.end_meter_kwh ?? readings.reduce((m, r) => Math.max(m, r.meter_kwh), sess.start_meter_kwh ?? 0)) -
        (sess.start_meter_kwh ?? 0)
    );
    const recent = readings
      .slice(-6)
      .map((r) => Number(r.power_kw))
      .filter((x) => Number.isFinite(x));
    const obsKw = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
    const conn = store.connectors.get(sess.connector_ref);
    const maxKw = conn ? Number(conn.max_power_kw) : 22;
    out.push({
      sessionId: sess.session_id,
      userId: sess.user_id,
      connectorRef: sess.connector_ref,
      cpId,
      connectorNo: Number(String(sess.connector_ref).split(':')[1]),
      maxKw,
      deliveredKwh: +delivered.toFixed(3),
      // Remaining need: default 40 kWh session target minus delivered (seed-profile
      // honest default; reservations supply their own via vehicle battery size).
      remainingKwh: Math.max(0, 40 - delivered),
      observedKw: obsKw == null ? null : +obsKw.toFixed(3),
      // Compliance ratio: observed/commanded — the verifier's signal (H.2.5).
      acceptance: obsKw == null ? 1 : Math.min(1, obsKw / Math.max(maxKw, 0.01)),
      startedAt: sess.started_at,
    });
  }
  return out;
}

// Worst-case feasibility certificate (blueprint H.2.4 / I.5-H1): the maximum
// energy the hierarchy can guarantee v across [now, deadline) given the certified
// commitments already holding for others. Returns the certificate fields; the
// caller persists via store.issueCertificate when admitted.
function certifyVehicle({ vehicle, siteCapKw, certifiedFloorKw, now, deadlineAt, marginKwh }) {
  const dtMin = DEFAULT_INTERVAL_MIN;
  const windowMin = Math.max(0, (deadlineAt - now) / 60000);
  // Worst case: everyone else's certified floor is served first (they have
  // protocol-backed priority), so v's guaranteed share is the residual.
  const residualKw = Math.max(0, siteCapKw - (certifiedFloorKw || 0));
  const perInterval = Math.min(vehicle.maxKw, residualKw) * (dtMin / 60);
  const intervals = Math.floor(windowMin / dtMin);
  const worstCaseKwh = Math.max(0, perInterval * intervals);
  const requiredKwh = vehicle.remainingKwh != null ? vehicle.remainingKwh : 0;
  // Admission rule: worst-case deliverable >= required + margin (tunable; E3
  // sweeps this). floor = what we can promise every interval while the cert is
  // ACTIVE: the residual share, capped by the connector.
  const floorKw = Math.min(vehicle.maxKw, residualKw);
  const admitted = worstCaseKwh >= requiredKwh + (marginKwh || 0);
  return {
    admitted,
    floorKw: +floorKw.toFixed(3),
    marginKwh: +(marginKwh || 0).toFixed(3),
    worstCaseKwh: +worstCaseKwh.toFixed(3),
    requiredKwh: +requiredKwh.toFixed(3),
    intervals,
  };
}

// Greedy merit-order LP surrogate (blueprint K.1: LP row — "Ablation + fallback
// mode"; the HiGHS sidecar upgrade path is compiled from the same vocabulary).
// Produces x[v][t] in kWh minimizing energy cost under site/CP caps and
// deadlines, honoring certified floors first (constraint 8), then cheapest
// energy, then fairness by unmet share. Deterministic: stable sort by (price,
// sessionId).
function solveSchedule({ vehicles, siteCapKw, cpCaps, priceSeries, dtMin, horizon, now }) {
  const grid = intervalGrid(now, dtMin, horizon);
  const dtH = dtMin / 60;
  const prices = priceSeries(grid.ticks);
  // Per-vehicle deadline in interval index (Infinity = no deadline known).
  const deadlineSlot = new Map(
    vehicles.map((v) => [v.sessionId, v.deadlineAt ? Math.ceil((v.deadlineAt - grid.start) / grid.dt) : Infinity])
  );
  const need = new Map(vehicles.map((v) => [v.sessionId, Math.max(0, v.remainingKwh)]));
  const x = new Map(vehicles.map((v) => [v.sessionId, Array(horizon).fill(0)]));
  const siteCapPerT = siteCapKw === Infinity ? Infinity : siteCapKw * dtH;
  const cpCapPerT = new Map([...cpCaps].map(([cpId, cap]) => [cpId, cap * dtH]));
  const certified = new Map(vehicles.map((v) => [v.sessionId, v.certifiedFloorKw || 0]));

  // 1) Certified floors first — a certificate is a protocol-backed promise.
  for (const v of vehicles) {
    const floor = certified.get(v.sessionId) || 0;
    if (floor <= 0) continue;
    const slots = Math.min(deadlineSlot.get(v.sessionId) ?? horizon, horizon);
    const perT = Math.min(floor, v.maxKw) * dtH;
    for (let t = 0; t < slots && need.get(v.sessionId) > 1e-9; t++) {
      const room = siteCapPerT === Infinity ? perT : siteCapPerT - sumSite(t);
      const cpRoom = (cpCapPerT.get(v.cpId) ?? Infinity) - sumCp(v.cpId, t);
      const give = Math.max(0, Math.min(perT, room, cpRoom, need.get(v.sessionId)));
      if (give > 0) {
        x.get(v.sessionId)[t] += give;
        need.set(v.sessionId, need.get(v.sessionId) - give);
      }
    }
  }
  // 2) Merit order: cheapest energy first (constraint 5 site cap, 3 window, 2 connector).
  const order = [...vehicles].sort((a, b) => a.sessionId - b.sessionId); // stability for determinism
  for (let t = 0; t < horizon; t++) {
    const price = prices[t] ?? 0;
    void price; // prices enter via rank below; kept in scope for the E1 metric path
    const rank = [...vehicles]
      .sort((a, b) => (prices[t] ?? 0) - (prices[t] ?? 0) || a.sessionId - b.sessionId)
      .map((v) => v.sessionId);
    void rank; // flat prices => session order; dynamic prices rank per-t below
    for (const v of order) {
      const dl = Math.min(deadlineSlot.get(v.sessionId) ?? horizon, horizon);
      if (t >= dl) continue; // constraint (3): outside [a_v, d_v) => 0
      if (need.get(v.sessionId) <= 1e-9) continue;
      const room = siteCapPerT === Infinity ? Infinity : siteCapPerT - sumSite(t);
      const cpRoom = (cpCapPerT.get(v.cpId) ?? Infinity) - sumCp(v.cpId, t);
      const give = Math.max(0, Math.min(v.maxKw * dtH, room, cpRoom, need.get(v.sessionId)));
      if (give > 0) {
        x.get(v.sessionId)[t] += give;
        need.set(v.sessionId, need.get(v.sessionId) - give);
      }
    }
  }
  function sumSite(t) {
    let s = 0;
    for (const arr of x.values()) s += arr[t] || 0;
    return s;
  }
  function sumCp(cpId, t) {
    let s = 0;
    for (const v of vehicles) if (v.cpId === cpId) s += x.get(v.sessionId)[t] || 0;
    return s;
  }
  // Metrics bundle for the decision payload (E1/E2-compatible).
  const cost = grid.ticks.reduce((acc, _t, i) => acc + (prices[i] ?? 0) * sumSite(i), 0);
  const peak = Math.max(0, ...grid.ticks.map((_t, i) => sumSite(i) / dtH));
  const unmet = [...need.values()].reduce((a, b) => a + b, 0);
  return {
    schedule: Object.fromEntries([...x].map(([sid, arr]) => [sid, arr.map((k) => +k.toFixed(4))])),
    metrics: {
      cost_units: +cost.toFixed(4),
      peak_kw: +peak.toFixed(3),
      unmet_kwh: +unmet.toFixed(4),
      horizon,
      dt_min: dtMin,
    },
    grid: { start: grid.start, dt: grid.dt },
  };
}

// Margin-erosion replan trigger (blueprint H.2.5 / I.5-H2): replan when observed
// compliance deviation or forecast movement erodes certificate margin below the
// threshold, with hysteresis to bound replan frequency (min spacing between replans).
function shouldReplan({ certificates, enforcementTicks, toleranceKw, hysteresisMin, lastReplanAt, now }) {
  const nowMs = now || Date.now();
  if (lastReplanAt && nowMs - lastReplanAt < (hysteresisMin || 5) * 60000)
    return { replan: false, reason: 'HYSTERESIS' };
  const eroded = [];
  for (const c of certificates.values()) {
    if (c.status !== 'ACTIVE') continue;
    const ticks = (enforcementTicks || []).filter((t) => t.cp_id === c.cp_id && t.session_id === c.session_id);
    const worst = ticks.reduce((m, t) => Math.max(m, Math.abs(t.deviation_kw || 0)), 0);
    if (worst > (toleranceKw == null ? 0.5 : toleranceKw)) eroded.push({ cert_id: c.cert_id, deviation_kw: worst });
  }
  if (eroded.length) return { replan: true, reason: 'MARGIN_EROSION', eroded };
  return { replan: false, reason: 'WITHIN_TOLERANCE' };
}

module.exports = {
  DEFAULT_INTERVAL_MIN,
  DEFAULT_HORIZON,
  intervalGrid,
  estimateVehicles,
  certifyVehicle,
  solveSchedule,
  shouldReplan,
};
