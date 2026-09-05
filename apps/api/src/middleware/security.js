// Helmet-lite security headers + per-role request throttle.
// Masterplan §30/§32: 60 req/min DRIVER, 120 OPERATOR/ADMIN (sliding 60s window).
// Bypass with RATE_LIMIT_OFF=1 (tests). Counts per authenticated user, else IP.
'use strict';

function securityHeaders(req, res, next) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(self)');
  if (req.secure || (req.headers['x-forwarded-proto'] || '') === 'https') {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

const windows = new Map(); // key -> [timestamps]
function throttle(req, res, next) {
  if (process.env.RATE_LIMIT_OFF === '1') return next();
  let role = 'ANON';
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    try {
      const payload = JSON.parse(Buffer.from(h.slice(7).split('.')[1], 'base64').toString());
      role = payload.role || 'DRIVER';
    } catch { /* treat as anon */ }
  }
  const limit = Number(process.env.RATE_LIMIT_USER || (role === 'DRIVER' || role === 'ANON' ? 60 : 120));
  const id = h ? `u:${h.slice(-16)}` : `ip:${req.ip}`;
  const now = Date.now();
  const arr = (windows.get(id) || []).filter(t => now - t < 60000);
  arr.push(now); windows.set(id, arr);
  res.setHeader('x-ratelimit-limit', limit);
  res.setHeader('x-ratelimit-remaining', Math.max(0, limit - arr.length));
  if (arr.length > limit) {
    res.setHeader('retry-after', '60');
    return res.status(429).json({ error: { code: 'RATE_LIMITED', message: `slow down: ${limit} req/min` } });
  }
  next();
}

module.exports = { securityHeaders, throttle };
