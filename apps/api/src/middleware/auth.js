// Auth: scrypt (local) / Argon2id-note (prod docs) + 15-min JWT + rotating refresh with family revocation.
'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { verifyPassword } = require('../db/store');

const JWT_TTL = '15m';
const DEV_SECRET = 'dev-only-32-byte-secret-0123456789';
// SEC-002: fail-fast when a production deploy boots with a missing/known-default secret.
// Demo compose (ORACLE_HOST set, NODE_ENV unset) boots with a loud warning instead —
// one-command demo must work; production (`NODE_ENV=production`) must not.
function secret() {
  const s = process.env.JWT_SECRET;
  const prod = process.env.NODE_ENV === 'production';
  if (!s || s === DEV_SECRET) {
    if (prod) {
      console.error('[auth] FATAL: JWT_SECRET missing or default with NODE_ENV=production. Set a 32-byte random secret.');
      process.exit(1);
    }
    if (!secret._warned) {
      secret._warned = true;
      console.warn('[auth] WARNING: JWT_SECRET is default/missing (demo only — set a 32-byte secret for any deploy).');
    }
    return DEV_SECRET;
  }
  return s;
}

function stationScopeFor(store, user) {
  try {
    return [...(store?.stations?.values() || [])].filter(s => s.operator_id === user.user_id).map(s => s.station_id);
  } catch { return []; }
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
    ? Math.max(0, ...[...store.refresh.values()].filter(t => t.family_id === familyId).map(t => t.generation || 0)) + 1
    : 0;
  store.refresh.set(h, { token_hash: h, user_id: user.user_id, device_label: device || null, family_id: fam, generation: gen, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30 * 86400000).toISOString(), revoked_at: null });
  return raw;
}
// BUG-011: reuse of a revoked token revokes its whole family (theft detection), then 401s.
function consumeRefresh(store, raw) {
  const h = crypto.createHash('sha256').update(String(raw || '')).digest('hex');
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
function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: { code: 'NO_TOKEN', message: 'missing bearer token' } });
  try {
    const p = jwt.verify(tok, secret());
    req.user = { id: p.sub, role: p.role, stationScope: p.stationScope || [] };
    next();
  } catch { return res.status(401).json({ error: { code: 'BAD_TOKEN', message: 'invalid/expired token' } }); }
}
function roles(...allowed) {
  return (req, res, next) => {
    if (!allowed.includes(req.user.role)) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'role not allowed' } });
    next();
  };
}
// Operator station scoping for station mutations.
function scopeCheck(req, res, next) {
  if (req.user.role === 'ADMIN') return next();
  if (req.user.role === 'OPERATOR') {
    const sid = Number(req.params.id || req.body.stationId || req.query.stationId);
    if (sid && !(req.user.stationScope || []).includes(sid)) {
      // allow reads of all stations, scope only mutations
      if (req.method !== 'GET') return res.status(403).json({ error: { code: 'OUT_OF_SCOPE', message: 'station not assigned' } });
    }
  }
  next();
}

module.exports = { signAccess, issueRefresh, consumeRefresh, authRequired, roles, scopeCheck, verifyPassword, secret, stationScopeFor };
