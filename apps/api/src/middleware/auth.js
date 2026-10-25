// Auth: scrypt (local) / Argon2id-note (prod docs) + 15-min JWT + rotating refresh with family revocation.
// SEC-012 (P2 closed): the refresh token rides an httpOnly cookie scoped to the auth paths;
// the JSON body field remains for non-browser clients (documented, both are accepted).
'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { verifyPassword } = require('../db/store');

const JWT_TTL = '15m';
const REFRESH_TTL_DAYS = 30;
const REFRESH_COOKIE = 'vh_rt';
// SEC-002/SEC-060: there is NO known default signing key. Production fails closed;
// development gets a per-process random key (unguessable, but tokens do not survive a
// restart — acceptable for the local demo, never for a multi-replica deployment).
// SEC-069: values that ship in .env.example / infra/docker-compose.yml are long enough to
// pass a length check but are public — they must never sign tokens in production.
const PUBLIC_DEV_SECRETS = new Set(['dev-only-32-byte-secret-0123456789', 'replace_with_32_random_bytes', 'change_me']);
let _secretCache = null;
function secret() {
  if (_secretCache) return _secretCache;
  const s = process.env.JWT_SECRET;
  const prod = process.env.NODE_ENV === 'production';
  if (s && s.length >= 32 && !PUBLIC_DEV_SECRETS.has(s)) {
    _secretCache = s;
    return _secretCache;
  }
  if (prod) {
    console.error(
      '[auth] FATAL: JWT_SECRET missing, shorter than 32 bytes, or a published dev value with NODE_ENV=production. Set a random 32+ byte secret.'
    );
    process.exit(1);
  }
  _secretCache = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] JWT_SECRET missing/weak — generated an ephemeral per-process key (tokens reset on restart).');
  return _secretCache;
}

// Boot-time secret discipline: production must fail before the first request, not when a
// driver first tries to log in. Also refuses a dead /internal surface (worker relay).
function assertBootSecrets() {
  secret();
  if (process.env.NODE_ENV !== 'production') return;
  const t = process.env.INTERNAL_TOKEN;
  if (!t || t.length < 24 || t === 'dev-internal' || /^replace_with_/.test(t)) {
    console.error(
      '[auth] FATAL: INTERNAL_TOKEN missing, shorter than 24 chars, or a published dev value with NODE_ENV=production.'
    );
    process.exit(1);
  }
}

function stationScopeFor(store, user) {
  try {
    return [...(store?.stations?.values() || [])]
      .filter((s) => s.operator_id === user.user_id)
      .map((s) => s.station_id);
  } catch {
    return [];
  }
}

// TD-07: explicit store injection — global.__store fallback kept only for legacy callers/tests.
function signAccess(user, store) {
  const src = store || global.__store;
  const opStations = stationScopeFor(src, user);
  return jwt.sign({ sub: user.user_id, role: user.role, stationScope: opStations }, secret(), { expiresIn: JWT_TTL });
}
function issueRefresh(store, user, device, familyId) {
  const raw = crypto.randomBytes(32).toString('hex');
  const h = crypto.createHash('sha256').update(raw).digest('hex');
  const fam = familyId || crypto.randomBytes(16).toString('hex');
  const gen = familyId
    ? Math.max(
        0,
        ...[...store.refresh.values()].filter((t) => t.family_id === familyId).map((t) => t.generation || 0)
      ) + 1
    : 0;
  store.refresh.set(h, {
    token_hash: h,
    user_id: user.user_id,
    device_label: device || null,
    family_id: fam,
    generation: gen,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    revoked_at: null,
  });
  return raw;
}
// BUG-011: reuse of a revoked token revokes its whole family (theft detection), then 401s.
function consumeRefresh(store, raw) {
  const h = crypto
    .createHash('sha256')
    .update(String(raw || ''))
    .digest('hex');
  const t = store.refresh.get(h);
  if (!t) return { ok: false, reason: 'unknown' };
  if (t.revoked_at) {
    // Compromise signal: burn the family so sibling tokens cannot be replayed.
    for (const sib of store.refresh.values()) {
      if (sib.family_id && sib.family_id === t.family_id) sib.revoked_at = sib.revoked_at || new Date().toISOString();
    }
    return { ok: false, reason: 'revoked-reuse', familyRevoked: true };
  }
  if (new Date(t.expires_at) < new Date()) return { ok: false, reason: 'expired' };
  return { ok: true, token: t };
}
// SEC-012: refresh-token cookie helpers — httpOnly keeps the token out of any
// script-reachable store; Path scope keeps it off every other request; Secure in
// production; SameSite=Lax tops up the CSRF story (rotation + family revocation
// already bound replay).
function setRefreshCookie(res, raw) {
  res.cookie(REFRESH_COOKIE, raw, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/api/v1/auth',
    secure: process.env.NODE_ENV === 'production',
    maxAge: REFRESH_TTL_DAYS * 86400000,
  });
}
function clearRefreshCookie(res) {
  res.cookie(REFRESH_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/api/v1/auth',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 0,
  });
}
function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: { code: 'NO_TOKEN', message: 'missing bearer token' } });
  let p;
  try {
    p = jwt.verify(tok, secret(), { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: { code: 'BAD_TOKEN', message: 'invalid/expired token' } });
  }
  // SEC-061: a 15-minute bearer token must not outlive the account it names. Login
  // already rejects suspended users, but without this check a suspension (or a role
  // downgrade) had no effect until the token expired — and refresh could renew forever.
  const store = global.__store;
  const user = store?.users?.get?.(Number(p.sub));
  if (store?.users && !user) {
    return res.status(401).json({ error: { code: 'USER_GONE', message: 'account no longer exists' } });
  }
  if (user && user.status !== 'ACTIVE') {
    return res.status(403).json({ error: { code: 'SUSPENDED', message: 'account suspended' } });
  }
  // The database is authoritative for role and station scope: an ADMIN can revoke an
  // operator's station without waiting for a token to expire.
  const role = user?.role || p.role;
  req.user = {
    id: p.sub,
    role,
    stationScope: role === 'OPERATOR' && store ? stationScopeFor(store, user || { user_id: p.sub }) : [],
  };
  next();
}
function roles(...allowed) {
  return (req, res, next) => {
    if (!allowed.includes(req.user.role))
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'role not allowed' } });
    next();
  };
}
// Operator station scoping for station mutations.
function scopeCheck(req, res, next) {
  if (req.user.role === 'ADMIN') return next();
  if (req.user.role === 'OPERATOR') {
    // B2G-010: reject NaN explicitly — malformed stationId must not skip enforcement.
    const raw = req.params.id ?? req.body.stationId ?? req.query.stationId;
    const sid = Number(raw);
    if (!Number.isNaN(sid) && sid && !(req.user.stationScope || []).includes(sid)) {
      // allow reads of all stations, scope only mutations
      if (req.method !== 'GET')
        return res.status(403).json({ error: { code: 'OUT_OF_SCOPE', message: 'station not assigned' } });
    }
  }
  next();
}

