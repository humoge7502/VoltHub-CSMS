// ADR-0010 / FC-HCC model vocabulary (blueprint K.2): the shared language for
// estimator -> certifier -> arbiter -> compiler. Pure data shapes + the
// deterministic schedule assembler shared by every stage — no I/O, no store access.
// Determinism rule (ADR-0008): identical inputs => identical schedule, always.
'use strict';

// Default control cadence (blueprint K.4): 15-minute intervals, 24-interval horizon.
const DEFAULT_INTERVAL_MIN = 15;
const DEFAULT_HORIZON = 24;

// Honest fallback when neither the vehicle nor a reservation declares a target:
// a documented default beats an invented one. Callers pass requirementKwhFor()
// to replace it (controller derives it from vehicle battery + target SoC).
const DEFAULT_SESSION_KWH = 40;

// Build the interval grid [t0, t0+H*dt) as epoch-ms ticks.
function intervalGrid(now, dtMin, horizon) {
  const dt = dtMin * 60000;
  const start = Math.floor(now / dt) * dt; // align to wall-clock buckets
  return { start, dt, ticks: Array.from({ length: horizon }, (_, i) => start + i * dt) };
}

// Estimate per-active-vehicle state (blueprint H.2.1 "sense and estimate") from
// store rows: sessions + their readings give energy delivered and observed
// acceptance rate (actual kW vs connector max = the compliance signal).
// opts.requirementKwhFor(session, deliveredKwh) -> kWh | null is the pluggable
// requirement source (vehicle battery + target SoC in the controller); null keeps
// the documented default.
function estimateVehicles(store, stationId, now, opts = {}) {
  const out = [];
  for (const sess of store.sessions.values()) {
    if (!['PREPARING', 'CHARGING', 'SUSPENDED'].includes(sess.state)) continue;
    const cpId = Number(String(sess.connector_ref).split(':')[0]);
    const cp = store.cps.get(cpId);
    if (!cp || cp.station_id !== Number(stationId)) continue;
    // O(1) amortized: indexed per-session reading lookup (store.readingsFor) instead of
    // an O(total readings) scan per session, which is quadratic across a fleet.
    const readings = store.readingsFor
      ? store.readingsFor(sess.session_id)
      : store.readings.filter((r) => r.session_id === sess.session_id);
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
    // Two supported requirement sources, in priority order: the richer
    // vehicleStateFor (energy + battery + SoC reference, which lets the certifier be
    // taper-aware) and the legacy requirementKwhFor (energy only).
    const state = typeof opts.vehicleStateFor === 'function' ? opts.vehicleStateFor(sess, delivered) : null;
    const declared =
      state && state.requiredKwh != null
        ? state.requiredKwh
        : typeof opts.requirementKwhFor === 'function'
          ? opts.requirementKwhFor(sess, delivered)
          : null;
    const requiredTotal =
      declared != null && Number.isFinite(Number(declared)) ? Number(declared) : DEFAULT_SESSION_KWH;
    out.push({
      sessionId: sess.session_id,
      userId: sess.user_id,
      connectorRef: sess.connector_ref,
      cpId,
      connectorNo: Number(String(sess.connector_ref).split(':')[1]),
      maxKw,
      deliveredKwh: +delivered.toFixed(3),
      remainingKwh: +Math.max(0, requiredTotal - delivered).toFixed(3),
      requirementSource: declared != null ? 'declared' : 'default',
      batteryKwh: state && Number(state.batteryKwh) > 0 ? Number(state.batteryKwh) : null,
      socRef: state && state.socRef != null ? Number(state.socRef) : null,
      observedKw: obsKw == null ? null : +obsKw.toFixed(3),
      // Compliance ratio: observed/commanded — the verifier's signal (H.2.5).
      acceptance: obsKw == null ? 1 : Math.min(1, obsKw / Math.max(maxKw, 0.01)),
      startedAt: sess.started_at,
    });
  }
  return out;
}

