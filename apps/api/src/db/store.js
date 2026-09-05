// VoltHub in-process OLTP store — mirrors Oracle V001 tables + V003 package
// semantics in JS so `npm run dev/test` works without Docker. Production uses
// Oracle via node-oracledb with identical procedure names; this file is the
// reference implementation of BR-01..14 + error bands (-205xx..-209xx).
'use strict';
const crypto = require('crypto');
const { legalTransition } = require('@volthub/shared');

function err(code, message, status) { const e = new Error(message); e.code = code; e.status = status; return e; }
// Oracle error numbers preserved for API mapping + viva traceability.
const ORA = {
  INVALID_WINDOW: -20501, NOT_BOOKABLE: -20502, OVERLAP: -20503, CANCEL_CONFLICT: -20504,
  ILLEGAL_TRANSITION: -20601, METER_REGRESSION: -20602, TICK_REJECTED: -20603,
  NO_TARIFF_BAND: -20701, BILL_CONFLICT: -20702, BILLING_CONFLICT: -20703,
  PAY_CONFLICT: -20704, INSUFFICIENT_FUNDS: -20705, CONNECTOR_GUARD: -20801,
};

// Simple async mutex per key (models SELECT ... FOR UPDATE serialization).
class Mutex {
  constructor() { this.q = new Map(); }
  async run(key, fn) {
    const prev = this.q.get(key) || Promise.resolve();
    let release; const cur = new Promise(r => (release = r));
    this.q.set(key, prev.then(() => cur));
    await prev;
    try { return await fn(); } finally { release(); if (this.q.get(key) === cur) this.q.delete(key); }
  }
}

function hashPassword(pw) {
  // Prod: Argon2id (19MiB,2,1) PHC in app_user.password_hash. Local: scrypt PHC-shaped.
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `$scrypt$${salt}$${h}`;
}
function verifyPassword(pw, stored) {
  if (!stored.startsWith('$scrypt$')) return false;
  const [, , salt, h] = stored.split('$');
  return crypto.timingSafeEqual(Buffer.from(crypto.scryptSync(pw, salt, 32).toString('hex')), Buffer.from(h));
}