// B2G-002/003: object-level authorization. DRIVER must own the object;
// OPERATOR must own the station (via stationScope); ADMIN bypasses.
function requireOwned(store, kind) {
  return (req, res, next) => {
    if (req.user.role === 'ADMIN') return next();
    const id = Number(req.params.id);
    if (kind === 'session') {
      const s = store.sessions.get(id);
      if (!s) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'session' } });
      if (req.user.role === 'DRIVER' && s.user_id !== req.user.id)
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'not your session' } });
      if (req.user.role === 'OPERATOR') {
        const stationId = store.cps.get(Number(String(s.connector_ref).split(':')[0]))?.station_id;
        // SEC-062: fail closed. The old `stationId &&` guard let an orphaned/unknown
        // connector (no CP row in the read cache) bypass the operator scope check.
        if (!stationId || !(req.user.stationScope || []).includes(stationId))
          return res.status(403).json({ error: { code: 'OUT_OF_SCOPE', message: 'station not assigned' } });
      }
    }
    if (kind === 'invoice') {
      const inv = store.invoices.get(id);
      if (!inv) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'invoice' } });
      const sess = store.sessions.get(inv.session_id);
      // B3G-005: total guard — orphaned invoices (no session) deny non-admins outright.
      if (!sess) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'not your invoice' } });
      if (req.user.role === 'DRIVER' && sess.user_id !== req.user.id)
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'not your invoice' } });
      if (req.user.role === 'OPERATOR') {
        const stationId = store.cps.get(Number(String(sess.connector_ref).split(':')[0]))?.station_id;
        if (!stationId || !(req.user.stationScope || []).includes(stationId))
          return res.status(403).json({ error: { code: 'OUT_OF_SCOPE', message: 'station not assigned' } });
      }
    }
    next();
  };
}

// Shared station-scope predicate for list endpoints (reservations/invoices/faults),
// so operator tenancy is enforced identically everywhere instead of per-route ad hoc.
function stationInScope(store, user, connectorRefOrStationId) {
  if (user.role === 'ADMIN') return true;
  if (user.role !== 'OPERATOR') return false;
  let stationId = Number(connectorRefOrStationId);
  if (!Number.isFinite(stationId)) return false;
  if (!store.stations.has(stationId)) {
    const cp = store.cps.get(Number(String(connectorRefOrStationId).split(':')[0]));
    stationId = cp?.station_id;
  }
  return Number.isFinite(stationId) && (user.stationScope || []).includes(stationId);
}

module.exports = {
  signAccess,
  issueRefresh,
  consumeRefresh,
  authRequired,
  roles,
  scopeCheck,
  requireOwned,
  stationInScope,
  verifyPassword,
  secret,
  assertBootSecrets,
  stationScopeFor,
  setRefreshCookie,
  clearRefreshCookie,
  REFRESH_COOKIE,
  REFRESH_TTL_DAYS,
};
