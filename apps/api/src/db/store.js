// VoltHub in-process OLTP store — mirrors Oracle V001 tables + V003 package
// semantics in JS so `npm run dev/test` works without Docker. Production uses
// Oracle via node-oracledb with identical procedure names; this file is the
// reference implementation of BR-01..14 + error bands (-205xx..-209xx).
'use strict';
const crypto = require('crypto');
const { legalTransition } = require('@volthub/shared');
const argon2 = require('@node-rs/argon2');
// ADR-0016: the wallet rail owns signature verification. Kept out of the store so the
// crypto primitives have one home (and one test file) instead of being re-implemented
// wherever a signature happens to be checked.
const rail = require('../wallet/rail');

function err(code, message, status) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}
// Oracle error numbers preserved for API mapping + viva traceability.
const ORA = {
  INVALID_WINDOW: -20501,
  NOT_BOOKABLE: -20502,
  OVERLAP: -20503,
  CANCEL_CONFLICT: -20504,
  RESERVATION_MISMATCH: -20505,
  ILLEGAL_TRANSITION: -20601,
  METER_REGRESSION: -20602,
  TICK_REJECTED: -20603,
  NO_TARIFF_BAND: -20701,
  BILL_CONFLICT: -20702,
  BILLING_CONFLICT: -20703,
  PAY_CONFLICT: -20704,
  INSUFFICIENT_FUNDS: -20705,
  CONNECTOR_GUARD: -20801,
  // ADR-0010 grid-control band (V007 triggers + gateway envelope raise these).
  GRID_ASSET_INVALID: -20901,
  GRID_CAP_MONOTONIC: -20902,
  ENVELOPE_REJECTED: -20903,
};

// Simple async mutex per key (models SELECT ... FOR UPDATE serialization).
class Mutex {
  constructor() {
    this.q = new Map();
  }
  async run(key, fn) {
    const prev = this.q.get(key) || Promise.resolve();
    let release;
    const cur = new Promise((r) => (release = r));
    // The map stores the CHAIN, so cleanup must compare against the chain — the old
    // code compared against `cur` (never stored), the comparison never matched, and
    // every key ever locked leaked into the Map forever (review 2026-10-24, B-46).
    const chained = prev.then(() => cur);
    this.q.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.q.get(key) === chained) this.q.delete(key);
    }
  }
}

// Password KDF policy (SECURITY.md / masterplan §15): Argon2id, 19 MiB, t=2,
// p=1 — the OWASP-recommended baseline. New hashes are the standard PHC string
// (`$argon2id$v=19$m=19456,t=2,p=1$…`); verifyPassword still accepts the legacy
// `$scrypt$…` shape so hydrated durable rows (and old seeds) keep logging in.
const ARGON2_POLICY = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

// Relay queue bounds. The outbox is the only structure in the store that grows on
// every telemetry tick, so it needs an explicit retention window (acked rows are
// already durable in Timescale) and a hard cap (a sink outage must not OOM the API).
const OUTBOX_RETENTION_HOURS = Math.max(1, Number(process.env.OUTBOX_RETENTION_HOURS || 24));
const OUTBOX_RETENTION_MS = OUTBOX_RETENTION_HOURS * 3600 * 1000;
const OUTBOX_SOFT_CAP = Math.max(1000, Number(process.env.OUTBOX_SOFT_CAP || 20000));
const OUTBOX_HARD_CAP = Math.max(OUTBOX_SOFT_CAP, Number(process.env.OUTBOX_HARD_CAP || 50000));
// PF-01: retention pruning is housekeeping, not part of the emit contract. Running it
// on every emit while acked rows are younger than the retention window made the queue
// stay above the soft cap forever, so each tick paid a full sort/scan (measured 106
// ticks/s at 20k rows). Debounce the soft-cap attempt; the hard cap still forces it.
const OUTBOX_PRUNE_INTERVAL_MS = Math.max(1000, Number(process.env.OUTBOX_PRUNE_INTERVAL_MS || 60000));
const DEAD_LETTER_CAP = Math.max(50, Number(process.env.DEAD_LETTER_CAP || 1000));

function hashPassword(pw) {
  return argon2.hashSync(String(pw), ARGON2_POLICY);
}

// Legacy local-profile hasher (kept for verify-backward-compat only).
function scryptHashSync(pw, salt) {
  return crypto.scryptSync(pw, salt, 32).toString('hex');
}
function verifyScrypt(pw, stored) {
  const [, , salt, h] = stored.split('$');
  // Length-safe: timingSafeEqual needs equal-length buffers. A malformed/short
  // stored hash (e.g. an old '$scrypt$demo$<user>' placeholder) must read as
  // invalid, never throw ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH on login.
  const got = scryptHashSync(String(pw), salt);
  if (!h || got.length !== h.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(h));
}

function verifyPassword(pw, stored) {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith('$argon2')) {
    // Argon2 PHC verify — malformed strings must read as invalid, never throw.
    try {
      return argon2.verifySync(stored, String(pw));
    } catch {
      return false;
    }
  }
  if (stored.startsWith('$scrypt$')) return verifyScrypt(pw, stored);
  return false;
}

// PERF-002 (mission soak receipt): the SYNC verify burns ~29 ms ON the event loop —
// a login storm freezes OCPP frame handling (100-charger burst => BootNotification
// timeouts). The async variants run the same KDF on the sidecar's thread pool and
// are the hot-path (HTTP login/register) entry points; the sync forms remain for
// seed/store-internal use only.
function scryptAsync(pw, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(String(pw), salt, 32, (err, key) => (err ? reject(err) : resolve(key)))
  );
}
// Review 2026-10-24: the legacy `$scrypt$…` branch still delegated to the SYNC
// verifyScrypt — a pre-Argon2 user logging in blocked the loop anyway.
async function verifyScryptAsync(pw, stored) {
  const [, , salt, h] = String(stored).split('$');
  if (!salt || !h) return false;
  const got = (await scryptAsync(pw, salt)).toString('hex');
  if (got.length !== h.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(h));
  } catch {
    return false;
  }
}
async function verifyPasswordAsync(pw, stored) {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith('$argon2')) {
    try {
      return await argon2.verify(stored, String(pw));
    } catch {
      return false;
    }
  }
  if (stored.startsWith('$scrypt$')) return verifyScryptAsync(pw, stored);
  return false;
}
async function hashPasswordAsync(pw) {
  return argon2.hash(String(pw), ARGON2_POLICY);
}

