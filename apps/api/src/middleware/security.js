// Helmet-lite security headers + per-role request throttle.
// Masterplan §30/§32: 60 req/min DRIVER, 120 OPERATOR/ADMIN (sliding 60s window).
// Bypass with RATE_LIMIT_OFF=1 (tests). Counts per authenticated user, else IP.
// SEC-009: minimal CSP (no inline-script reliance in API; web layer adds its own).
'use strict';
const jwt = require('jsonwebtoken');

function securityHeaders(req, res, next) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(self)');
  // SEC-009: API serves JSON only — lock down to self; connect-src left to the web app's own CSP.
  res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (req.secure || (req.headers['x-forwarded-proto'] || '') === 'https') {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

const windows = new Map(); // key -> [timestamps]
const loginWindows = new Map(); // B2G-010: per-IP login throttle buckets
// B2G-010: login tier — key 'login:'+ip, limit 10/min, checked inside POST /auth/login.
function checkLoginThrottle(req, res) {
  if (process.env.RATE_LIMIT_OFF === '1') return true;
  const id = `login:${req.ip}`;
  const now = Date.now();
  const arr = (loginWindows.get(id) || []).filter((t) => now - t < 60000);
  arr.push(now);
  loginWindows.set(id, arr);
  if (arr.length > 10) {
    res.setHeader('retry-after', '60');
    res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'too many login attempts, try again in 60s' } });
    return false;
  }
  return true;
}
// BUG-015: stale IP/user buckets are evicted (idle > 2 min) so the map cannot grow unbounded.
function sweepIdle(now = Date.now()) {
  for (const [k, arr] of windows) {
    const fresh = arr.filter((t) => now - t < 120000);
    if (!fresh.length) windows.delete(k);
    else if (fresh.length !== arr.length) windows.set(k, fresh);
  }
}
setInterval(() => {
  try {
    sweepIdle();
  } catch {}
}, 60000).unref?.();

function throttle(req, res, next) {
  if (process.env.RATE_LIMIT_OFF === '1') return next();
  // SEC-006: tier only from signature-verified claims. Unverified/forged tokens get ANON tier.
  // Order note: throttle runs before authRequired, so we verify (not decode) here read-only.
  let role = 'ANON';
  let sub = null;
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    try {
      const p = jwt.verify(h.slice(7), process.env.JWT_SECRET || 'dev-only-32-byte-secret-0123456789', {
        algorithms: ['HS256'],
      });
      role = p.role || 'DRIVER';
      sub = p.sub ?? null;
    } catch {
      role = 'ANON';
      sub = null;
    }
  }
  const limit = Number(process.env.RATE_LIMIT_USER || (role === 'DRIVER' || role === 'ANON' ? 60 : 120));
  // SEC-006: key by verified sub when available, else IP — distinct tokens for one user share a bucket.
  const id = sub != null ? `u:${sub}` : `ip:${req.ip}`;
  const now = Date.now();
  const arr = (windows.get(id) || []).filter((t) => now - t < 60000);
  arr.push(now);
  windows.set(id, arr);
  res.setHeader('x-ratelimit-limit', limit);
  res.setHeader('x-ratelimit-remaining', Math.max(0, limit - arr.length));
  if (arr.length > limit) {
    res.setHeader('retry-after', '60');
    return res.status(429).json({ error: { code: 'RATE_LIMITED', message: `slow down: ${limit} req/min` } });
  }
  next();
}

module.exports = {
  securityHeaders,
  throttle,
  checkLoginThrottle,
  _windows: windows,
  _sweepIdle: sweepIdle,
  _loginWindows: loginWindows,
};