function createStore() {
  const s = {
    seq: { user: 0, vehicle: 0, station: 0, cp: 0, plan: 0, band: 0, res: 0, sess: 0, inv: 0, pay: 0, fault: 0, maint: 0, review: 0, notif: 0, audit: 0, outbox: 0 },
    users: new Map(), wallets: new Map(), ledgers: [], vehicles: new Map(), vehicleStd: [],
    stations: new Map(), amenities: [], cps: new Map(), cpsByOcpp: new Map(), connectors: new Map(),
    plans: new Map(), bands: [],
    reservations: new Map(), sessions: new Map(), readings: [],
    invoices: new Map(), lines: [], payments: new Map(),
    faults: new Map(), maint: new Map(), reviews: new Map(), notifs: [],
    audit: [], outbox: [], idem: new Map(), refresh: new Map(),
    // DA3 projection (TimescaleDB in prod; in-process rollup locally)
    ticks: [], stateEvents: [],
    mutex: new Mutex(),
  };
  const ref = (cp, no) => `${cp}:${no}`;
  s._ref = ref;

  // ---- lookups ----
  s.standards = [
    { standard_id: 1, code: 'TYPE2', display_name: 'Type 2 AC', max_typical_kw: 22 },
    { standard_id: 2, code: 'CCS2', display_name: 'CCS Combo 2 DC', max_typical_kw: 150 },
    { standard_id: 3, code: 'CHADEMO', display_name: 'CHAdeMO DC', max_typical_kw: 62.5 },
    { standard_id: 4, code: 'BHARAT_AC001', display_name: 'Bharat AC-001', max_typical_kw: 3.3 },
    { standard_id: 5, code: 'BHARAT_DC001', display_name: 'Bharat DC-001', max_typical_kw: 15 },
  ];

  // ---- helpers ----
  s.auditLog = (actor, entity, id, action, o, n) => {
    s.audit.push({ audit_id: ++s.seq.audit, actor_user_id: actor ?? null, entity_name: entity, entity_id: String(id), action, old_value: o ?? null, new_value: n ?? null, created_at: new Date().toISOString() });
  };
  s.emitOutbox = (kind, dedupe, payload) => {
    if (s.outbox.some(e => e.dedupe_key === dedupe)) return; // idempotent
    s.outbox.push({ event_id: ++s.seq.outbox, kind, dedupe_key: dedupe, payload, created_at: new Date().toISOString(), processed_at: null });
  };
  s.notify = (uid, kind, title, payload) => {
    s.notifs.push({ notification_id: ++s.seq.notif, user_id: uid, kind, title, payload, is_read: 'N', created_at: new Date().toISOString() });
  };
  s.getConnector = (cp, no) => {
    const c = s.connectors.get(ref(cp, no));
    if (!c) throw err('INVALID_CONNECTOR', `unknown connector ${cp}:${no}`, 404);
    return c;
  };

  // ---- users/wallet ----
  s.createUser = ({ email, password, full_name, role = 'DRIVER', phone }) => {
    for (const u of s.users.values()) if (u.email === email) throw err('DUPLICATE_EMAIL', 'email taken', 409);
    const user_id = ++s.seq.user;
    const u = { user_id, email, password_hash: hashPassword(password), full_name, phone: phone || null, role, status: 'ACTIVE', created_at: new Date().toISOString() };
    s.users.set(user_id, u);
    if (role === 'DRIVER' && !s.wallets.has(user_id)) {
      s.wallets.set(user_id, { user_id, balance: 0, currency: 'INR', updated_at: new Date().toISOString() });
    }
    s.auditLog(null, 'APP_USER', user_id, 'CREATE', null, { email, role });
    return u;
  };
  s.topup = (uid, amount) => {
    if (!(amount > 0)) throw err('INVALID_AMOUNT', 'amount > 0', 422);
    const w = s.wallets.get(uid) || { user_id: uid, balance: 0, currency: 'INR' };
    const seq = s.ledgers.filter(l => l.user_id === uid).length + 1;
    w.balance = +(w.balance + amount).toFixed(2); w.updated_at = new Date().toISOString();
    s.wallets.set(uid, w);
    s.ledgers.push({ user_id: uid, seq_no: seq, kind: 'TOPUP', amount, balance_after: w.balance, payment_id: null, note: 'top-up', created_at: new Date().toISOString() });
    return w;
  };

  // ---- RESERVATION_PKG.create_reservation (BR-04/05/12, ORA -2050x) ----
  s.createReservation = async (uid, vehicleId, cpId, connNo, startAt, endAt) => {
    const key = ref(cpId, connNo);
    return s.mutex.run('conn:' + key, async () => {
      const start = new Date(startAt), end = new Date(endAt);
      const mins = (end - start) / 60000;
      if (!(end > start) || mins < 15 || mins > 120 || start.getTime() < Date.now() - 60000) {
        const e = new Error('INVALID_WINDOW: reservation must be 15-120 min in the future');
        e.num = ORA.INVALID_WINDOW; e.code = 'INVALID_WINDOW'; e.status = 422; throw e;
      }
      const c = s.getConnector(cpId, connNo);
      if (!['AVAILABLE', 'RESERVED'].includes(c.status)) {
        const e = new Error(`NOT_BOOKABLE: connector ${key} is ${c.status}`);
        e.num = ORA.NOT_BOOKABLE; e.code = 'NOT_BOOKABLE'; e.status = 409; throw e;
      }
      for (const r of s.reservations.values()) {
        if (r.connector_ref === key && ['BOOKED', 'CONVERTED'].includes(r.status)
          && new Date(r.start_at) < end && new Date(r.end_at) > start) {
          const e = new Error(`OVERLAP: connector ${key} already booked in window`);
          e.num = ORA.OVERLAP; e.code = 'OVERLAP'; e.status = 409; throw e;
        }
      }
      const reservation_id = ++s.seq.res;
      const r = { reservation_id, connector_ref: key, user_id: uid, vehicle_id: vehicleId || null, start_at: start.toISOString(), end_at: end.toISOString(), status: 'BOOKED', created_at: new Date().toISOString() };
      s.reservations.set(reservation_id, r);
      const from = c.status; c.status = 'RESERVED'; c.last_state_change_at = new Date().toISOString();
      s.emitOutbox('CONNECTOR_STATE', `connstate:${key}:${reservation_id}`, { connector_ref: key, from, to: 'RESERVED', cause: 'RESERVATION', reservation_id });
      s.stateEvents.push({ ts: new Date().toISOString(), connector_ref: key, from_state: from, to_state: 'RESERVED', cause: 'RESERVATION', session_id: null });
      s.auditLog(uid, 'RESERVATION', reservation_id, 'CREATE', null, { connector_ref: key });
      s.notify(uid, 'RESERVATION', 'Reservation confirmed', { reservation_id, connector_ref: key });
      return r;
    });
  };
  s.cancelReservation = async (rid, actor, role, scopeStations) => {
    return s.mutex.run('res:' + rid, async () => {
      const r = s.reservations.get(Number(rid));
      if (!r) throw err('NOT_FOUND', 'reservation not found', 404);
      if (role === 'DRIVER' && r.user_id !== actor) throw err('FORBIDDEN', 'not your booking', 403);
      if (r.status !== 'BOOKED') { const e = new Error('CANCEL_CONFLICT'); e.num = ORA.CANCEL_CONFLICT; e.code = 'CANCEL_CONFLICT'; e.status = 409; throw e; }
      r.status = 'CANCELLED';
      const [cp, no] = r.connector_ref.split(':').map(Number);
      const c = s.connectors.get(r.connector_ref);
      if (c && c.status === 'RESERVED') { c.status = 'AVAILABLE'; c.last_state_change_at = new Date().toISOString(); }
      s.auditLog(actor, 'RESERVATION', rid, 'CANCEL', 'BOOKED', 'CANCELLED');
      return r;
    });
  };
  s.expireStale = async () => {
    let n = 0;
    const cutoff = Date.now() - 15 * 60000;
    for (const r of s.reservations.values()) {
      if (r.status === 'BOOKED' && new Date(r.start_at).getTime() < cutoff) {
        r.status = 'EXPIRED'; n++;
        const c = s.connectors.get(r.connector_ref);
        if (c && c.status === 'RESERVED') c.status = 'AVAILABLE';
      }
    }
    return n;
  };

  // ---- CHARGE_SESSION_PKG ----
  s.startSession = async ({ uid, vehicleId, cpId, connNo, planId, reservationId, idTag }) => {
    const key = ref(cpId, connNo);
    return s.mutex.run('conn:' + key, async () => {
      const c = s.getConnector(cpId, connNo);
      if (!['AVAILABLE', 'RESERVED'].includes(c.status)) {
        const e = new Error(`NOT_BOOKABLE: connector ${key} is ${c.status}`);
        e.num = ORA.NOT_BOOKABLE; e.code = 'NOT_BOOKABLE'; e.status = 409; throw e;
      }
      const session_id = ++s.seq.sess;
      const sess = { session_id, user_id: uid, vehicle_id: vehicleId || null, reservation_id: reservationId || null, connector_ref: key, tariff_plan_id: planId, id_tag: idTag || null, state: 'PREPARING', billing_state: 'UNBILLED', started_at: new Date().toISOString(), ended_at: null, start_meter_kwh: 0, end_meter_kwh: null, energy_kwh: null, stop_reason: null };
      s.sessions.set(session_id, sess);
      if (reservationId) { const r = s.reservations.get(Number(reservationId)); if (r) r.status = 'CONVERTED'; }
      const from = c.status; c.status = 'OCCUPIED'; c.last_state_change_at = new Date().toISOString();
      s.stateEvents.push({ ts: new Date().toISOString(), connector_ref: key, from_state: from, to_state: 'OCCUPIED', cause: 'OCPP', session_id });
      s.emitOutbox('SESSION_EVENT', `sess:${session_id}:PREPARING:${Date.now()}`, { session_id, from: 'RESERVED', to: 'PREPARING' });
      s.auditLog(uid, 'CHARGING_SESSION', session_id, 'START', null, { connector_ref: key });
      return sess;
    });
  };
  s.transition = async (sid, to, reason) => {
    return s.mutex.run('sess:' + sid, async () => {
      const sess = s.sessions.get(Number(sid));
      if (!sess) throw err('NOT_FOUND', 'session not found', 404);
      if (!legalTransition(sess.state, to)) {
        const e = new Error(`ILLEGAL_TRANSITION: ${sess.state} -> ${to}`);
        e.num = ORA.ILLEGAL_TRANSITION; e.code = 'ILLEGAL_TRANSITION'; e.status = 409; throw e;
      }
      const from = sess.state; sess.state = to; sess.stop_reason = reason || sess.stop_reason;
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(to)) sess.ended_at = new Date().toISOString();
      const c = s.connectors.get(sess.connector_ref);
      if (c) {
        if (to === 'CHARGING') c.status = 'OCCUPIED';
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(to)) c.status = 'AVAILABLE';
        c.last_state_change_at = new Date().toISOString();
      }
      s.emitOutbox('SESSION_EVENT', `sess:${sid}:${to}:${Date.now()}`, { session_id: Number(sid), from, to });
      s.auditLog(null, 'CHARGING_SESSION', sid, 'TRANSITION', from, to);
      return sess;
    });
  };
  s.recordTick = async (sid, seq, at, kwh, kw, v, a) => {
    return s.mutex.run('sess:' + sid, async () => {
      const sess = s.sessions.get(Number(sid));
      if (!sess) throw err('NOT_FOUND', 'session not found', 404);
      if (!['PREPARING', 'CHARGING', 'SUSPENDED'].includes(sess.state)) {
        const e = new Error('TICK_REJECTED: session not active'); e.num = ORA.TICK_REJECTED; e.code = 'TICK_REJECTED'; e.status = 409; throw e;
      }
      if (s.readings.some(r => r.session_id === Number(sid) && r.seq_no === seq)) return { deduped: true }; // idempotent replay
      const last = s.readings.filter(r => r.session_id === Number(sid)).reduce((m, r) => Math.max(m, r.meter_kwh), -1);
      if (kwh < last - 0.001) { const e = new Error('METER_REGRESSION'); e.num = ORA.METER_REGRESSION; e.code = 'METER_REGRESSION'; e.status = 409; throw e; }
      const ts = at ? new Date(at).toISOString() : new Date().toISOString();
      s.readings.push({ session_id: Number(sid), seq_no: seq, taken_at: ts, meter_kwh: kwh, power_kw: kw ?? null, voltage_v: v ?? null, current_a: a ?? null, source: 'OCPP' });
      if (sess.state === 'PREPARING' && seq >= 1) sess.state = 'CHARGING';
      s.emitOutbox('METER_TICK', `tick:${sid}:${seq}`, { session_id: Number(sid), seq, connector_ref: sess.connector_ref, meter_kwh: kwh, power_kw: kw ?? null, ts });
      s.ticks.push({ ts, session_id: Number(sid), connector_ref: sess.connector_ref, meter_kwh: kwh, power_kw: kw ?? null, voltage_v: v ?? null, current_a: a ?? null });
      return { ok: true };
    });
  };
  s.stopSession = async (sid, reason) => {
    const sess = s.sessions.get(Number(sid));
    if (!sess) throw err('NOT_FOUND', 'session not found', 404);
    const peak = s.readings.filter(r => r.session_id === Number(sid)).reduce((m, r) => Math.max(m, r.meter_kwh), 0);
    sess.end_meter_kwh = peak;
    // CHARGING->COMPLETED directly, or via SUSPENDED
    if (sess.state === 'SUSPENDED' || sess.state === 'CHARGING' || sess.state === 'PREPARING') {
      return s.transition(sid, sess.state === 'PREPARING' ? 'CANCELLED' : 'COMPLETED', reason || 'REMOTE_STOP');
    }
    return sess;
  };

  // ---- TARIFF/BILLING ----
  s.resolveBandPrice = (planId, at) => {
    const d = new Date(at); const dow = d.getDay(); // 0 Sun
    const mins = d.getHours() * 60 + d.getMinutes();
    const cands = s.bands.filter(b => b.plan_id === Number(planId) && (
      b.day_scope === 'ALL' || (b.day_scope === 'WEEKDAY' && dow >= 1 && dow <= 5) || (b.day_scope === 'WEEKEND' && (dow === 0 || dow === 6))));
    const toMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
    const hit = cands.find(b => mins >= toMin(b.start_time) && mins < toMin(b.end_time));
    if (!hit) { const e = new Error('NO_TARIFF_BAND'); e.num = ORA.NO_TARIFF_BAND; e.code = 'NO_TARIFF_BAND'; e.status = 422; throw e; }
    return hit.price_per_kwh;
  };
  s.billSession = async (sid) => {
    return s.mutex.run('sess:' + sid, async () => {
      const sess = s.sessions.get(Number(sid));
      if (!sess) throw err('NOT_FOUND', 'session not found', 404);
      if (sess.state !== 'COMPLETED') { const e = new Error('BILL_CONFLICT: session not COMPLETED'); e.num = ORA.BILL_CONFLICT; e.code = 'BILL_CONFLICT'; e.status = 409; throw e; }
      if (sess.billing_state !== 'UNBILLED') { const e = new Error('BILLING_CONFLICT'); e.num = ORA.BILLING_CONFLICT; e.code = 'BILLING_CONFLICT'; e.status = 409; throw e; }
      const energy = Math.max((sess.end_meter_kwh ?? 0) - (sess.start_meter_kwh ?? 0), 0);
      const price = s.resolveBandPrice(sess.tariff_plan_id, sess.started_at);
      const plan = s.plans.get(Number(sess.tariff_plan_id));
      const energyAmt = +(energy * price).toFixed(2);
      const fee = plan ? +plan.session_fee : 0;
      const total = +(energyAmt + fee).toFixed(2);
      const invoice_id = ++s.seq.inv;
      s.invoices.set(invoice_id, { invoice_id, session_id: Number(sid), tariff_plan_id: sess.tariff_plan_id, status: 'DUE', total, currency: 'INR', issued_at: new Date().toISOString() });
      s.lines.push({ invoice_id, line_no: 1, kind: 'ENERGY', description: `Energy ${energy.toFixed(3)} kWh @ Rs.${price}`, quantity: +energy.toFixed(3), unit: 'kWh', unit_price: price, amount: energyAmt });
      if (fee > 0) s.lines.push({ invoice_id, line_no: 2, kind: 'SESSION_FEE', description: 'Session fee', quantity: 1, unit: null, unit_price: fee, amount: fee });
      sess.billing_state = 'BILLED'; sess.energy_kwh = +energy.toFixed(3);
      s.auditLog(null, 'INVOICE', invoice_id, 'ISSUE', null, { session: sid, total });
      s.notify(sess.user_id, 'BILLING', 'Invoice issued', { invoice_id, total });
      return s.invoices.get(invoice_id);
    });
  };
  s.payInvoice = async (invId, uid) => {
    return s.mutex.run('inv:' + invId, async () => {
      const inv = s.invoices.get(Number(invId));
      if (!inv) throw err('NOT_FOUND', 'invoice not found', 404);
      if (inv.status !== 'DUE') { const e = new Error('PAY_CONFLICT'); e.num = ORA.PAY_CONFLICT; e.code = 'PAY_CONFLICT'; e.status = 409; throw e; }
      const w = s.wallets.get(uid) || { user_id: uid, balance: 0, currency: 'INR' };
      s.wallets.set(uid, w);
      if (w.balance < inv.total) {
        const payment_id = ++s.seq.pay;
        s.payments.set(payment_id, { payment_id, invoice_id: Number(invId), amount: inv.total, method: 'WALLET', status: 'FAILED', reference: null, created_at: new Date().toISOString() });
        inv.status = 'FAILED';
        const e = new Error('INSUFFICIENT_FUNDS'); e.num = ORA.INSUFFICIENT_FUNDS; e.code = 'INSUFFICIENT_FUNDS'; e.status = 402; throw e;
      }
      const seq = s.ledgers.filter(l => l.user_id === uid).length + 1;
      const payment_id = ++s.seq.pay;
      s.payments.set(payment_id, { payment_id, invoice_id: Number(invId), amount: inv.total, method: 'WALLET', status: 'SUCCESS', reference: `WLT-${Date.now()}`, created_at: new Date().toISOString() });
      s.ledgers.push({ user_id: uid, seq_no: seq, kind: 'PAYMENT', amount: -inv.total, balance_after: +(w.balance - inv.total).toFixed(2), payment_id, note: `Invoice ${invId}`, created_at: new Date().toISOString() });
      w.balance = +(w.balance - inv.total).toFixed(2); w.updated_at = new Date().toISOString();
      inv.status = 'PAID';
      s.auditLog(uid, 'INVOICE', invId, 'PAY', 'DUE', 'PAID');
      return s.payments.get(payment_id);
    });
  };
  return s;
}

module.exports = { createStore, hashPassword, verifyPassword, ORA };