// CC-CV acceptance factor: full power to the taper knee, then decay to `floor`.
// Not a battery model — a clearly labelled approximation whose only job is to make
// "22 kW is not deliverable at 95% SoC" true, in ONE place, so the promise (this file)
// and the experiment (apps/simulator/src/twin.js, which imports it) can never disagree
// about the physics they both claim.
function acceptanceFactor(soc, { knee = 0.8, floor = 0.15 } = {}) {
  if (soc == null) return 1;
  if (soc <= knee) return 1;
  if (soc >= 1) return floor;
  const span = 1 - knee;
  return floor + (1 - floor) * (1 - (soc - knee) / span);
}

// Worst-case feasibility certificate (blueprint H.2.4 / I.5-H1): the maximum
// energy the hierarchy can guarantee v across [now, deadline) given the certified
// commitments already holding for others. Returns the certificate fields; the
// caller persists via store.issueCertificate when admitted.
//
// The simulation is deliberately pessimistic on two independent axes: (1) everyone
// else's certified floors are served first, so v only ever gets the residual; (2) when
// the battery state is known, acceptance tapers with the SoC reached, so a promise made
// at 20% SoC is not silently reused at 95%. `vehicle.socRef` is the SoC reference the
// promise is graded against (the caller passes the target SoC when the current one is
// unknown, which is the conservative choice).
function certifyVehicle({ vehicle, siteCapKw, certifiedFloorKw, now, deadlineAt, marginKwh }) {
  const dtMin = DEFAULT_INTERVAL_MIN;
  const dtH = dtMin / 60;
  const windowMin = deadlineAt ? Math.max(0, (deadlineAt - now) / 60000) : dtMin * DEFAULT_HORIZON;
  const residualKw = Math.max(0, siteCapKw - (certifiedFloorKw || 0));
  const intervals = Math.max(1, Math.floor(windowMin / dtMin));
  const requiredKwh = vehicle.remainingKwh != null ? vehicle.remainingKwh : 0;
  const target = requiredKwh + (marginKwh || 0);
  const batteryKwh = Number(vehicle.batteryKwh) > 0 ? Number(vehicle.batteryKwh) : null;
  let soc = batteryKwh ? Number(vehicle.socRef != null ? vehicle.socRef : 0) : null;

  let worstCaseKwh = 0;
  let lastRateKw = Math.min(vehicle.maxKw, residualKw);
  for (let i = 0; i < intervals; i++) {
    const taper = batteryKwh ? acceptanceFactor(soc) : 1;
    const rateKw = Math.min(vehicle.maxKw * taper, residualKw);
    const kwh = rateKw * dtH;
    worstCaseKwh += kwh;
    lastRateKw = rateKw;
    if (batteryKwh && soc != null) soc = Math.min(1, soc + kwh / batteryKwh);
    if (worstCaseKwh >= target) break; // enough to cover the promise; no need to simulate on
  }
  // Flat floor promise: the rate the vehicle is still guaranteed at the END of the
  // simulated window (acceptance is non-increasing, so the last rate bounds every
  // earlier one). Conservative by construction — a promise that decays is worse than
  // an honest floor.
  const floorKw = lastRateKw;
  const admitted = worstCaseKwh >= target;
  return {
    admitted,
    floorKw: +floorKw.toFixed(3),
    marginKwh: +(marginKwh || 0).toFixed(3),
    worstCaseKwh: +worstCaseKwh.toFixed(3),
    requiredKwh: +requiredKwh.toFixed(3),
    slackKwh: +(worstCaseKwh - target).toFixed(3),
    intervals,
    taperAware: !!batteryKwh,
  };
}

