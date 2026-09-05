// Auth: scrypt (local) / Argon2id (prod) + 15-min JWT + rotating refresh.
'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { verifyPassword } = require('../db/store');

const JWT_TTL = '15m';
function secret() { return process.env.JWT_SECRET || 'dev-only-32-byte-secret-0123456789'; }

function signAccess(user) {
  const opStations = [...(global.__store?.stations.values() || [])]
    .filter(s => s.operator_id === user.user_id).map(s => s.station_id);
  return jwt.sign({ sub: user.user_id, role: user.role, stationScope: opStations }, secret(), { expiresIn: JWT_TTL });
}
function issueRefresh(store, user, device) {
  const raw = crypto.randomBytes(32).toString('hex');
  const h = crypto.createHash('sha256').update(raw).digest('hex');
  store.refresh.set(h, { token_hash: h, user_id: user.user_id, device_label: device || null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30 * 86400000).toISOString(), revoked_at: null });
  return raw;
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

module.exports = { signAccess, issueRefresh, authRequired, roles, scopeCheck, verifyPassword };
