// Rate-limit tier tests — the one suite that runs with limiting ON.
//
// Why this file exists: every other API suite sets RATE_LIMIT_OFF=1 (throttling would
// make ordinary request/response assertions flaky), so the throttles and the router
// barriers were the only security controls in the repo with no executable evidence.
// A limiter that cannot be shown to fire — and to key on the identity it claims — is a
// comment, not a control. This suite pins the tier's actual behavior over HTTP.
//
// It also pins the BUG this fix closes: the router barriers were mounted ahead of
// authRequired, so `req.user` was always undefined when the key generator ran and every
// caller on one host shared a single IP bucket — the comments said "per user", the code
// said "per IP". RL-2 fails against that build (the second user is rejected by the
// first user's bucket) and passes against the shared verified-subject barrier.
// Run: node apps/api/test/ratelimit.js
'use strict';
// Self-contained: an ambient RATE_LIMIT_OFF (e.g. a compose env) would make this suite
// pass vacuously, and RATE_LIMIT_USER must be high or the global per-role throttle
// would mask the barrier we are measuring (that masking is exactly why the barriers are
// documented as a backstop rather than a new cap).
delete process.env.RATE_LIMIT_OFF;
process.env.RATE_LIMIT_USER = '100000';
const assert = require('assert');

async function main() {
  process.env.PORT = '4105';
  const { server } = require('../src/server');
  await new Promise((r) => server.listen(4105, r));
  const B = 'http://localhost:4105/api/v1';
  // `headers: {origin: ...}` + explicit bearer tokens only; no cookies are needed here.
  const api = async (p, o = {}) => {
    const { headers, ...rest } = o;
    const r = await fetch(B + p, { ...rest, headers: { 'content-type': 'application/json', ...(headers || {}) } });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, j, headers: r.headers };
  };
  let pass = 0;
  const t = async (name, fn) => {
    await fn();
    pass++;
    console.log(`  ok ${pass} - ${name}`);
  };

  const reg = async (tag) => {
    const email = `rl-${tag}-${Date.now()}@example.in`;
    const { status, j } = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'Driver@123', full_name: `RL ${tag}` }),
    });
    assert.equal(status, 201, `register ${tag} -> 201`);
    return j.accessToken;
  };
  const tokA = await reg('a');
  const tokB = await reg('b');
  const H = (tok) => ({ Authorization: `Bearer ${tok}` });

  // The barrier this suite measures is router-wide, so a driver token is enough:
  // identity is what is under test, not authority.
  const BARRIER_LIMIT = 120;

  await t('RL-1: the router barrier fires past its tier with a typed 429 + Retry-After', async () => {
    let ok = 0;
    let rejected = null;
    // Calls /stations (routes.js surface). Send the token so the bucket is the user's.
    for (let i = 0; i < 140; i++) {
      const r = await api('/stations', { headers: H(tokA) });
      if (r.status === 200) ok++;
      else {
        rejected = r;
        break;
      }
    }
    assert.ok(rejected, 'the barrier must reject before 140 requests');
    assert.equal(rejected.status, 429);
    assert.equal(rejected.j.error.code, 'RATE_LIMITED');
    assert.equal(rejected.headers.get('retry-after'), '60');
    // Draft-7 headers are advertised on the successes, and the tier is the documented one.
    assert.match(String(rejected.headers.get('ratelimit') || ''), /limit=120/);
    // Registration spent part of the same bucket, so the ceiling is exact-or-below.
    assert.ok(ok >= BARRIER_LIMIT - 5 && ok <= BARRIER_LIMIT, `expected ~${BARRIER_LIMIT} allowed requests, saw ${ok}`);
  });

  await t('RL-2: buckets are per USER, not per IP — the bug this fix closes', async () => {
    // Same IP, different user. Before the shared verified-subject barrier both callers
    // keyed to `…:ip:127.0.0.1`, so this request was 429'd by user A's exhaustion.
    const r = await api('/stations', { headers: H(tokB) });
    assert.equal(r.status, 200, 'a second user on the same IP must keep its own budget');
  });

  await t('RL-3: the whole-/api/v1 envelope is shared, not per-router', async () => {
    // Express runs a mounted router's middleware BEFORE route matching, so the
    // routes.js barrier sees every /api/v1 request — including /docs, which is declared
    // only in extended.js. This pins the real shape of the tier (documented in
    // middleware/security.js): one envelope for the API, not one budget per router.
    // tokA is exhausted, so an extended-only path must be rejected too.
    const r = await api('/docs', { headers: H(tokA) });
    assert.equal(r.status, 429, 'an extended-only path rides the same envelope');
    // …and it is the same typed rejection, not a 500 from an inner layer.
    assert.equal(r.j.error.code, 'RATE_LIMITED');
  });

  await t('RL-3b: the control plane is the one strictly stricter tier (30/min)', async () => {
    // tokB is fresh on the 120 envelope but the control surface carries its own 30/min
    // tier (plus a per-IP backstop), because those routes actuate real hardware.
    let saw403 = 0;
    let rejected = null;
    for (let i = 0; i < 35; i++) {
      // A driver cannot read the control plane — 403 until the tier trips, proving the
      // limiter runs ahead of authorization rather than being dead code behind it.
      const r = await api('/ops/dead-letters', { headers: H(tokB) });
      if (r.status === 403) saw403++;
      else if (r.status === 429) {
        rejected = r;
        break;
      } else assert.fail(`unexpected status ${r.status} on the control surface`);
    }
    assert.ok(saw403 > 0, 'requests are authorized-checked while the tier has room');
    assert.ok(rejected, 'the control tier must trip at 30/min, well below the 120 envelope');
    assert.equal(rejected.j.error.code, 'RATE_LIMITED');
    assert.equal(rejected.headers.get('retry-after'), '60');
  });

  await t('RL-4: RATE_LIMIT_OFF bypasses the barrier (load tests rely on it)', async () => {
    process.env.RATE_LIMIT_OFF = '1';
    try {
      const r = await api('/stations', { headers: H(tokA) });
      assert.equal(r.status, 200, 'exhausted bucket must be bypassed while RATE_LIMIT_OFF=1');
    } finally {
      delete process.env.RATE_LIMIT_OFF;
    }
    // …and the tier is enforced again the moment the toggle is cleared.
    const after = await api('/stations', { headers: H(tokA) });
    assert.equal(after.status, 429, 'the toggle must be read per request, not at boot');
  });

  await t('RL-5: bucket identity is the VERIFIED subject — forged tokens fall to the IP key', async () => {
    const sec = require('../src/middleware/security');
    const good = sec._verifiedClaims({ headers: { authorization: `Bearer ${tokA}` } });
    assert.ok(good && good.sub, 'a valid token yields a verified sub');
    assert.notEqual(String(good.sub), '', 'sub must not be empty');
    // A tampered token, a token signed with a different secret, and a header-less
    // request must all degrade to null — never to a caller-chosen key.
    const [, payload, sig] = String(tokA).split('.');
    const swapped = Buffer.from(JSON.stringify({ sub: 'admin', role: 'ADMIN' })).toString('base64url');
    assert.equal(sec._verifiedClaims({ headers: { authorization: `Bearer x.${swapped}.${sig}` } }), null);
    assert.equal(sec._verifiedClaims({ headers: { authorization: `Bearer ${payload}.${swapped}.${sig}` } }), null);
    assert.equal(sec._verifiedClaims({ headers: {} }), null);
  });

  await t('RL-6: login tier — 10 attempts/min per IP, then 429 with Retry-After', async () => {
    const email = `rl-login-${Date.now()}@example.in`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'Driver@123', full_name: 'RL Login' }),
    });
    let rejected = null;
    for (let i = 0; i < 12; i++) {
      const r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'Wrong@123' }) });
      if (r.status === 429) {
        rejected = r;
        break;
      }
      assert.equal(r.status, 401, 'wrong credentials are 401 until the tier trips');
    }
    assert.ok(rejected, 'the login throttle must trip within 12 attempts');
    assert.equal(rejected.j.error.code, 'RATE_LIMITED');
    assert.equal(rejected.headers.get('retry-after'), '60');
  });

  await t('RL-7: the internal worker channel is exempt from every tier (BUG-051)', async () => {
    // The relay polls three /internal/* endpoints every 2 s (~90 req/min, one IP, no JWT
    // — i.e. the ANON tier). The exclusions meant to keep it out of that tier tested
    // `req.path` from the app root, where the path is '/api/v1/internal/...' and never
    // matched: the worker 429'd, the outbox stopped draining and Timescale telemetry went
    // stale (observed live: 85 unacked events, a 429 loop in the worker log).
    // Reproduce the real conditions: the DEFAULT per-role limit (no test override), an
    // invalid internal token, and more requests than the ANON tier allows.
    delete process.env.RATE_LIMIT_USER;
    try {
      let rejected = 0;
      for (let i = 0; i < 120; i++) {
        const r = await api('/internal/outbox', { headers: { 'x-internal': 'wrong' } });
        if (r.status === 429) rejected++;
        // 403 = reached the route and was refused on the token (requireInternal), which
        // is the proof the request traversed the middleware stack without being throttled.
        else assert.equal(r.status, 403, `internal probe should be 403 without a valid token, got ${r.status}`);
      }
      assert.equal(rejected, 0, 'the internal channel must never be rate-limited');
      // The exemption is a channel rule, not a blanket hole: the public surface on the
      // same IP still gets capped. Prove the tier is live by exhausting it.
      let publicRejected = false;
      for (let i = 0; i < 80 && !publicRejected; i++) {
        const r = await api('/stations');
        if (r.status === 429) publicRejected = true;
      }
      assert.ok(publicRejected, 'the public tier must still fire on the same IP');
    } finally {
      process.env.RATE_LIMIT_USER = '100000';
    }
  });

  console.log(`\nRate-limit tests: ${pass} passed`);
  server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('\nRate-limit tests FAILED');
  console.error(e);
  process.exit(1);
});