// Deterministic schedule assembler. Three ordered passes, each with a stated job:
//
//   Pass 1 — certified floors: a certificate is a protocol-backed promise, so it is
//            served before any economic consideration (constraint 8).
//   Pass 2 — feasibility fill (EDF): charge in deadline order to satisfy every
//            remaining energy requirement by its deadline wherever capacity allows
//            (constraint 3 first, because a missed deadline is not repairable).
//   Pass 3 — cost shift: move energy out of expensive intervals into cheaper ones
//            that still precede the deadline and have headroom (constraint 5 site
//            cap + constraint 2 charger cap re-checked on every move).
//
// Feasibility-first then cost-improving is deliberate: a pure price-greedy pass can
// starve an urgent vehicle to save cents, and a pure EDF pass ignores the tariff.
// This is a heuristic, not the optimum — the perfect-foresight LP remains the
// reference upper bound in benchmarks (ADR-0013), and the shipped solver is the
// one the benchmark measures (single source of truth).
// Deterministic: every ordering breaks ties on sessionId.
function solveSchedule({ vehicles, siteCapKw, cpCaps, priceSeries, dtMin, horizon, now }) {
  const grid = intervalGrid(now, dtMin, horizon);
  const dtH = dtMin / 60;
  const prices = priceSeries(grid.ticks);
  const deadlineSlot = new Map(
    vehicles.map((v) => [v.sessionId, v.deadlineAt ? Math.ceil((v.deadlineAt - grid.start) / grid.dt) : Infinity])
  );
  // Arrival window (constraint 3, lower bound): a vehicle that plugs in at t_a cannot
  // be charged before t_a. Sessions already active default to slot 0; experiments with
  // future arrivals set `arrivalAt`, which is what makes a horizon simulation honest
  // (without it the planner would happily pre-charge a car that has not arrived).
  const arrivalSlot = new Map(
    vehicles.map((v) => [v.sessionId, v.arrivalAt ? Math.max(0, Math.floor((v.arrivalAt - grid.start) / grid.dt)) : 0])
  );
  const need = new Map(vehicles.map((v) => [v.sessionId, Math.max(0, v.remainingKwh)]));
  const x = new Map(vehicles.map((v) => [v.sessionId, Array(horizon).fill(0)]));
  const siteCapPerT = siteCapKw === Infinity ? Infinity : siteCapKw * dtH;
  const cpCapPerT = new Map([...cpCaps].map(([cpId, cap]) => [cpId, cap * dtH]));
  const certified = new Map(vehicles.map((v) => [v.sessionId, v.certifiedFloorKw || 0]));
  const byCp = new Map();
  for (const v of vehicles) {
    if (!byCp.has(v.cpId)) byCp.set(v.cpId, []);
    byCp.get(v.cpId).push(v.sessionId);
  }
  const sumSite = (t) => {
    let s2 = 0;
    for (const arr of x.values()) s2 += arr[t] || 0;
    return s2;
  };
  const sumCp = (cpId, t) => {
    let s2 = 0;
    for (const sid of byCp.get(cpId) || []) s2 += x.get(sid)[t] || 0;
    return s2;
  };
  // Headroom left in interval t for a vehicle on cpId (Infinity = uncapped).
  const roomAt = (t, cpId) => {
    const siteRoom = siteCapPerT === Infinity ? Infinity : siteCapPerT - sumSite(t);
    const cpRoom = (cpCapPerT.get(cpId) ?? Infinity) - sumCp(cpId, t);
    return Math.max(0, Math.min(siteRoom, cpRoom));
  };
  const dl = (sid) => Math.min(deadlineSlot.get(sid) ?? horizon, horizon);
  const av = (sid) => arrivalSlot.get(sid) ?? 0;
  const give = (v, t, kwh) => {
    if (t < av(v.sessionId) || t >= dl(v.sessionId)) return 0;
    const amount = Math.max(0, Math.min(kwh, roomAt(t, v.cpId), need.get(v.sessionId)));
    if (amount <= 1e-9) return 0;
    x.get(v.sessionId)[t] += amount;
    need.set(v.sessionId, need.get(v.sessionId) - amount);
    return amount;
  };

  // Pass 1 — certified floors, chronological (a promise starts now, not when cheap).
  for (const v of [...vehicles].sort((a, b) => a.sessionId - b.sessionId)) {
    const floor = certified.get(v.sessionId) || 0;
    if (floor <= 0) continue;
    const perT = Math.min(floor, v.maxKw) * dtH;
    for (let t = av(v.sessionId); t < dl(v.sessionId) && need.get(v.sessionId) > 1e-9; t++) give(v, t, perT);
  }

  // Pass 2 — EDF feasibility fill (earliest deadline first, then sessionId).
  const edf = [...vehicles].sort((a, b) => dl(a.sessionId) - dl(b.sessionId) || a.sessionId - b.sessionId);
  for (let t = 0; t < horizon; t++) {
    for (const v of edf) {
      if (t < av(v.sessionId) || t >= dl(v.sessionId) || need.get(v.sessionId) <= 1e-9) continue;
      give(v, t, v.maxKw * dtH);
    }
  }

  // Pass 3 — cost shift: expensive intervals give way to cheaper pre-deadline slots.
  const priceOrder = Array.from({ length: horizon }, (_v, t) => t).sort(
    (a, b) => (prices[b] ?? 0) - (prices[a] ?? 0) || a - b
  );
  let shiftedKwh = 0;
  for (const tExp of priceOrder) {
    const target = [...vehicles]
      .filter((v) => (x.get(v.sessionId)[tExp] || 0) > 1e-9)
      .sort((a, b) => a.sessionId - b.sessionId);
    for (const v of target) {
      let movable = x.get(v.sessionId)[tExp] || 0;
      // Only slots in the vehicle's own window are eligible: moving energy earlier than
      // arrival or past the deadline would be a constraint violation painted as savings.
      const cheaper = Array.from({ length: horizon }, (_v, t) => t)
        .filter(
          (t) => t >= av(v.sessionId) && t < dl(v.sessionId) && t !== tExp && (prices[t] ?? 0) < (prices[tExp] ?? 0)
        )
        .sort((a, b) => (prices[a] ?? 0) - (prices[b] ?? 0) || a - b);
      for (const tCheap of cheaper) {
        if (movable <= 1e-9) break;
        // Never move energy into an interval that already holds a vehicle's floor-
        // protected allocation beyond its own cap: roomAt() is the single truth.
        const moved = Math.min(movable, roomAt(tCheap, v.cpId));
        if (moved <= 1e-9) continue;
        x.get(v.sessionId)[tExp] -= moved;
        x.get(v.sessionId)[tCheap] += moved;
        movable -= moved;
        shiftedKwh += moved;
      }
    }
  }

  // Metrics bundle for the decision payload (E1/E2-compatible).
  const cost = grid.ticks.reduce((acc, _t, i) => acc + (prices[i] ?? 0) * sumSite(i), 0);
  const peak = Math.max(0, ...grid.ticks.map((_t, i) => sumSite(i) / dtH));
  const unmet = [...need.values()].reduce((a, b) => a + b, 0);
  const delivered = [...x.values()].reduce((a, arr) => a + arr.reduce((p, q) => p + q, 0), 0);
  return {
    schedule: Object.fromEntries([...x].map(([sid, arr]) => [sid, arr.map((k) => +k.toFixed(4))])),
    metrics: {
      cost_units: +cost.toFixed(4),
      peak_kw: +peak.toFixed(3),
      unmet_kwh: +unmet.toFixed(4),
      delivered_kwh: +delivered.toFixed(4),
      shifted_kwh: +shiftedKwh.toFixed(4),
      deadline_slots: Object.fromEntries([...deadlineSlot].map(([sid, s2]) => [sid, s2 === Infinity ? null : s2])),
      arrival_slots: Object.fromEntries([...arrivalSlot]),
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
  // `0` is a value, not an absence: `hysteresisMin || 5` silently turned "no
  // hysteresis" into the 5-minute default, which made an explicitly immediate replan
  // impossible (and the property test that asserts it unreachable).
  const waitMin = hysteresisMin == null ? 5 : Number(hysteresisMin);
  if (lastReplanAt && nowMs - lastReplanAt < waitMin * 60000) return { replan: false, reason: 'HYSTERESIS' };
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
  DEFAULT_SESSION_KWH,
  intervalGrid,
  acceptanceFactor,
  estimateVehicles,
  certifyVehicle,
  solveSchedule,
  shouldReplan,
};