function createStore() {
  const s = {
    seq: {
      user: 0,
      vehicle: 0,
      station: 0,
      cp: 0,
      plan: 0,
      band: 0,
      res: 0,
      sess: 0,
      inv: 0,
      pay: 0,
      fault: 0,
      maint: 0,
      review: 0,
      notif: 0,
      audit: 0,
      outbox: 0,
      // ADR-0010 control sequences (local ids are the authority; Oracle mirrors explicit ids).
      gridAsset: 0,
      decision: 0,
      cert: 0,
      push: 0,
      letter: 0,
      // ADR-0016 wallet rail: links are durable (Oracle `wallet_link`); challenges and
      // top-up intents are short-lived authorisations and live in memory on purpose.
      walletLink: 0,
      walletIntent: 0,
    },
    users: new Map(),
    wallets: new Map(),
    ledgers: [],
    // ADR-0016: one address may be linked to exactly one account (global uniqueness is
    // the anti-collision rule; the key is the lowercased address).
    walletLinks: new Map(),
    walletChallenges: new Map(),
    walletIntents: new Map(),
    vehicles: new Map(),
    vehicleStd: [],
    stations: new Map(),
    amenities: [],
    cps: new Map(),
    cpsByOcpp: new Map(),
    connectors: new Map(),
    plans: new Map(),
    bands: [],
    reservations: new Map(),
    sessions: new Map(),
    readings: [],
    invoices: new Map(),
    lines: [],
    payments: new Map(),
    faults: new Map(),
    maint: new Map(),
    reviews: new Map(),
    notifs: [],
    audit: [],
    outbox: [],
    // Dedupe index for the outbox. Every emit used to scan the whole array with
    // .some(); at simulator cadence a week-old process holds ~10^5 events and the
    // scan made emission O(n) per event (O(n^2) over the process lifetime) while
    // /health and /metrics re-filtered the same array on every poll.
    _outboxKeys: new Set(),
    _outboxStats: { emitted: 0, pruned: 0, quarantined: 0 },
    _outboxNextPruneAt: 0,
    // Set by GET /internal/outbox. Nothing polls before the first worker cycle, so 0
    // means "no relay has touched this process", which /health must report as null.
    _relayLastPollAt: 0,
    idem: new Map(),
    refresh: new Map(),
    // DA3 projection (TimescaleDB in prod; in-process rollup locally)
    ticks: [],
    stateEvents: [],
    // ADR-0010 (FC-HCC): grid assets + control artifacts. Mirrors Oracle V007.
    // Control rows are append-only: status transitions, never deletes (no-DELETE role).
    gridAssets: new Map(),
    controlDecisions: new Map(),
    certificates: new Map(),
    profilePushes: new Map(),
    deadLetters: new Map(),
    // Per-site control mode (blueprint Q.1): OFF | ADVISORY | ENFORCED. Default OFF
    // until receipts exist — actuation is opt-in per site, mirroring the V007 posture.
    controlMode: new Map(),
    enforcementTicks: [],
    mutex: new Mutex(),
  };
  const ref = (cp, no) => `${cp}:${no}`;
  s._ref = ref;
  // BUG-013 fix: plan id is resolved from the active tariff group, never a literal.
  // Group 1 = City (latest version), fallback = lowest plan_id.
  s.defaultPlanId = () => {
    const actives = [...s.plans.values()];
    if (!actives.length) return 2;
    const g1 = actives.filter((p) => p.group_id === 1);
    const pool = g1.length ? g1 : actives;
    return pool.reduce((a, b) => (b.version_no > a.version_no ? b : a)).plan_id;
  };
  // Per-session reading-seq index: O(1) dedupe instead of O(n) scan (perf §11.1 item 2).
  s._seqSeen = new Map(); // session_id -> Set(seq_no)
  // PERF-004: per-session max meter for the METER_REGRESSION check. The old per-tick
  // `readings.filter(...).reduce(...)` is O(total readings) per tick — quadratic across
  // a concurrent fleet (50-charger burst receipt: BootNotification timeouts from loop
  // saturation). Seeded lazily from readings for hydrated sessions, O(1) afterwards.
  s._maxMeter = new Map(); // session_id -> max meter_kwh

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
    s.audit.push({
      audit_id: ++s.seq.audit,
      actor_user_id: actor ?? null,
      entity_name: entity,
      entity_id: String(id),
      action,
      old_value: o ?? null,
      new_value: n ?? null,
      created_at: new Date().toISOString(),
    });
  };
  s.emitOutbox = (kind, dedupe, payload) => {
    if (s._outboxKeys.has(dedupe)) return; // idempotent, O(1)
    s._outboxKeys.add(dedupe);
    s.outbox.push({
      event_id: ++s.seq.outbox,
      kind,
      dedupe_key: dedupe,
      payload,
      created_at: new Date().toISOString(),
      processed_at: null,
    });
    s._outboxStats.emitted++;
    if (s.outbox.length > OUTBOX_SOFT_CAP) s.pruneOutboxIfDue();
  };

  // PF-01: housekeeping on a clock, not on every emit/ack. The hard cap is a safety
  // valve: overflow is pruned immediately even if the interval has not elapsed.
  s.pruneOutboxIfDue = (now = Date.now()) => {
    if (s.outbox.length <= OUTBOX_HARD_CAP && now < s._outboxNextPruneAt) return [];
    s._outboxNextPruneAt = now + OUTBOX_PRUNE_INTERVAL_MS;
    return s.pruneOutbox(now);
  };

  // Retention for the relay queue. ACKED events have already been written to
  // Timescale, so keeping them forever only costs memory and boot hydration; they
  // age out after OUTBOX_RETENTION_HOURS. Unacked events are NEVER dropped — the
  // relay's at-least-once guarantee depends on them. Returns the ids that left so
  // the caller can delete the same rows durably (Oracle mode).
  s.pruneOutbox = (now = Date.now()) => {
    const horizon = now - OUTBOX_RETENTION_MS;
    const removed = [];
    // A sink down longer than the retention window must still not grow the queue
    // without bound, so past the hard cap the OLDEST ACKED rows are shed too.
    // Unacked events are never eligible: the relay's at-least-once needs them.
    const acked = s.outbox.filter((e) => e.processed_at).sort((a, b) => a.event_id - b.event_id);
    const overflow = Math.max(0, s.outbox.length - OUTBOX_HARD_CAP);
    const shed = new Set(acked.slice(0, overflow).map((e) => e.event_id));
    const drop = new Set();
    for (const e of s.outbox) {
      if (!e.processed_at) continue;
      if (new Date(e.processed_at).getTime() < horizon || shed.has(e.event_id)) drop.add(e.event_id);
    }
    let cursor = 0;
    for (const e of s.outbox) {
      if (drop.has(e.event_id)) {
        s._outboxKeys.delete(e.dedupe_key);
        removed.push({ event_id: e.event_id, dedupe_key: e.dedupe_key });
      } else {
        s.outbox[cursor++] = e;
      }
    }
    s.outbox.length = cursor; // compact in place: readers hold a reference to this array
    s._outboxStats.pruned += removed.length;
    return removed;
  };

  // Real relay lag, measured — not a hardcoded "ok" printed by the worker.
  s.outboxLag = () => {
    let pending = 0;
    let oldest = Infinity;
    for (const e of s.outbox) {
      if (e.processed_at) continue;
      pending++;
      const t = new Date(e.created_at || 0).getTime();
      if (Number.isFinite(t) && t < oldest) oldest = t;
    }
    return {
      pending,
      depth: s.outbox.length,
      oldest_age_s: pending ? Math.max(0, Math.round((Date.now() - oldest) / 1000)) : 0,
      dead_letters_open: [...s.deadLetters.values()].filter((d) => d.status === 'OPEN').length,
      emitted: s._outboxStats.emitted,
      pruned: s._outboxStats.pruned,
      quarantined: s._outboxStats.quarantined,
      retention_hours: OUTBOX_RETENTION_HOURS,
    };
  };

  // Poison isolation: the relay quarantines an event it cannot write instead of
  // rolling the batch back forever. Without this, ONE bad row at the head of the
  // queue blocks every later event (head-of-line blocking) and the whole telemetry
  // pipeline silently stops — the failure looks like an outage, not a bug.
  s.quarantineOutbox = ({ ids = [], keys = [], reason = 'RELAY_POISON' } = {}) => {
    const want = new Set(ids.map(Number).filter(Number.isFinite));
    const wantKeys = new Set(keys.map(String).filter(Boolean));
    const letters = [];
    const marked = [];
    for (const e of s.outbox) {
      if (e.processed_at) continue;
      if (!want.has(e.event_id) && !wantKeys.has(e.dedupe_key)) continue;
      const now = new Date().toISOString();
      e.processed_at = now;
      e.quarantined_at = now;
      e.quarantine_reason = String(reason).slice(0, 120);
      letters.push(
        s.deadLetter({
          eventRef: e.dedupe_key,
          kind: e.kind,
          reasonCode: e.quarantine_reason,
          detail: `relay could not write this event; acked to keep the queue draining`,
          payload: e.payload,
        })
      );
      marked.push({ event_id: e.event_id, dedupe_key: e.dedupe_key });
    }
    s._outboxStats.quarantined += letters.length;
    return { quarantined: letters.length, letters, marked };
  };
  s.notify = (uid, kind, title, payload) => {
    s.notifs.push({
      notification_id: ++s.seq.notif,
      user_id: uid,
      kind,
      title,
      payload,
      is_read: 'N',
      created_at: new Date().toISOString(),
    });
  };
  s.getConnector = (cp, no) => {
    const c = s.connectors.get(ref(cp, no));
    if (!c) throw err('INVALID_CONNECTOR', `unknown connector ${cp}:${no}`, 404);
    return c;
  };
  // Per-session reading index. `readings` is append-only, so a lazy incremental
  // index is O(total) once and O(1) amortized afterwards — the controllers call
  // this per active session per plan cycle, and the naive filter made a fleet-wide
  // plan quadratic in history size. Tests push rows directly into `readings`; the
  // cursor-based build picks those up on the next call.
  s._readingsBySession = new Map();
  s._readingsIndexed = 0;
  s.readingsFor = (sid) => {
    const id = Number(sid);
    for (let i = s._readingsIndexed; i < s.readings.length; i++) {
      const r = s.readings[i];
      const k = Number(r.session_id);
      let arr = s._readingsBySession.get(k);
      if (!arr) {
        arr = [];
        s._readingsBySession.set(k, arr);
      }
      arr.push(r);
    }
    s._readingsIndexed = s.readings.length;
    return s._readingsBySession.get(id) || [];
  };

  // ---- users/wallet ----
  // PERF-002: async so Argon2id runs on the sidecar's thread pool — a registration
  // storm must not block the event loop (same receipt as the login path). Await at
  // the route layer; the Oracle mirror wrapper is already promise-shaped.
  s.createUser = async ({ email, password, full_name, role = 'DRIVER', phone }) => {
    // Email is an identity, not a display string: normalize once so Admin@x and
    // admin@x cannot become two accounts (and so login is case-insensitive).
    const normEmail = String(email || '')
      .trim()
      .toLowerCase();
    for (const u of s.users.values())
      if (String(u.email).toLowerCase() === normEmail) throw err('DUPLICATE_EMAIL', 'email taken', 409);
    const user_id = ++s.seq.user;
    const u = {
      user_id,
      email: normEmail,
      password_hash: await hashPasswordAsync(password),
      full_name,
      phone: phone || null,
      role,
      status: 'ACTIVE',
      created_at: new Date().toISOString(),
    };
    s.users.set(user_id, u);
    if (role === 'DRIVER' && !s.wallets.has(user_id)) {
      s.wallets.set(user_id, { user_id, balance: 0, currency: 'INR', updated_at: new Date().toISOString() });
    }
    s.auditLog(null, 'APP_USER', user_id, 'CREATE', null, { email: normEmail, role });
    return u;
  };
  // Admin suspend/reactivate. Kept as a store method (not an inline route mutation)
  // so the Oracle adapter can mirror it: a suspension that only lived in the local
  // cache would silently disappear on the next restart.
  s.setUserStatus = async (uid, status, actor) => {
    const u = s.users.get(Number(uid));
    if (!u) throw err('NOT_FOUND', 'user', 404);
    if (!['ACTIVE', 'SUSPENDED'].includes(status)) throw err('INVALID_STATUS', 'status must be ACTIVE|SUSPENDED', 422);
    const prev = u.status;
    u.status = status;
    s.auditLog(actor, 'APP_USER', u.user_id, 'UPDATE', prev, status);
    return { user: u, prev };
  };
  // Tariff versions are the money-path definition. The route used to mutate the
  // maps directly, which meant a new version existed only in the local cache (and
  // vanished on restart) while Oracle — the claimed durable engine — never saw it.
  // One method, one write path: the Oracle adapter mirrors plan + bands atomically.
  s.createTariffVersion = async ({ groupId, name, sessionFee, bands, actor }) => {
    const group_id = Number(groupId || 1);
    if (!Number.isInteger(group_id) || group_id < 1)
      throw err('INVALID_GROUP', 'group_id must be a positive integer', 422);
    const fee = Number(sessionFee || 0);
    if (!(fee >= 0)) throw err('INVALID_FEE', 'session_fee must be >= 0', 422);
    const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;
    const endRe = /^(24:00|([01]\d|2[0-3]):([0-5]\d))$/;
    const toMin = (t, end) => {
      if (end && t === '24:00') return 1440;
      const [h, m] = String(t).split(':').map(Number);
      return h * 60 + m;
    };
    const input =
      Array.isArray(bands) && bands.length
        ? bands
        : [{ day_scope: 'ALL', start_time: '00:00', end_time: '24:00', price_per_kwh: 22 }];
    const seen = new Set();
    const clean = input.map((b) => {
      const day_scope = String(b.day_scope || 'ALL').toUpperCase();
      if (!['ALL', 'WEEKDAY', 'WEEKEND'].includes(day_scope))
        throw err('INVALID_BAND', 'day_scope must be ALL|WEEKDAY|WEEKEND', 422);
      const start_time = String(b.start_time || '');
      const end_time = String(b.end_time || '');
      if (!timeRe.test(start_time)) throw err('INVALID_BAND', `invalid start_time ${start_time}`, 422);
      if (!endRe.test(end_time)) throw err('INVALID_BAND', `invalid end_time ${end_time}`, 422);
      if (toMin(end_time, true) <= toMin(start_time, false))
        throw err('INVALID_BAND', 'end_time must be after start_time', 422);
      const price_per_kwh = Number(b.price_per_kwh);
      if (!(price_per_kwh > 0)) throw err('INVALID_BAND', 'price_per_kwh must be > 0', 422);
      const slot = `${day_scope}:${start_time}`;
      if (seen.has(slot)) throw err('INVALID_BAND', `duplicate band slot ${slot}`, 422);
      seen.add(slot);
      return { day_scope, start_time, end_time, price_per_kwh };
    });

    const vers = [...s.plans.values()].filter((p) => p.group_id === group_id);
    const max = vers.reduce((m, p) => Math.max(m, p.version_no), 0);
    const prev = vers.find((p) => p.version_no === max);
    const previousActiveTo = prev ? prev.active_to : null;
    const plan_id = ++s.seq.plan;
    const plan = {
      plan_id,
      group_id,
      version_no: max + 1,
      name: String(name || `Plan v${max + 1}`).slice(0, 120),
      currency: 'INR',
      session_fee: fee,
      idle_fee_per_30min: 0,
      active_from: new Date().toISOString(),
      active_to: null,
      supersedes_plan_id: prev?.plan_id || null,
      created_by: actor,
      created_at: new Date().toISOString(),
    };
    s.plans.set(plan_id, plan);
    if (prev) prev.active_to = plan.active_from;
    const created = clean.map((b) => {
      const row = { band_id: ++s.seq.band, plan_id, ...b };
      s.bands.push(row);
      return row;
    });
    s.auditLog(actor, 'TARIFF_PLAN', plan_id, 'VERSION', prev?.plan_id ?? null, plan.name);
    return { plan, bands: created, previousPlanId: prev?.plan_id ?? null, previousActiveTo };
  };
  // `note` is the ledger's provenance line. The plain top-up route keeps the default;
  // the signed wallet rail passes a note that names the address and the intent, so an
  // auditor reading wallet_ledger can tell a card-free demo top-up from a signed one.
  s.topup = (uid, amount, note = 'top-up') => {
    if (!(amount > 0)) throw err('INVALID_AMOUNT', 'amount > 0', 422);
    // SEC-008: demo-economy caps — single top-up <= 10000, welcome credit handled by caller.
    if (amount > 10000) throw err('INVALID_AMOUNT', 'top-up capped at Rs.10000 per transaction (demo economy)', 422);
    const w = s.wallets.get(uid) || { user_id: uid, balance: 0, currency: 'INR' };
    const seq = s.ledgers.filter((l) => l.user_id === uid).length + 1;
    w.balance = +(w.balance + amount).toFixed(2);
    w.updated_at = new Date().toISOString();
    s.wallets.set(uid, w);
    s.ledgers.push({
      user_id: uid,
      seq_no: seq,
      kind: 'TOPUP',
      amount,
      balance_after: w.balance,
      payment_id: null,
      note,
      created_at: new Date().toISOString(),
    });
    s.auditLog(uid, 'WALLET', uid, 'TOPUP', null, { amount, balance_after: w.balance, note });
    return w;
  };

  /* ---------------- ADR-0016: signed wallet rail ----------------
   * The signature is the authorisation, the ledger is the settlement. Three properties
   * are load-bearing and each has a test (apps/api/test/wallet.js):
   *   1. a challenge is single-use and expires (no replay of a captured signature);
   *   2. an intent names its amount, so a signature for ₹500 cannot settle ₹5,000;
   *   3. settle is idempotent-by-rejection — a second settle of the same intent is 409,
   *      never a second credit (double-credit is the failure mode that matters).
   */
  const pruneWalletAuth = () => {
    const now = Date.now();
    for (const [k, c] of s.walletChallenges) if (c.expires_at_ms < now) s.walletChallenges.delete(k);
    for (const [, i] of s.walletIntents)
      if (i.expires_at_ms < now && i.status === 'PENDING') {
        i.status = 'EXPIRED';
      }
  };

  s.walletOverview = (uid) => {
    pruneWalletAuth();
    const links = [...s.walletLinks.values()]
      .filter((l) => l.user_id === Number(uid))
      .sort((a, b) => String(b.linked_at).localeCompare(String(a.linked_at)));
    const intents = [...s.walletIntents.values()]
      .filter((i) => i.user_id === Number(uid))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 10)
      .map(({ message: _m, ...rest }) => rest);
    return {
      wallet: s.wallets.get(Number(uid)) || null,
      links,
      intents,
      ledger: s.ledgers
        .filter((l) => l.user_id === Number(uid))
        .sort((a, b) => b.seq_no - a.seq_no)
        .slice(0, 25),
    };
  };

  s.walletChallenge = (uid, { address, domain, uri }) => {
    pruneWalletAuth();
    const addr = rail.normalise(address);
    const n = rail.nonce();
    const issued_at = new Date().toISOString();
    const message = rail.challengeMessage({
      address: addr,
      chainId: rail.CHAIN_ID,
      nonce: n,
      issuedAt: issued_at,
      uri,
      domain,
    });
    s.walletChallenges.set(n, {
      user_id: Number(uid),
      address: addr.toLowerCase(),
      message,
      expires_at_ms: Date.now() + rail.CHALLENGE_TTL_MS,
    });
    return { nonce: n, message, address: addr, chain_id: rail.CHAIN_ID, chain_name: rail.CHAIN_NAME };
  };

  // `address` is accepted for a stable call shape but intentionally unused: the
  // binding that matters is the CHALLENGE's address (ch.address) — trusting the
  // request's own address claim would let a client link an address it never signed for.
  s.linkWallet = (uid, { address: _address, signature, nonce: n, label }) => {
    pruneWalletAuth();
    const ch = s.walletChallenges.get(String(n || ''));
    if (!ch) throw err('CHALLENGE_INVALID', 'challenge missing, used or expired — request a new one', 409);
    if (ch.user_id !== Number(uid)) throw err('CHALLENGE_INVALID', 'challenge belongs to another account', 403);
    // Single-use: consume before verifying so a malformed retry cannot brute-force the
    // same nonce, and a replayed request cannot link twice.
    s.walletChallenges.delete(String(n));
    if (ch.expires_at_ms < Date.now()) throw err('CHALLENGE_EXPIRED', 'challenge expired', 409);
    const addr = rail.verifySignature({ message: ch.message, signature, address: ch.address });
    if (addr.toLowerCase() !== ch.address)
      throw err('SIGNATURE_MISMATCH', 'signed address differs from challenge', 401);

    const key = addr.toLowerCase();
    const existing = s.walletLinks.get(key);
    if (existing && existing.user_id !== Number(uid))
      throw err('WALLET_TAKEN', 'this address is linked to another account', 409);
    const row = {
      link_id: existing ? existing.link_id : ++s.seq.walletLink,
      user_id: Number(uid),
      address: addr,
      chain_id: rail.CHAIN_ID,
      chain_name: rail.CHAIN_NAME,
      label: String(label || 'Connected wallet').slice(0, 60),
      linked_at: new Date().toISOString(),
      verified_by: 'EIP-191',
    };
    s.walletLinks.set(key, row);
    s.auditLog(uid, 'WALLET_LINK', row.link_id, 'LINK', existing ? existing.address : null, {
      address: addr,
      chain_id: rail.CHAIN_ID,
    });
    return row;
  };

  s.unlinkWallet = (uid, address) => {
    const key = String(address || '').toLowerCase();
    const row = s.walletLinks.get(key);
    if (!row || row.user_id !== Number(uid)) throw err('NOT_FOUND', 'wallet link', 404);
    s.walletLinks.delete(key);
    s.auditLog(uid, 'WALLET_LINK', row.link_id, 'UNLINK', row.address, null);
    return { unlinked: row.address };
  };

  s.createTopupIntent = (uid, { amount }) => {
    pruneWalletAuth();
    const amt = Number(amount);
    if (!(amt > 0)) throw err('INVALID_AMOUNT', 'amount > 0', 422);
    if (amt > rail.MAX_TOPUP_INR)
      throw err('INVALID_AMOUNT', `top-up capped at Rs.${rail.MAX_TOPUP_INR} per transaction (demo economy)`, 422);
    const link = [...s.walletLinks.values()].find((l) => l.user_id === Number(uid));
    if (!link) throw err('NO_WALLET_LINKED', 'link a wallet before creating a top-up intent', 409);
    const intent_id = `int_${String(++s.seq.walletIntent).padStart(5, '0')}_${rail.nonce().slice(0, 8)}`;
    const expires_at = new Date(Date.now() + rail.INTENT_TTL_MS).toISOString();
    const amount_wei = rail.wei(amt).toString();
    const message = rail.intentMessage({
      intentId: intent_id,
      address: link.address,
      amountInr: amt,
      amountWei: amount_wei,
      chainId: rail.CHAIN_ID,
      expiresAt: expires_at,
    });
    const intent = {
      intent_id,
      user_id: Number(uid),
      address: link.address,
      amount_inr: amt,
      amount_eth: rail.eth(amt),
      amount_wei,
      chain_id: rail.CHAIN_ID,
      status: 'PENDING',
      message,
      created_at: new Date().toISOString(),
      expires_at,
      expires_at_ms: Date.now() + rail.INTENT_TTL_MS,
    };
    s.walletIntents.set(intent_id, intent);
    return intent;
  };

  // async because the Oracle adapter makes topup() promise-shaped: a sync caller would
  // read `undefined` off a pending mirror and publish a receipt before the money
  // committed. Awaiting is what keeps "credited" and "committed" the same event.
  // W5-concurrency (review 2026-10-24): settle runs under the intent's mutex — the old
  // synchronous status check raced real Oracle I/O (await topup) before the status
  // flip, so two concurrent settles of one intent BOTH credited. The mutex keeps
  // "exactly one credit per signature" true under concurrency, not just replay.
  s.settleTopup = async (uid, { intent_id, signature }) => {
    return s.mutex.run('wallet-intent:' + String(intent_id || ''), async () => {
      pruneWalletAuth();
      const it = s.walletIntents.get(String(intent_id || ''));
      if (!it || it.user_id !== Number(uid)) throw err('NOT_FOUND', 'top-up intent', 404);
      if (it.status === 'SETTLED')
        throw err('ALREADY_SETTLED', 'this intent was already settled — one credit per signature', 409);
      if (it.status === 'EXPIRED' || it.expires_at_ms < Date.now())
        throw err('INTENT_EXPIRED', 'intent expired — create a new one', 409);
      const signer = rail.verifySignature({ message: it.message, signature, address: it.address });
      const note = `wallet top-up ${it.intent_id} · ${signer.slice(0, 10)}…${signer.slice(-4)}`;
      const w = await s.topup(uid, it.amount_inr, note);
      // The ledger row must be identified by its unique note, not array position —
      // under the mutex the awaited mirror can still interleave with another user's
      // synchronous topup, and "last row" would then be someone else's receipt.
      const entry = [...s.ledgers].reverse().find((l) => l.note === note);
      it.status = 'SETTLED';
      it.settled_at = new Date().toISOString();
      it.reference = `vh_${crypto.createHash('sha256').update(signature).digest('hex').slice(0, 24)}`;
      it.balance_after = w.balance;
      s.auditLog(uid, 'WALLET', uid, 'SETTLE', null, {
        intent_id: it.intent_id,
        amount: it.amount_inr,
        address: signer,
        reference: it.reference,
      });
      return {
        wallet: w,
        entry,
        receipt: {
          intent_id: it.intent_id,
          address: signer,
          amount_inr: it.amount_inr,
          amount_eth: it.amount_eth,
          amount_wei: it.amount_wei,
          chain_id: it.chain_id,
          chain_name: rail.CHAIN_NAME,
          reference: it.reference,
          settled_at: it.settled_at,
          ledger_seq: entry.seq_no,
          balance_after: w.balance,
          mode: 'signed-authorisation (no gas, no chain write)',
        },
      };
    });
  };

  // F-05: a connector is RESERVED iff it holds at least one BOOKED window. Two
  // non-overlapping windows may sit on the same connector, so cancelling (or expiring)
  // one must not release the hold the other still owns. Derive the target state from
  // the reservation table instead of assuming "the cancelled window was the last one".
  // Callers hold the `conn:` mutex so this cannot race create_reservation/start_session.
  const syncConnectorHold = (key, source, reservationId) => {
    const c = s.connectors.get(key);
    if (!c || !['AVAILABLE', 'RESERVED'].includes(c.status)) return false;
    let booked = false;
    for (const r of s.reservations.values()) {
      if (r.connector_ref === key && r.status === 'BOOKED') {
        booked = true;
        break;
      }
    }
    const to = booked ? 'RESERVED' : 'AVAILABLE';
    if (c.status === to) return false;
    const from = c.status;
    c.status = to;
    c.last_state_change_at = new Date().toISOString();
    s.emitOutbox('CONNECTOR_STATE', `connstate:${key}:${reservationId ?? 'none'}:${source}`, {
      connector_ref: key,
      from,
      to,
      cause: 'RESERVATION',
      ...(reservationId ? { reservation_id: Number(reservationId) } : {}),
    });
    s.stateEvents.push({
      ts: new Date().toISOString(),
      connector_ref: key,
      from_state: from,
      to_state: to,
      cause: 'RESERVATION',
      session_id: null,
    });
    return true;
  };

  // ---- RESERVATION_PKG.create_reservation (BR-04/05/12, ORA -2050x) ----
  s.createReservation = async (uid, vehicleId, cpId, connNo, startAt, endAt) => {
    const key = ref(cpId, connNo);
    return s.mutex.run('conn:' + key, async () => {
      const start = new Date(startAt),
        end = new Date(endAt);
      const mins = (end - start) / 60000;
      if (!(end > start) || mins < 15 || mins > 120 || start.getTime() < Date.now() - 60000) {
        const e = new Error('INVALID_WINDOW: reservation must be 15-120 min in the future');
        e.num = ORA.INVALID_WINDOW;
        e.code = 'INVALID_WINDOW';
        e.status = 422;
        throw e;
      }
      const c = s.getConnector(cpId, connNo);
      if (!['AVAILABLE', 'RESERVED'].includes(c.status)) {
        const e = new Error(`NOT_BOOKABLE: connector ${key} is ${c.status}`);
        e.num = ORA.NOT_BOOKABLE;
        e.code = 'NOT_BOOKABLE';
        e.status = 409;
        throw e;
      }
      for (const r of s.reservations.values()) {
        if (
          r.connector_ref === key &&
          ['BOOKED', 'CONVERTED'].includes(r.status) &&
          new Date(r.start_at) < end &&
          new Date(r.end_at) > start
        ) {
          const e = new Error(`OVERLAP: connector ${key} already booked in window`);
          e.num = ORA.OVERLAP;
          e.code = 'OVERLAP';
          e.status = 409;
          throw e;
        }
      }
      const reservation_id = ++s.seq.res;
      const r = {
        reservation_id,
        connector_ref: key,
        // V006/ADR-0006: FK pair written natively alongside the display handle (mirrors packages).
        cp_id: Number(cpId),
        connector_no: Number(connNo),
        user_id: uid,
        vehicle_id: vehicleId || null,
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        status: 'BOOKED',
        created_at: new Date().toISOString(),
      };
      s.reservations.set(reservation_id, r);
      const from = c.status;
      c.status = 'RESERVED';
      c.last_state_change_at = new Date().toISOString();
      s.emitOutbox('CONNECTOR_STATE', `connstate:${key}:${reservation_id}`, {
        connector_ref: key,
        from,
        to: 'RESERVED',
        cause: 'RESERVATION',
        reservation_id,
      });
      s.stateEvents.push({
        ts: new Date().toISOString(),
        connector_ref: key,
        from_state: from,
        to_state: 'RESERVED',
        cause: 'RESERVATION',
        session_id: null,
      });
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
      // BUG-031: operator station scope — cancelling is a station mutation, so the
      // caller's assigned stations bound which bookings they may cancel (mirrors
      // PATCH /sessions/:id/state + requireOwned). ADMIN/DRIVER unaffected.
      if (role === 'OPERATOR' && Array.isArray(scopeStations)) {
        const stationId = s.cps.get(Number(String(r.connector_ref).split(':')[0]))?.station_id;
        if (stationId && !scopeStations.includes(stationId)) throw err('OUT_OF_SCOPE', 'station not assigned', 403);
      }
      if (r.status !== 'BOOKED') {
        const e = new Error('CANCEL_CONFLICT');
        e.num = ORA.CANCEL_CONFLICT;
        e.code = 'CANCEL_CONFLICT';
        e.status = 409;
        throw e;
      }
      r.status = 'CANCELLED';
      // F-05: release only when this was the last BOOKED window on the connector.
      await s.mutex.run('conn:' + r.connector_ref, async () => syncConnectorHold(r.connector_ref, 'release', rid));
      s.auditLog(actor, 'RESERVATION', rid, 'CANCEL', 'BOOKED', 'CANCELLED');
      return r;
    });
  };
  s.expireStale = async () => {
    let n = 0;
    const cutoff = Date.now() - 15 * 60000;
    for (const r of [...s.reservations.values()]) {
      if (r.status !== 'BOOKED' || !(new Date(r.start_at).getTime() < cutoff)) continue;
      // Same lock create_reservation takes, so a booking racing the sweep sees either
      // BOOKED or EXPIRED, never a released hold it just re-took (F-05).
      await s.mutex.run('conn:' + r.connector_ref, async () => {
        if (r.status !== 'BOOKED') return; // re-check under the connector lock
        r.status = 'EXPIRED';
        syncConnectorHold(r.connector_ref, 'release', r.reservation_id);
        n++;
      });
    }
    return n;
  };

  // ---- CHARGE_SESSION_PKG ----
  // meterStartKwh: the charger's absolute meter register at plug-in (OCPP meterStart/1000).
  // BUG-054: billing is end − start, so a session that ignores the register overbills
  // every charger whose meter did not start at zero.
  s.startSession = async ({ uid, vehicleId, cpId, connNo, planId, reservationId, idTag, meterStartKwh }) => {
    const key = ref(cpId, connNo);
    return s.mutex.run('conn:' + key, async () => {
      const c = s.getConnector(cpId, connNo);
      if (!['AVAILABLE', 'RESERVED'].includes(c.status)) {
        const e = new Error(`NOT_BOOKABLE: connector ${key} is ${c.status}`);
        e.num = ORA.NOT_BOOKABLE;
        e.code = 'NOT_BOOKABLE';
        e.status = 409;
        throw e;
      }
      // B2G-013: reservation ownership — OCPP Reservations-profile semantics require
      // idTag↔reservation matching: reservation must belong to caller, target this
      // connector, and be BOOKED. Both engines enforce identically.
      if (reservationId) {
        const r = s.reservations.get(Number(reservationId));
        if (!r || r.user_id !== uid || r.connector_ref !== key || r.status !== 'BOOKED') {
          const e = new Error('RESERVATION_MISMATCH: reservation does not belong to caller/connector or not BOOKED');
          e.num = ORA.RESERVATION_MISMATCH;
          e.code = 'RESERVATION_MISMATCH';
          e.status = 409;
          throw e;
        }
      } else if (c.status === 'RESERVED') {
        // B2G-013b (mission audit): a RESERVED connector without an explicit reservationId
        // previously converted for ANY caller — omitting the id was enough to hijack another
        // driver's window (OCPP StartTransaction and REST /sessions/start both hit this).
        // Rule: the caller may only adopt a BOOKED window on this connector that they own;
        // otherwise the start is a 409 RESERVATION_MISMATCH and the window stays untouched.
        const mine = [...s.reservations.values()].find(
          (r) => r.connector_ref === key && r.status === 'BOOKED' && r.user_id === uid
        );
        if (!mine) {
          const e = new Error(
            'RESERVATION_MISMATCH: connector is RESERVED — pass the reservationId that owns this window'
          );
          e.num = ORA.RESERVATION_MISMATCH;
          e.code = 'RESERVATION_MISMATCH';
          e.status = 409;
          throw e;
        }
        reservationId = mine.reservation_id;
      }
      const session_id = ++s.seq.sess;
      const sess = {
        session_id,
        user_id: uid,
        vehicle_id: vehicleId || null,
        reservation_id: reservationId || null,
        connector_ref: key,
        // V006/ADR-0006: FK pair written natively alongside the display handle.
        cp_id: Number(cpId),
        connector_no: Number(connNo),
        tariff_plan_id: planId,
        id_tag: idTag || null,
        state: 'PREPARING',
        billing_state: 'UNBILLED',
        started_at: new Date().toISOString(),
        ended_at: null,
        start_meter_kwh: Number.isFinite(Number(meterStartKwh)) ? Math.max(0, Number(meterStartKwh)) : 0,
        end_meter_kwh: null,
        energy_kwh: null,
        stop_reason: null,
      };
      s.sessions.set(session_id, sess);
      if (reservationId) {
        const r = s.reservations.get(Number(reservationId));
        if (r) r.status = 'CONVERTED';
      }
      const from = c.status;
      c.status = 'OCCUPIED';
      c.last_state_change_at = new Date().toISOString();
      s.stateEvents.push({
        ts: new Date().toISOString(),
        connector_ref: key,
        from_state: from,
        to_state: 'OCCUPIED',
        cause: 'OCPP',
        session_id,
      });
      s.emitOutbox('SESSION_EVENT', `sess:${session_id}:PREPARING:${Date.now()}`, {
        session_id,
        from: 'RESERVED',
        to: 'PREPARING',
      });
      s.auditLog(uid, 'CHARGING_SESSION', session_id, 'START', null, { connector_ref: key });
      return sess;
    });
  };
  // `_transitionLocal` is the un-decorated implementation. The Oracle adapter replaces
  // `transition` with a write-through wrapper, while stopSession must apply the state
  // change locally only (the durable engine already transitioned inside stop_session).
  // Without this split, stopSession would issue a second Oracle transition and fail
  // with ILLEGAL_TRANSITION *after* the stop had already committed.
  const transitionLocal = async (sid, to, reason) => {
    return s.mutex.run('sess:' + sid, async () => {
      const sess = s.sessions.get(Number(sid));
      if (!sess) throw err('NOT_FOUND', 'session not found', 404);
      if (!legalTransition(sess.state, to)) {
        const e = new Error(`ILLEGAL_TRANSITION: ${sess.state} -> ${to}`);
        e.num = ORA.ILLEGAL_TRANSITION;
        e.code = 'ILLEGAL_TRANSITION';
        e.status = 409;
        throw e;
      }
      const from = sess.state;
      sess.state = to;
      sess.stop_reason = reason || sess.stop_reason;
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(to)) sess.ended_at = new Date().toISOString();
      const c = s.connectors.get(sess.connector_ref);
      if (c) {
        if (to === 'CHARGING') c.status = 'OCCUPIED';
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(to)) c.status = 'AVAILABLE';
        c.last_state_change_at = new Date().toISOString();
      }
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(to)) {
        // F-05 (Oracle parity: V012): a BOOKED window still waiting on this connector
        // keeps the RESERVED hold after the converted session ends.
        await s.mutex.run('conn:' + sess.connector_ref, async () =>
          syncConnectorHold(sess.connector_ref, 'release', null)
        );
      }
      s.emitOutbox('SESSION_EVENT', `sess:${sid}:${to}:${Date.now()}`, { session_id: Number(sid), from, to });
      s.auditLog(null, 'CHARGING_SESSION', sid, 'TRANSITION', from, to);
      return sess;
    });
  };
  s.transition = transitionLocal;
  s._transitionLocal = transitionLocal;
  s.recordTick = async (sid, seq, at, kwh, kw, v, a) => {
    return s.mutex.run('sess:' + sid, async () => {
      const sess = s.sessions.get(Number(sid));
      if (!sess) throw err('NOT_FOUND', 'session not found', 404);
      if (!['PREPARING', 'CHARGING', 'SUSPENDED'].includes(sess.state)) {
        const e = new Error('TICK_REJECTED: session not active');
        e.num = ORA.TICK_REJECTED;
        e.code = 'TICK_REJECTED';
        e.status = 409;
        throw e;
      }
      // Same rule the meterStart path already applies (store.js:971) and StopTransaction
      // applies in the gateway: MeterValue.value is a STRING from the charge point, so
      // Number('abc') is NaN — and Timescale's float8 stores NaN happily, where NaN = NaN
      // is TRUE, so the usual "x !== x" detector never sees it. One NaN register poisons
      // every downstream energy SUM, while Oracle mode rejects the same frame as a driver
      // error. The two engines must treat one frame the same way: reject at the port.
      const register = Number(kwh);
      if (!Number.isFinite(register)) {
        const e = new Error('TICK_REJECTED: meter register is not a finite number');
        e.num = ORA.TICK_REJECTED;
        e.code = 'TICK_REJECTED';
        e.status = 409;
        throw e;
      }
      // Auxiliary channels are optional samples: a broken SoC/voltage field must not
      // cost the session its energy register, so non-finite ones land as NULL, not NaN.
      const chan = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));
      const power = chan(kw);
      const volt = chan(v);
      const amps = chan(a);
      let seen = s._seqSeen.get(Number(sid));
      if (!seen) {
        seen = new Set(s.readings.filter((r) => r.session_id === Number(sid)).map((r) => r.seq_no));
        s._seqSeen.set(Number(sid), seen);
      }
      if (seen.has(seq)) return { deduped: true }; // idempotent replay
      let last = s._maxMeter.get(Number(sid));
      if (last === undefined) {
        last = s.readings.filter((r) => r.session_id === Number(sid)).reduce((m, r) => Math.max(m, r.meter_kwh), -1);
        s._maxMeter.set(Number(sid), last);
      }
      if (register < last - 0.001) {
        const e = new Error('METER_REGRESSION');
        e.num = ORA.METER_REGRESSION;
        e.code = 'METER_REGRESSION';
        e.status = 409;
        throw e;
      }
      const ts = at ? new Date(at).toISOString() : new Date().toISOString();
      s.readings.push({
        session_id: Number(sid),
        seq_no: seq,
        taken_at: ts,
        meter_kwh: register,
        power_kw: power,
        voltage_v: volt,
        current_a: amps,
        source: 'OCPP',
      });
      seen.add(seq);
      if (register > last) s._maxMeter.set(Number(sid), register);
      if (sess.state === 'PREPARING' && seq >= 1) sess.state = 'CHARGING';
      s.emitOutbox('METER_TICK', `tick:${sid}:${seq}`, {
        session_id: Number(sid),
        seq,
        connector_ref: sess.connector_ref,
        meter_kwh: register,
        power_kw: power,
        ts,
      });
      s.ticks.push({
        ts,
        session_id: Number(sid),
        connector_ref: sess.connector_ref,
        meter_kwh: register,
        power_kw: power,
        voltage_v: volt,
        current_a: amps,
      });
      return { ok: true };
    });
  };
  // endMeterKwh is the OCPP StopTransaction.meterStop (kWh), authoritative when
  // supplied. Without it we fall back to the highest recorded reading. Both engines
  // persist the same number: this is what makes Oracle-mode billing price delivered
  // energy instead of end_meter_kwh=NULL -> 0 kWh (SEC-067).
  s.stopSession = async (sid, reason, endMeterKwh) => {
    const sess = s.sessions.get(Number(sid));
    if (!sess) throw err('NOT_FOUND', 'session not found', 404);
    const peak = s._maxMeter.has(Number(sid))
      ? Math.max(s._maxMeter.get(Number(sid)), 0)
      : s.readings.filter((r) => r.session_id === Number(sid)).reduce((m, r) => Math.max(m, r.meter_kwh), 0);
    const explicit = Number(endMeterKwh);
    const hasExplicit = Number.isFinite(explicit) && explicit >= 0;
    const end = hasExplicit ? explicit : peak;
    const start = Number(sess.start_meter_kwh || 0);
    if (end + 0.001 < start) {
      const e = new Error('METER_REGRESSION: stop meter is below start meter');
      e.num = ORA.METER_REGRESSION;
      e.code = 'METER_REGRESSION';
      e.status = 409;
      throw e;
    }
    sess.end_meter_kwh = end;
    if (!s._maxMeter.has(Number(sid)) || end > s._maxMeter.get(Number(sid))) s._maxMeter.set(Number(sid), end);
    // CHARGING->COMPLETED directly, or via SUSPENDED
    if (sess.state === 'SUSPENDED' || sess.state === 'CHARGING' || sess.state === 'PREPARING') {
      return transitionLocal(sid, sess.state === 'PREPARING' ? 'CANCELLED' : 'COMPLETED', reason || 'REMOTE_STOP');
    }
    return sess;
  };

  // ---- TARIFF/BILLING ----
  s.resolveBandPrice = (planId, at) => {
    const d = new Date(at);
    const dow = d.getDay(); // 0 Sun
    const mins = d.getHours() * 60 + d.getMinutes();
    const cands = s.bands.filter(
      (b) =>
        b.plan_id === Number(planId) &&
        (b.day_scope === 'ALL' ||
          (b.day_scope === 'WEEKDAY' && dow >= 1 && dow <= 5) ||
          (b.day_scope === 'WEEKEND' && (dow === 0 || dow === 6)))
    );
    // BUG-008 follow-up: a band may close at midnight. Oracle returns that as
    // '00:00' (TIMESTAMP cannot hold 24:00) and older seeds stored '23:59' or
    // '23:59:59', which left the final minute/second of the day unpriced. Treat a
    // zero end-time as end-of-day and any near-midnight close as a full 24:00.
    const toMin = (t, isEnd = false) => {
      const [h, m] = String(t).split(':').map(Number);
      if (isEnd && h === 0 && (m || 0) === 0) return 1440;
      return h * 60 + (m || 0);
    };
    const hit = cands.find((b) => {
      const start = toMin(b.start_time);
      let end = toMin(b.end_time, true);
      if (end >= 1439) end = 1440; // legacy 23:59 / 23:59:59 close
      return mins >= start && mins < end;
    });
    if (!hit) {
      const e = new Error('NO_TARIFF_BAND');
      e.num = ORA.NO_TARIFF_BAND;
      e.code = 'NO_TARIFF_BAND';
      e.status = 422;
      throw e;
    }
    return hit.price_per_kwh;
  };
  s.billSession = async (sid) => {
    return s.mutex.run('sess:' + sid, async () => {
      const sess = s.sessions.get(Number(sid));
      if (!sess) throw err('NOT_FOUND', 'session not found', 404);
      if (sess.state !== 'COMPLETED') {
        const e = new Error('BILL_CONFLICT: session not COMPLETED');
        e.num = ORA.BILL_CONFLICT;
        e.code = 'BILL_CONFLICT';
        e.status = 409;
        throw e;
      }
      if (sess.billing_state !== 'UNBILLED') {
        const e = new Error('BILLING_CONFLICT');
        e.num = ORA.BILLING_CONFLICT;
        e.code = 'BILLING_CONFLICT';
        e.status = 409;
        throw e;
      }
      const energy = Math.max((sess.end_meter_kwh ?? 0) - (sess.start_meter_kwh ?? 0), 0);
      const price = s.resolveBandPrice(sess.tariff_plan_id, sess.started_at);
      const plan = s.plans.get(Number(sess.tariff_plan_id));
      const energyAmt = +(energy * price).toFixed(2);
      const fee = plan ? +plan.session_fee : 0;
      const total = +(energyAmt + fee).toFixed(2);
      const invoice_id = ++s.seq.inv;
      s.invoices.set(invoice_id, {
        invoice_id,
        session_id: Number(sid),
        tariff_plan_id: sess.tariff_plan_id,
        status: 'DUE',
        total,
        currency: 'INR',
        issued_at: new Date().toISOString(),
      });
      s.lines.push({
        invoice_id,
        line_no: 1,
        kind: 'ENERGY',
        description: `Energy ${energy.toFixed(3)} kWh @ Rs.${price}`,
        quantity: +energy.toFixed(3),
        unit: 'kWh',
        unit_price: price,
        amount: energyAmt,
      });
      if (fee > 0)
        s.lines.push({
          invoice_id,
          line_no: 2,
          kind: 'SESSION_FEE',
          description: 'Session fee',
          quantity: 1,
          unit: null,
          unit_price: fee,
          amount: fee,
        });
      sess.billing_state = 'BILLED';
      sess.energy_kwh = +energy.toFixed(3);
      s.auditLog(null, 'INVOICE', invoice_id, 'ISSUE', null, { session: sid, total });
      s.notify(sess.user_id, 'BILLING', 'Invoice issued', { invoice_id, total });
      return s.invoices.get(invoice_id);
    });
  };
  s.payInvoice = async (invId, uid) => {
    return s.mutex.run('inv:' + invId, async () => {
      const inv = s.invoices.get(Number(invId));
      if (!inv) throw err('NOT_FOUND', 'invoice not found', 404);
      if (inv.status !== 'DUE') {
        const e = new Error('PAY_CONFLICT');
        e.num = ORA.PAY_CONFLICT;
        e.code = 'PAY_CONFLICT';
        e.status = 409;
        throw e;
      }
      const w = s.wallets.get(uid) || { user_id: uid, balance: 0, currency: 'INR' };
      s.wallets.set(uid, w);
      if (w.balance < inv.total) {
        const payment_id = ++s.seq.pay;
        s.payments.set(payment_id, {
          payment_id,
          invoice_id: Number(invId),
          amount: inv.total,
          method: 'WALLET',
          status: 'FAILED',
          reference: null,
          created_at: new Date().toISOString(),
        });
        // B2G-004: invoice stays DUE (matches Oracle rollback semantics) — the PAYMENT failed, not the invoice.
        const e = new Error('INSUFFICIENT_FUNDS');
        e.num = ORA.INSUFFICIENT_FUNDS;
        e.code = 'INSUFFICIENT_FUNDS';
        e.status = 402;
        throw e;
      }
      const seq = s.ledgers.filter((l) => l.user_id === uid).length + 1;
      const payment_id = ++s.seq.pay;
      s.payments.set(payment_id, {
        payment_id,
        invoice_id: Number(invId),
        amount: inv.total,
        method: 'WALLET',
        status: 'SUCCESS',
        reference: `WLT-${Date.now()}`,
        created_at: new Date().toISOString(),
      });
      s.ledgers.push({
        user_id: uid,
        seq_no: seq,
        kind: 'PAYMENT',
        amount: -inv.total,
        balance_after: +(w.balance - inv.total).toFixed(2),
        payment_id,
        note: `Invoice ${invId}`,
        created_at: new Date().toISOString(),
      });
      w.balance = +(w.balance - inv.total).toFixed(2);
      w.updated_at = new Date().toISOString();
      inv.status = 'PAID';
      s.auditLog(uid, 'INVOICE', invId, 'PAY', 'DUE', 'PAID');
      return s.payments.get(payment_id);
    });
  };
  // ---- TD-05: route-level writes live behind the store interface (adapter covers them) ----
  s.createVehicle = (uid, body) => {
    const vehicle_id = ++s.seq.vehicle;
    const v = {
      vehicle_id,
      user_id: uid,
      nickname: body.nickname || null,
      make: body.make,
      model: body.model,
      battery_kwh: Number(body.battery_kwh),
      is_default: body.is_default ? 'Y' : 'N',
      created_at: new Date().toISOString(),
    };
    s.vehicles.set(vehicle_id, v);
    (body.standards || ['TYPE2', 'CCS2']).forEach((code) => {
      const st = s.standards.find((x) => x.code === code);
      if (st) s.vehicleStd.push({ vehicle_id, standard_id: st.standard_id });
    });
    s.auditLog(uid, 'VEHICLE', vehicle_id, 'CREATE', null, v);
    return v;
  };
  // Atomic station provisioning: pre-validate ALL ocpp identities before any write.
  s.provisionStation = (adminId, b) => {
    if (!(b.name && Number.isFinite(Number(b.latitude)) && Number.isFinite(Number(b.longitude)))) {
      throw err('INVALID_STATION', 'name + latitude + longitude required', 422);
    }
    const nextStationId = Math.max(0, ...[...s.stations.keys()]) + 1;
    const predicted = (b.charge_points || []).map((p, i) => p.ocpp_identity || `VH-${nextStationId}-CP${i + 1}`);
    const dupReq = predicted.find((v, i) => predicted.indexOf(v) !== i);
    if (dupReq) {
      const e = new Error(`DUPLICATE_OCPP_ID: ${dupReq}`);
      e.code = 'DUPLICATE_OCPP_ID';
      e.status = 409;
      throw e;
    }
    const clash = predicted.find((v) => s.cpsByOcpp.has(v));
    if (clash) {
      const e = new Error(`DUPLICATE_OCPP_ID: ${clash}`);
      e.code = 'DUPLICATE_OCPP_ID';
      e.status = 409;
      throw e;
    }
    const station_id = ++s.seq.station;
    const st = {
      station_id,
      name: b.name,
      latitude: Number(b.latitude),
      longitude: Number(b.longitude),
      // Oracle station.address_line is NOT NULL and treats '' as NULL — mirror the
      // city/state defaults with a non-empty sentinel (BUG-047 mirror parity).
      address_line: b.address_line || 'N/A',
      city: b.city || 'Chennai',
      state: b.state || 'Tamil Nadu',
      pincode: b.pincode || null,
      status: 'ACTIVE',
      operator_id: b.operator_id || null,
      created_at: new Date().toISOString(),
    };
    s.stations.set(station_id, st);
    (b.amenities || []).forEach((a) => s.amenities.push({ station_id, amenity: a }));
    const provisioned = [];
    for (const [i, p] of (b.charge_points || []).entries()) {
      const cp_id = ++s.seq.cp;
      const ocpp_identity = p.ocpp_identity || `VH-${station_id}-CP${i + 1}`;
      const auth_secret = p.auth_secret || crypto.randomBytes(18).toString('hex');
      s.cps.set(cp_id, {
        cp_id,
        station_id,
        ocpp_identity,
        auth_secret,
        vendor: p.vendor || 'VoltHub',
        model: p.model || 'VH-AC22',
        firmware_version: '1.6.5',
        // A freshly provisioned charge point has never connected — it must not
        // count as online until the gateway accepts its first OCPP socket
        // (volthub_ocpp_online would otherwise report chargers that do not exist).
        status: 'OFFLINE',
        last_boot_at: null,
        last_seen_at: null,
      });
      s.cpsByOcpp.set(ocpp_identity, cp_id);
      (p.connectors || [{ standard: 'TYPE2', max_power_kw: 22 }]).forEach((c, k) => {
        const stdRow = s.standards.find((t) => t.code === c.standard) || s.standards[0];
        s.connectors.set(`${cp_id}:${k + 1}`, {
          cp_id,
          connector_no: k + 1,
          standard_id: stdRow.standard_id,
          max_power_kw: Number(c.max_power_kw || 22),
          status: 'AVAILABLE',
          last_state_change_at: new Date().toISOString(),
        });
      });
      provisioned.push({ cp_id, ocpp_identity, auth_secret: s.cps.get(cp_id).auth_secret });
    }
    s.auditLog(adminId, 'STATION', station_id, 'CREATE', null, { name: st.name });
    return { station: st, provisioned };
  };
  // BUG-047: standalone CP provisioning extracted from the route into a store method so
  // the Oracle adapter can mirror it (one-port contract, same as provisionStation).
  // HTTP-layer validation (BUG-033: ocpp_identity/auth_secret shape) stays in the route;
  // this method owns the mutation. Mirrors provisionStation's defaults: one TYPE2/22 kW
  // connector unless `connectors[]` is given (GAP-002), status OFFLINE until first socket.
  s.provisionChargePoint = (stationId, b) => {
    const sid = Number(stationId);
    if (!s.stations.get(sid)) {
      const e = new Error('station');
      e.code = 'NOT_FOUND';
      e.status = 404;
      throw e;
    }
    const n = [...s.cps.values()].filter((c) => c.station_id === sid).length + 1;
    const ocpp_identity = b.ocpp_identity || `VH-${sid}-CP${n}`;
    if (s.cpsByOcpp.has(ocpp_identity)) {
      const e = new Error(ocpp_identity);
      e.code = 'DUPLICATE_OCPP_ID';
      e.status = 409;
      throw e;
    }
    const cp_id = ++s.seq.cp;
    const cp = {
      cp_id,
      station_id: sid,
      ocpp_identity,
      auth_secret: b.auth_secret || crypto.randomBytes(18).toString('hex'),
      vendor: b.vendor || 'VoltHub',
      model: b.model || 'VH-DC60',
      firmware_version: '1.6.5',
      status: 'OFFLINE',
      last_boot_at: null,
      last_seen_at: null,
    };
    s.cps.set(cp_id, cp);
    s.cpsByOcpp.set(ocpp_identity, cp_id);
    (b.connectors || [{ standard: 'TYPE2', max_power_kw: 22 }]).forEach((c, k) => {
      const stdRow = s.standards.find((t) => t.code === c.standard) || s.standards[0];
      s.connectors.set(`${cp_id}:${k + 1}`, {
        cp_id,
        connector_no: k + 1,
        standard_id: stdRow.standard_id,
        max_power_kw: Number(c.max_power_kw || 22),
        status: 'AVAILABLE',
        last_state_change_at: new Date().toISOString(),
      });
    });
    return cp;
  };
  // ===================== ADR-0010: FC-HCC control surface =====================
  // All control writes go through the store port (ADR-0005) exactly like the money
  // path: the local store is the reference implementation; db/oracle.js mirrors each
  // method write-through to V007 with the same ids (identity-by-default-on-null).
  // Control errors carry the V007 ORA band on a REAL Error (no-throw-literal): the
  // shared error middleware + oraStatus() key on e.num/e.code/e.status.
  const controlErr = (code, message, status, num) => {
    const e = new Error(message);
    e.code = code;
    e.num = num;
    e.status = status;
    return e;
  };

  // Grid asset CRUD with hierarchy validation mirrored from trg_grid_asset_shape +
  // trg_grid_cap_monotonic (V007). Local engine raises the SAME -2090x codes.
  s.upsertGridAsset = (stationId, b, actor) => {
    const sid = Number(stationId);
    if (!s.stations.get(sid)) {
      const e = err('NOT_FOUND', 'station not found', 404);
      throw e;
    }
    const kind = String(b.kind || '').toUpperCase();
    if (!['SITE', 'PANEL', 'FEEDER'].includes(kind))
      throw controlErr('GRID_ASSET_INVALID', 'kind must be SITE|PANEL|FEEDER', 422, ORA.GRID_ASSET_INVALID);
    const capKw = Number(b.cap_kw);
    if (!(capKw > 0)) throw controlErr('GRID_ASSET_INVALID', 'cap_kw must be > 0', 422, ORA.GRID_ASSET_INVALID);
    const parentId = b.parent_id != null ? Number(b.parent_id) : null;
    if (kind === 'SITE' && parentId != null)
      throw controlErr('GRID_ASSET_INVALID', 'SITE is the root (no parent)', 422, ORA.GRID_ASSET_INVALID);
    if (kind !== 'SITE' && parentId == null)
      throw controlErr('GRID_ASSET_INVALID', kind + ' requires a parent', 422, ORA.GRID_ASSET_INVALID);
    if (parentId != null) {
      const p = s.gridAssets.get(parentId);
      if (!p) throw controlErr('GRID_ASSET_INVALID', 'parent asset not found', 422, ORA.GRID_ASSET_INVALID);
      if (p.station_id !== sid)
        throw controlErr(
          'GRID_CAP_MONOTONIC',
          'parent asset belongs to a different station',
          409,
          ORA.GRID_CAP_MONOTONIC
        );
      if (capKw > p.cap_kw)
        throw controlErr(
          'GRID_CAP_MONOTONIC',
          `child cap ${capKw} kW exceeds parent cap ${p.cap_kw} kW`,
          409,
          ORA.GRID_CAP_MONOTONIC
        );
    }
    // Exactly one non-retired SITE root per station (V007 trigger parity).
    if (kind === 'SITE') {
      const existingRoot = [...s.gridAssets.values()].find(
        (a) => a.station_id === sid && a.kind === 'SITE' && a.status !== 'RETIRED' && a.asset_id !== b.asset_id
      );
      if (existingRoot)
        throw controlErr('GRID_ASSET_INVALID', 'station already has a SITE root', 422, ORA.GRID_ASSET_INVALID);
    }
    // Two-person rule: a cap REDUCTION on an existing asset starts PENDING and needs a
    // second distinct ADMIN approval (blueprint N.1). Increases apply immediately.
    const existing = b.asset_id ? s.gridAssets.get(Number(b.asset_id)) : null;
    const now = new Date().toISOString();
    if (existing && capKw < existing.cap_kw) {
      existing.cap_kw = capKw;
      existing.ramp_kw = b.ramp_kw != null ? Number(b.ramp_kw) : existing.ramp_kw;
      existing.status = 'PENDING';
      existing.proposed_by = actor ?? null;
      existing.approved_by = null;
      existing.updated_at = now;
      s.auditLog(actor, 'GRID_ASSET', existing.asset_id, 'CAP_REDUCE_PROPOSED', existing.cap_kw, capKw);
      return existing;
    }
    if (existing) {
      existing.cap_kw = capKw;
      existing.ramp_kw = b.ramp_kw != null ? Number(b.ramp_kw) : existing.ramp_kw;
      existing.status = 'ACTIVE';
      existing.updated_at = now;
      s.auditLog(actor, 'GRID_ASSET', existing.asset_id, 'UPDATE', null, { cap_kw: capKw });
      return existing;
    }
    const asset_id = ++s.seq.gridAsset;
    const a = {
      asset_id,
      station_id: sid,
      parent_id: parentId,
      kind,
      label: String(b.label || kind + '-' + asset_id),
      cap_kw: capKw,
      ramp_kw: b.ramp_kw != null ? Number(b.ramp_kw) : null,
      status: 'ACTIVE',
      proposed_by: actor ?? null,
      approved_by: null,
      created_at: now,
      updated_at: now,
    };
    s.gridAssets.set(asset_id, a);
    s.auditLog(actor, 'GRID_ASSET', asset_id, 'CREATE', null, { kind, cap_kw: capKw });
    return a;
  };
  // Second-person approval for a PENDING cap reduction (four-eyes on grid edits).
  s.approveGridAsset = (assetId, actor) => {
    const a = s.gridAssets.get(Number(assetId));
    if (!a) throw err('NOT_FOUND', 'grid asset not found', 404);
    if (a.status !== 'PENDING')
      throw controlErr('GRID_ASSET_INVALID', 'asset is not PENDING', 422, ORA.GRID_ASSET_INVALID);
    if (actor != null && a.proposed_by != null && Number(actor) === Number(a.proposed_by))
      throw controlErr(
        'GRID_ASSET_INVALID',
        'the proposer cannot approve their own cap reduction',
        422,
        ORA.GRID_ASSET_INVALID
      );
    a.status = 'ACTIVE';
    a.approved_by = actor ?? null;
    a.updated_at = new Date().toISOString();
    s.auditLog(actor, 'GRID_ASSET', a.asset_id, 'APPROVE', 'PENDING', 'ACTIVE');
    return a;
  };
  // Effective site cap = the SITE root cap (children are always <= parent by monotonicity).
  s.siteCapKw = (stationId) => {
    let cap = Infinity;
    for (const a of s.gridAssets.values()) {
      if (a.station_id === Number(stationId) && a.kind === 'SITE' && a.status === 'ACTIVE')
        cap = Math.min(cap, a.cap_kw);
    }
    return cap;
  };
  // Hourly kWh per station on a contiguous UTC hour grid — the exact shape the AI
  // forecast contract trains on (session COUNTS are not demand; the model is
  // trained on energy, and the contract rejects a history with holes).
  // A session's energy is spread over the hours it overlaps, weighted by the
  // overlap, so a 90-minute charge gives half its kWh to each hour it touched.
  s.hourlyStationKwh = (stationId, hours = 168) => {
    const HOUR_MS = 3600000;
    const sid = Number(stationId);
    const n = Math.max(1, Math.min(Number(hours) || 168, 24 * 31));
    const now = new Date();
    const lastHour = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours());
    const winStart = lastHour - (n - 1) * HOUR_MS;
    const winEnd = lastHour + HOUR_MS;
    const cpIds = new Set([...s.cps.values()].filter((c) => c.station_id === sid).map((c) => Number(c.cp_id)));
    const kwh = new Array(n).fill(0);
    for (const sess of s.sessions.values()) {
      if (!cpIds.has(Number(sess.cp_id))) continue;
      const from = Date.parse(sess.started_at);
      if (!Number.isFinite(from)) continue;
      const endedAt = Date.parse(sess.ended_at ?? '');
      // An active session is still delivering: count it up to the current hour.
      const a = Math.max(from, winStart);
      const b = Math.min(Number.isFinite(endedAt) ? endedAt : winEnd, winEnd);
      if (b <= a) continue;
      let e = Number(sess.energy_kwh);
      if (!(e > 0)) {
        const startM = Number(sess.start_meter_kwh) || 0;
        const endM = Number(sess.end_meter_kwh);
        e = Number.isFinite(endM) ? Math.max(0, endM - startM) : 0;
      }
      if (!(e > 0)) continue;
      const span = b - a;
      for (let i = 0; i < n; i++) {
        const hs = winStart + i * HOUR_MS;
        const ov = Math.min(b, hs + HOUR_MS) - Math.max(a, hs);
        if (ov > 0) kwh[i] += (e * ov) / span;
      }
    }
    const timestamps = [];
    for (let i = 0; i < n; i++) timestamps.push(new Date(winStart + i * HOUR_MS).toISOString());
    return { timestamps, kwh: kwh.map((v) => Math.round(v * 1000) / 1000) };
  };
  s.getControlMode = (siteId) => s.controlMode.get(Number(siteId)) || 'OFF';
  s.setControlMode = (siteId, mode, actor) => {
    const sid = Number(siteId);
    if (!s.stations.get(sid)) throw err('NOT_FOUND', 'station not found', 404);
    if (!['OFF', 'ADVISORY', 'ENFORCED'].includes(mode))
      throw controlErr('GRID_ASSET_INVALID', 'mode must be OFF|ADVISORY|ENFORCED', 422, ORA.GRID_ASSET_INVALID);
    // ENFORCED requires an ACTIVE SITE root (an envelope without a certified cap is a hope).
    if (mode === 'ENFORCED' && s.siteCapKw(sid) === Infinity)
      throw controlErr(
        'GRID_ASSET_INVALID',
        'define an ACTIVE SITE grid asset before ENFORCED mode',
        422,
        ORA.GRID_ASSET_INVALID
      );
    const prev = s.getControlMode(sid);
    s.controlMode.set(sid, mode);
    s.auditLog(actor, 'CONTROL_MODE', sid, 'SET', prev, mode);
    s.emitOutbox('CONTROL_DECISION', `ctlmode:${sid}:${Date.now()}`, { site_id: sid, from: prev, to: mode });
    return { site_id: sid, mode, previous: prev };
  };

  // One optimizer run, append-only. payload_json carries the full x[v][t] schedule.
  s.recordDecision = (siteId, d) => {
    const decision_id = ++s.seq.decision;
    const row = {
      decision_id,
      site_id: Number(siteId),
      horizon_start: d.horizon_start || new Date().toISOString(),
      interval_min: d.interval_min || 15,
      payload_json: d.payload_json || '{}',
      bounds_hash: d.bounds_hash || null,
      solver: d.solver || 'fchcc-lp-merit',
      runtime_ms: d.runtime_ms ?? null,
      state_version: d.state_version ?? null,
      status: 'COMMITTED',
      created_at: new Date().toISOString(),
    };
    s.controlDecisions.set(decision_id, row);
    s.emitOutbox('CONTROL_DECISION', `ctl:${decision_id}`, {
      decision_id,
      site_id: row.site_id,
      horizon: row.interval_min,
      status: 'COMMITTED',
    });
    return row;
  };

  // Admission-time feasibility certificate. Same-transaction discipline: called by the
  // certifier with the session/reservation it covers, so admission and money-path state
  // never diverge (blueprint P.2). worst-case delivered energy must clear the need.
  s.issueCertificate = ({
    sessionId,
    reservationId,
    stationId,
    cpId,
    connectorNo,
    floorKw,
    marginKwh,
    worstCaseKwh,
    requiredKwh,
    deadlineAt,
    decisionId,
    admitted,
  }) => {
    const cert_id = ++s.seq.cert;
    const row = {
      cert_id,
      session_id: sessionId != null ? Number(sessionId) : null,
      reservation_id: reservationId != null ? Number(reservationId) : null,
      station_id: Number(stationId),
      cp_id: Number(cpId),
      connector_no: Number(connectorNo),
      floor_kw: Number(floorKw || 0),
      margin_kwh: Number(marginKwh || 0),
      worst_case_kwh: Number(worstCaseKwh || 0),
      required_kwh: Number(requiredKwh || 0),
      deadline_at: deadlineAt,
      decision_id: decisionId != null ? Number(decisionId) : null,
      status: admitted ? 'ACTIVE' : 'FAILED',
      issued_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      reason: admitted ? null : 'worst-case deliverable energy below required energy minus margin',
    };
    s.certificates.set(cert_id, row);
    s.emitOutbox('CERT_LIFECYCLE', `cert:${cert_id}:ISSUED`, {
      cert_id,
      from: null,
      to: row.status,
      reason: row.reason,
    });
    return row;
  };
  // Certificate state machine (blueprint P.1: ISSUED/ACTIVE/ERODED/FAILED/MET).
  s.transitionCertificate = (certId, to, reason) => {
    const c = s.certificates.get(Number(certId));
    if (!c) throw err('NOT_FOUND', 'certificate not found', 404);
    const legal = {
      ISSUED: ['ACTIVE', 'FAILED'],
      ACTIVE: ['ERODED', 'FAILED', 'MET'],
      ERODED: ['FAILED', 'MET', 'ACTIVE'],
    };
    if (!(legal[c.status] || []).includes(to))
      throw controlErr(
        'ILLEGAL_TRANSITION',
        `certificate ${c.status} -> ${to} is illegal`,
        409,
        ORA.ILLEGAL_TRANSITION
      );
    const from = c.status;
    c.status = to;
    c.reason = reason || c.reason;
    c.updated_at = new Date().toISOString();
    s.emitOutbox('CERT_LIFECYCLE', `cert:${c.cert_id}:${to}:${Date.now()}`, {
      cert_id: c.cert_id,
      from,
      to,
      reason: c.reason,
    });
    return c;
  };

  // Protocol artifact audit: one row per (cp, decision) — idempotent on retry,
  // mirrors uq_push_cp_decision. The gateway records ack_result after CALLRESULT.
  s.recordProfilePush = ({ decisionId, cpId, profilePayload, payloadSha256, clamped }) => {
    const key = `${Number(cpId)}:${Number(decisionId)}`;
    const found = [...s.profilePushes.values()].find(
      (p) => p.cp_id === Number(cpId) && p.decision_id === Number(decisionId)
    );
    if (found) return { row: found, deduped: true };
    const push_id = ++s.seq.push;
    const row = {
      push_id,
      decision_id: Number(decisionId),
      cp_id: Number(cpId),
      profile_payload: profilePayload || '{}',
      payload_sha256: payloadSha256 || null,
      clamped: clamped ? 'Y' : 'N',
      push_at: new Date().toISOString(),
      ack_result: null,
    };
    s.profilePushes.set(push_id, row);
    s._pushKey = s._pushKey || new Map();
    s._pushKey.set(key, push_id);
    s.emitOutbox('PROFILE_PUSHED', `push:${push_id}`, {
      push_id,
      cp_id: row.cp_id,
      decision_id: row.decision_id,
      payload_sha256: row.payload_sha256,
    });
    return { row, deduped: false };
  };
  s.setPushAck = (pushId, ackResult) => {
    const p = s.profilePushes.get(Number(pushId));
    if (p) p.ack_result = String(ackResult || 'UNKNOWN').slice(0, 20);
    return p;
  };
  // Dispatch receipt: the audit row is written BEFORE the wire send (idempotency on
  // (cp, decision)), so "in force on the charger" needs its own mark. Without it a
  // profile that never left the process would still authorise enforcement ticks.
  s.markPushSent = (pushId) => {
    const p = s.profilePushes.get(Number(pushId));
    if (p) p.sent_at = new Date().toISOString();
    return p;
  };
  // The profile currently in force on a charge point: highest push_id that was sent
  // and not answered with a rejection/error. CALLERROR and Rejected both mean "the
  // charger is not following this schedule", so they disqualify the row.
  s.activeProfileFor = (cpId) => {
    let best = null;
    for (const p of s.profilePushes.values()) {
      if (p.cp_id !== Number(cpId)) continue;
      if (!p.sent_at) continue;
      if (p.ack_result && p.ack_result !== 'Accepted') continue;
      if (!best || p.push_id > best.push_id) best = p;
    }
    return best;
  };
  // Scheduled kW at an instant, resolved from the in-force profile's active period
  // (OCPP startPeriod is seconds from startSchedule). Returns null when nothing is
  // in force or when the profile uses current units (not comparable to kW readings —
  // returning a number there would fabricate a comparison).
  s.scheduledKwAt = (cpId, atMs) => {
    const push = s.activeProfileFor(cpId);
    if (!push) return null;
    let prof;
    try {
      prof = JSON.parse(push.profile_payload);
    } catch {
      return null;
    }
    const sch = prof && prof.chargingSchedule;
    if (!sch || sch.chargingRateUnit === 'A') return null;
    const periods = [...(sch.chargingSchedulePeriods || [])].sort((a, b) => a.startPeriod - b.startPeriod);
    if (!periods.length) return null;
    const startMs = sch.startSchedule ? Date.parse(sch.startSchedule) : Date.parse(push.push_at);
    const elapsedS = Math.max(0, ((atMs || Date.now()) - (Number.isFinite(startMs) ? startMs : Date.now())) / 1000);
    const cur = periods.filter((p) => p.startPeriod <= elapsedS).pop();
    if (!cur) return null;
    return +((Number(cur.limit) || 0) / 1000).toFixed(4);
  };
  // Latest committed plan for a site — the durable source of `lastReplanAt` for the
  // hysteresis in model.shouldReplan (a module-level variable would not survive a
  // restart and would make the verifier's cadence untestable).
  s.latestDecisionFor = (siteId) => {
    let best = null;
    for (const d of s.controlDecisions.values()) {
      if (d.site_id !== Number(siteId)) continue;
      if (!best || d.decision_id > best.decision_id) best = d;
    }
    return best;
  };

  // Compliance telemetry: scheduled vs actual kW per CP (Timescale T003 in prod;
  // in-process ring locally). Negative deviation = charger under-delivering.
  s.recordEnforcementTick = ({ cpId, sessionId, decisionId, scheduledKw, actualKw, ts }) => {
    const scheduled = Number(scheduledKw);
    const actual = actualKw == null ? null : Number(actualKw);
    const tick = {
      ts: ts || new Date().toISOString(),
      cp_id: Number(cpId),
      session_id: sessionId != null ? Number(sessionId) : null,
      decision_id: decisionId != null ? Number(decisionId) : null,
      scheduled_kw: scheduled,
      actual_kw: actual,
      deviation_kw: actual == null ? null : +(actual - scheduled).toFixed(4),
    };
    s.enforcementTicks.push(tick);
    if (s.enforcementTicks.length > 5000) s.enforcementTicks.splice(0, s.enforcementTicks.length - 5000);
    // T003 path: rides the same outbox -> relay -> meter_tick_enforcement hypertable
    // channel as telemetry (ADR-0003). Dedupe per (cp, ts, scheduled) like the PK.
    s.emitOutbox('ENFORCEMENT_TICK', `enf:${tick.cp_id}:${tick.ts}:${tick.scheduled_kw}`, tick);
    return tick;
  };

  // Dead letters: poison events + envelope-rejected pushes, operator triage route.
  s.deadLetter = ({ eventRef, kind, reasonCode, detail, payload }) => {
    const key = String(eventRef || '');
    const found = [...s.deadLetters.values()].find((d) => d.event_ref === key);
    if (found) {
      found.last_seen_at = new Date().toISOString();
      return found;
    }
    const letter_id = ++s.seq.letter;
    const row = {
      letter_id,
      event_ref: key,
      kind: String(kind || 'UNKNOWN'),
      reason_code: String(reasonCode || 'UNKNOWN'),
      detail: detail ? String(detail).slice(0, 500) : null,
      payload: payload ? JSON.stringify(payload).slice(0, 2000) : null,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      status: 'OPEN',
    };
    s.deadLetters.set(letter_id, row);
    // The gateway writes a letter for every rejected push, so an off-spec charge
    // point (or a hostile one) would otherwise grow this Map without bound.
    if (s.deadLetters.size > DEAD_LETTER_CAP) {
      const byAge = [...s.deadLetters.values()].sort(
        (a, b) => (a.status === 'OPEN') - (b.status === 'OPEN') || a.letter_id - b.letter_id
      );
      for (const d of byAge.slice(0, s.deadLetters.size - DEAD_LETTER_CAP)) s.deadLetters.delete(d.letter_id);
    }
    return row;
  };
  s.listDeadLetters = (status = 'OPEN') =>
    [...s.deadLetters.values()].filter((d) => d.status === status).sort((a, b) => b.letter_id - a.letter_id);
  s.resolveDeadLetter = (letterId, action, actor) => {
    const d = s.deadLetters.get(Number(letterId));
    if (!d) throw err('NOT_FOUND', 'dead letter not found', 404);
    if (!['REPLAYED', 'DISMISSED'].includes(action))
      throw controlErr('GRID_ASSET_INVALID', 'action must be REPLAYED|DISMISSED', 422, ORA.GRID_ASSET_INVALID);
    d.status = action;
    d.last_seen_at = new Date().toISOString();
    s.auditLog(actor, 'DEAD_LETTER', d.letter_id, action, 'OPEN', action);
    return d;
  };

  // BUG-047: station metadata updates (PATCH /admin/stations/:id) extracted into a store
  // method so the adapter can mirror them. Returns { station, prev } — prev is the undo
  // snapshot for the mirror. Route keeps HTTP validation (BUG-034 status allow-list).
  s.updateStation = (id, fields) => {
    const st = s.stations.get(Number(id));
    if (!st) {
      const e = new Error('station');
      e.code = 'NOT_FOUND';
      e.status = 404;
      throw e;
    }
    const prev = { status: st.status, operator_id: st.operator_id, name: st.name };
    if (fields.status) st.status = fields.status;
    if (fields.operator_id !== undefined) st.operator_id = fields.operator_id;
    if (fields.name) st.name = fields.name;
    return { station: st, prev };
  };
  return s;
}

// SEC-011: fixed dummy hash so unknown-email logins burn the same Argon2id cost
// as real ones (defeats user enumeration by response timing). Same parameters as
// ARGON2_POLICY, so the unknown path costs exactly what a real verify costs;
// this value never authenticates anyone.
const DUMMY_PASSWORD_HASH = hashPassword('sec-011-timing-pad-v1:not-a-real-user');

module.exports = {
  createStore,
  hashPassword,
  hashPasswordAsync,
  verifyPassword,
  verifyPasswordAsync,
  DUMMY_PASSWORD_HASH,
  ORA,
};
