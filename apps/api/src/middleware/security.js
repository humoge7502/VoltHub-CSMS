// Helmet-lite security headers + the rate-limit tiers: the global per-role request
// throttle, the per-IP login tier, and the per-surface router barriers.
// Masterplan §30/§32: 60 req/min DRIVER, 120 OPERATOR/ADMIN (sliding 60s window).
// Bypass with RATE_LIMIT_OFF=1 (tests). Counts per authenticated user, else IP —
// bucket identity is the VERIFIED subject in all three tiers (verifiedClaims below).
// Evidence: apps/api/test/ratelimit.js (the one suite that runs with limiting on).
// SEC-009: minimal CSP (no inline-script reliance in API; web layer adds its own).
'use strict';
const jwt = require('jsonwebtoken');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
// BUG-036: import the auth module's secret() instead of re-hardcoding the dev
// default — the throttle previously kept its own copy of the literal, so a future
// change to the dev secret would silently desync the two verifiers.
const { secret: jwtSecret } = require('./auth');

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

// Is this request on the worker's internal channel (`/internal/*`)?
// BUG-051: the throttle is mounted at the APP ROOT, so `req.path` there is the full
// '/api/v1/internal/outbox' — the old `req.path.startsWith('/internal')` never matched,
// so the public per-IP ANON tier (60/min) throttled the relay instead. The worker polls
// three internal endpoints every 2 s (~90 req/min from one IP) and starved on 429s: the
// outbox stopped draining and Timescale telemetry went stale. Match the full URL so the
// exclusion works whether the middleware runs at the app or inside a router.
function isInternalPath(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  return path.startsWith('/internal') || /^\/api\/v\d+\/internal(\/|$)/.test(path);
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
// BUG-015: stale IP/user buckets are evicted (idle > 2 min) so neither map can grow
// unbounded — BUG-025 fix: the login throttle map is swept too (it used to be skipped,
// so buckets for one-shot/scanner IPs accumulated forever).
function sweepIdle(now = Date.now()) {
  for (const [k, arr] of windows) {
    const fresh = arr.filter((t) => now - t < 120000);
    if (!fresh.length) windows.delete(k);
    else if (fresh.length !== arr.length) windows.set(k, fresh);
  }
  for (const [k, arr] of loginWindows) {
    const fresh = arr.filter((t) => now - t < 120000);
    if (!fresh.length) loginWindows.delete(k);
    else if (fresh.length !== arr.length) loginWindows.set(k, fresh);
  }
  for (const [k, arr] of customWindows) {
    const fresh = arr.filter((t) => now - t < 120000);
    if (!fresh.length) customWindows.delete(k);
    else if (fresh.length !== arr.length) customWindows.set(k, fresh);
  }
}

// SEC-006: bucket identity comes from the SIGNATURE-VERIFIED token, never from the raw
// header — a forged, tampered or expired bearer token degrades to the IP bucket instead
// of letting the caller choose its own key. Single source of truth for both the global
// per-role throttle and the router barriers below (they must agree on who a caller is).
function verifiedClaims(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  try {
    // B2G-010: pin the algorithm at every verify site (no `alg: none` / RS256 confusion).
    const p = jwt.verify(h.slice(7), jwtSecret(), { algorithms: ['HS256'] });
    return { role: p.role || 'DRIVER', sub: p.sub ?? null };
  } catch {
    return null;
  }
}

// Tiered route limiters (2026-09-14 CodeQL hardening): the control plane's
// mutating routes (grid caps, mode flips, plan cycles, dead-letter resolves)
// authorize on every call and actuate real hardware, so they get their own
// stricter sliding window instead of relying on the global per-role throttle.
// 30/min per user is generous for humans and the console's 15 s polls while
// staying far below the 6/min/CP push governance in ocpp/smart-charging.js.
const customWindows = new Map(); // key -> [timestamps] shared by makeLimiter tiers
function makeLimiter({ key, limit }) {
  return function limited(req, res, next) {
    if (process.env.RATE_LIMIT_OFF === '1') return next();
    const id = `${key}:${req.user?.id ?? req.ip}`;
    const now = Date.now();
    const arr = (customWindows.get(id) || []).filter((t) => now - t < 60000);
    arr.push(now);
    customWindows.set(id, arr);
    res.setHeader('x-ratelimit-limit', limit);
    res.setHeader('x-ratelimit-remaining', Math.max(0, limit - arr.length));
    if (arr.length > limit) {
      res.setHeader('retry-after', '60');
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: `slow down: ${limit} req/min` } });
    }
    next();
  };
}
setInterval(() => {
  try {
    sweepIdle();
  } catch {}
}, 60000).unref?.();

// Router barriers (2026-09-14/15 CodeQL hardening). Every authorizing surface
// (routes.js, extended.js, control-routes.js) mounts one of these ahead of its
// handlers, so no route in the API reaches a handler without a recognized limiter
// in front of it. Buckets are keyed by the SEC-006 identity — the verified `sub`
// when the token is valid, else the IPv6-safe IP (ipKeyGenerator collapses IPv6
// /64s so one client cannot rotate addresses past the cap).
//
// Honest scope, because a security control that overstates itself is worse than none:
// the global per-role throttle in server.js is still the binding limit (60/min DRIVER,
// 120/min OPERATOR|ADMIN). These barriers sit AT OR ABOVE that tier, so they are a
// backstop for surfaces the global tier does not key, and a defense-in-depth net if the
// middleware order ever changes — not a new cap on normal traffic. The control plane is
// the one stricter tier (30/min) because those routes actuate real hardware.
//
// `limit` is the per-window cap, `key` namespaces the bucket so two barriers on the
// same surface never collide, `message` lets the stricter tier say why it fired.
function routerBarrier({ key, limit, message }) {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const sub = verifiedClaims(req)?.sub;
      return sub != null ? `${key}:u:${sub}` : `${key}:ip:${ipKeyGenerator(req.ip)}`;
    },
    // BUG-051: the internal worker channel is never subject to user-facing tiers — the
    // same exclusion the global throttle below applies (and, before the fix, failed to).
    skip: (req) => process.env.RATE_LIMIT_OFF === '1' || isInternalPath(req),
    handler: (req, res) => {
      res.setHeader('retry-after', '60');
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: message || `slow down: ${limit} req/min` } });
    },
  });
}

function throttle(req, res, next) {
  if (process.env.RATE_LIMIT_OFF === '1') return next();
  // /internal/* is the worker channel: token-gated (SEC-007 constant-time compare) and
  // polled every 2s (outbox + station-map + expire ≈ 90 req/min) — the public per-IP
  // throttle must not apply, or the relay starves on 429s. BUG-051: this check used to
  // test `req.path` from the app root (where it is '/api/v1/internal/...' and never
  // matched), so the exclusion existed in prose but not in effect — see isInternalPath().
  if (isInternalPath(req)) return next();
  // SEC-006: tier only from signature-verified claims. Unverified/forged tokens get ANON tier.
  // Order note: throttle runs before authRequired, so we verify (not decode) here read-only.
  const claims = verifiedClaims(req);
  const role = claims ? claims.role : 'ANON';
  const sub = claims ? claims.sub : null;
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
  makeLimiter,
  routerBarrier,
  _verifiedClaims: verifiedClaims,
  _windows: windows,
  _sweepIdle: sweepIdle,
  _loginWindows: loginWindows,
  _customWindows: customWindows,
};
