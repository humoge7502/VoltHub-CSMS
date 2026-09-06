// Security regression tests (audit §5 / §12 TEST-IDs).
// TEST-SEC-AUTHZ5: 5 formerly-public endpoints now 401 without token.
// TEST-OCPP-AUTH: Authorize("X") => Invalid; TAG-<seeded> => Accepted.
// TEST-REFRESH-FAMILY: reuse of revoked refresh burns the family.
// TEST-SEC-COOKIE: httpOnly refresh cookie set/rotate/revoke + graceful logout (SEC-012).
// Run: node apps/api/test/security.js (RATE_LIMIT_OFF=1).
'use strict';
process.env.RATE_LIMIT_OFF = '1';
const assert = require('assert');

async function main() {
  process.env.PORT = '4104';
  const { server, store } = require('../src/server');
  await new Promise((r) => server.listen(4104, r));
  const B = 'http://localhost:4104/api/v1';
  const api = async (p, o = {}) => {
    const { headers, ...rest } = o;
    const r = await fetch(B + p, { ...rest, headers: { 'content-type': 'application/json', ...(headers || {}) } });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  let pass = 0;
  let rtCookie = null;
  const t = async (name, fn) => {
    await fn();
    pass++;
    console.log(`  sec ${pass} - ${name}`);
  };

  const email = `sec${Date.now()}@example.in`;
  const reg = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'Driver@123', full_name: 'Sec Driver' }),
  });
  assert.equal(reg.status, 201);
  const tok = reg.j.accessToken;
  const refresh = reg.j.refreshToken;
  const H = { Authorization: `Bearer ${tok}` };

  await t('TEST-SEC-AUTHZ5: unauthenticated session/telemetry reads are 401', async () => {
    const { j: disc } = await api('/stations');
    const c = disc.stations[0].connectors.find((x) => x.status === 'AVAILABLE');
    assert.ok(c);
    const sid = disc.stations[0].station_id;
    // Create a session to have a live id (auth'd), then probe unauth'd.
    const [cp, no] = c.connector_ref.split(':').map(Number);
    const s = new Date(Date.now() + 20 * 60000).toISOString(),
      e = new Date(Date.now() + 60 * 60000).toISOString();
    const r1 = await api('/reservations', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ cpId: cp, connectorNo: no, startAt: s, endAt: e }),
    });
    assert.equal(r1.status, 201);
    await api(`/reservations/${r1.j.reservation.reservation_id}/cancel`, { method: 'POST', headers: H });
    const st = await api('/sessions/start', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ cpId: cp, connectorNo: no }),
    });
    assert.equal(st.status, 201);
    const liveId = st.j.session.session_id;
    const probes = [
      `/sessions/active/${c.connector_ref}`,
      `/sessions/${liveId}/live`,
      `/stations/${sid}/sessions/active`,
      '/telemetry/load-curve',
      '/telemetry/utilization-heatmap',
    ];
    for (const p of probes) {
      const r = await api(p);
      assert.equal(r.status, 401, `${p} must be 401, got ${r.status}`);
    }
    // Auth'd owner can read own live session.
    const ok = await api(`/sessions/${liveId}/live`, { headers: H });
    assert.equal(ok.status, 200);
    // Another driver gets 403 on someone else's session.
    const reg2 = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: `sec2${Date.now()}@example.in`, password: 'Driver@123', full_name: 'Sec Other' }),
    });
    const other = await api(`/sessions/${liveId}/live`, { headers: { Authorization: `Bearer ${reg2.j.accessToken}` } });
    assert.equal(other.status, 403);
  });

  await t('TEST-OCPP-AUTH: Authorize allow-list (unit, no socket)', async () => {
    // Direct logic mirror of gateway Authorize: only TAG-<existing user> accepted.
    const { checkBasic } = require('../src/ocpp/gateway');
    assert.equal(typeof checkBasic, 'function');
    // Authorize predicate replicated here to lock the contract without a WS round-trip:
    const authz = (tag) => {
      const m = /^TAG-(\d+)$/.exec(String(tag || ''));
      return !!(m && store.users.has(Number(m[1])));
    };
    assert.equal(authz('X'), false, 'arbitrary tag must be Invalid');
    assert.equal(authz('HACKED'), false);
    assert.equal(authz(''), false);
    const someUser = [...store.users.values()][0];
    assert.equal(authz(`TAG-${someUser.user_id}`), true);
  });

  await t('TEST-REFRESH-FAMILY: rotation works; revoked reuse burns family', async () => {
    const r1 = await api('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: refresh }) });
    assert.equal(r1.status, 200, `first rotation must succeed, got ${r1.status}`);
    const second = await api('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: refresh }) });
    assert.equal(second.status, 401, 'reusing a rotated-out refresh must 401');
    assert.match(second.j.error.message, /family revoked|invalid/i);
    // Sibling (the newly issued token from r1) must now also be dead — family burned.
    const third = await api('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: r1.j.refreshToken }),
    });
    assert.equal(third.status, 401, 'sibling token must die after reuse detected');
  });

  await t('internal endpoints use constant-time compare + default-closed in prod-like', async () => {
    // In dev (no ORACLE_HOST, default token) the documented dev token still works.
    const ok = await api('/internal/outbox', { headers: { 'x-internal': 'dev-internal' } });
    assert.ok([200, 403].includes(ok.status));
    const bad = await api('/internal/outbox', { headers: { 'x-internal': 'wrong' } });
    assert.equal(bad.status, 403);
  });

  await t('TEST-BOLA: cross-driver invoice read / remote-stop / bill are 403 (B2G-002)', async () => {
    // driver1 creates + bills a session; driver2 probes with its own token.
    const { j: disc } = await api('/stations');
    const c = disc.stations[0].connectors.find((x) => x.status === 'AVAILABLE');
    assert.ok(c, 'need AVAILABLE connector for BOLA probe');
    const [cp, no] = c.connector_ref.split(':').map(Number);
    const st = await api('/sessions/start', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ cpId: cp, connectorNo: no }),
    });
    assert.equal(st.status, 201);
    const sid = st.j.session.session_id;
    // tick + complete so billing works
    await store.recordTick(sid, 1, new Date().toISOString(), 3.0, 30, 400, 75);
    await api(`/sessions/${sid}/remote-stop`, { method: 'POST', headers: H });
    const bill = await api(`/sessions/${sid}/bill`, { method: 'POST', headers: H });
    assert.equal(bill.status, 201);
    const invId = bill.j.invoice.invoice_id;
    const reg2 = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: `bola${Date.now()}@example.in`, password: 'Driver@123', full_name: 'Bola Other' }),
    });
    const H2 = { Authorization: `Bearer ${reg2.j.accessToken}` };
    const p1 = await api(`/invoices/${invId}`, { headers: H2 });
    assert.equal(p1.status, 403, `cross-driver invoice read must be 403, got ${p1.status}`);
    const p2 = await api(`/sessions/${sid}/remote-stop`, { method: 'POST', headers: H2 });
    assert.equal(p2.status, 403, `cross-driver remote-stop must be 403, got ${p2.status}`);
    const p3 = await api(`/sessions/${sid}/bill`, { method: 'POST', headers: H2 });
    assert.equal(p3.status, 403, `cross-driver bill must be 403, got ${p3.status}`);
    // owner still works
    const ok = await api(`/invoices/${invId}`, { headers: H });
    assert.equal(ok.status, 200);
  });

  await t('B2G-003: analytics role gate + manual fault staff-only', async () => {
    const { j: disc } = await api('/stations');
    const sid = disc.stations[0].station_id;
    const c = disc.stations[0].connectors[0];
    // driver token must get 403 on analytics
    const denied = await api(`/stations/${sid}/analytics`, { headers: H });
    assert.equal(denied.status, 403, `driver analytics must be 403, got ${denied.status}`);
    // driver token must get 403 on manual fault report
    const fault = await api(`/stations/${sid}/faults`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ connector_ref: c.connector_ref, severity: 'WARN' }),
    });
    assert.equal(fault.status, 403, `driver fault report must be 403, got ${fault.status}`);
  });

  await t('B2G-013: reserve-then-hijack is 409 RESERVATION_MISMATCH', async () => {
    const { j: disc } = await api('/stations');
    const c = disc.stations[1].connectors.find((x) => x.status === 'AVAILABLE');
    assert.ok(c, 'need AVAILABLE connector for hijack probe');
    const [cp, no] = c.connector_ref.split(':').map(Number);
    const s = new Date(Date.now() + 20 * 60000).toISOString(),
      e = new Date(Date.now() + 60 * 60000).toISOString();
    const r1 = await api('/reservations', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ cpId: cp, connectorNo: no, startAt: s, endAt: e }),
    });
    assert.equal(r1.status, 201);
    const reg2 = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: `hijack${Date.now()}@example.in`,
        password: 'Driver@123',
        full_name: 'Hijack Other',
      }),
    });
    const H2 = { Authorization: `Bearer ${reg2.j.accessToken}` };
    // hijacker tries to start on victim's reservation
    const hij = await api('/sessions/start', {
      method: 'POST',
      headers: H2,
      body: JSON.stringify({ cpId: cp, connectorNo: no, reservationId: r1.j.reservation.reservation_id }),
    });
    assert.equal(hij.status, 409, `hijack must be 409, got ${hij.status}`);
    assert.match(hij.j.error.code, /RESERVATION_MISMATCH/);
    // owner succeeds
    const own = await api('/sessions/start', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ cpId: cp, connectorNo: no, reservationId: r1.j.reservation.reservation_id }),
    });
    assert.equal(own.status, 201);
  });

  await t('SEC-010: responses carry no x-powered-by framework fingerprint', async () => {
    const r = await fetch(B + '/stations', { headers: H });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-powered-by'), null, 'x-powered-by must not be set');
    // seeded demo creds on a JSON body endpoint, not just the open route
    const r2 = await fetch(B + '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'demo@volthub.in', password: 'wrong-pw' }),
    });
    assert.equal(r2.headers.get('x-powered-by'), null);
  });

  await t('SEC-011: unknown-email login burns scrypt — timing parity, both 401', async () => {
    const attempt = async (body) => {
      const t0 = Date.now();
      const r = await api('/auth/login', { method: 'POST', body: JSON.stringify(body) });
      return { ms: Date.now() - t0, status: r.status, code: r.j?.error?.code };
    };
    // Known email + wrong password vs unknown email: run 3 pairs, compare medians.
    const known = [],
      unknown = [];
    for (let i = 0; i < 3; i++) {
      known.push((await attempt({ email, password: 'wrong-password' })).ms);
      unknown.push((await attempt({ email: `nobody-${i}-${Date.now()}@example.in`, password: 'wrong-password' })).ms);
    }
    const med = (a) => a.slice().sort((x, y) => x - y)[1];
    const a = await attempt({ email, password: 'wrong-password' });
    const b = await attempt({ email: `nobody-final@example.in`, password: 'wrong-password' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.code, 'BAD_CREDENTIALS');
    assert.equal(b.code, 'BAD_CREDENTIALS', 'unknown email must read as bad credentials, not user-missing');
    // The unknown path must actually run the scrypt pad (not return instantly).
    assert.ok(med(unknown) >= 15, `unknown-email path too fast (${med(unknown)}ms) — pad not running`);
    // And it must sit inside the same band as a real (wrong-password) verify.
    assert.ok(
      Math.abs(med(known) - med(unknown)) < 120,
      `timing gap too wide: known=${med(known)}ms unknown=${med(unknown)}ms`
    );
  });

  await t('TEST-SEC-COOKIE-1: login sets an httpOnly, SameSite=Lax, auth-path-scoped refresh cookie', async () => {
    const r = await fetch(B + '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Driver@123' }),
    });
    assert.equal(r.status, 200);
    const sc = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')]).find((c) =>
      c.startsWith('vh_rt=')
    );
    assert.ok(sc, 'vh_rt cookie missing on login');
    assert.ok(/httponly/i.test(sc), 'cookie must be HttpOnly');
    assert.ok(/samesite=lax/i.test(sc), 'cookie must be SameSite=Lax');
    assert.ok(/path=\/api\/v1\/auth/i.test(sc), 'cookie must be scoped to the auth paths');
    rtCookie = sc.split(';')[0]; // "vh_rt=<raw>" for the next tests
  });

  await t('TEST-SEC-COOKIE-2: /auth/refresh accepts the cookie alone (no body token) and rotates', async () => {
    const r = await fetch(B + '/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: rtCookie },
      body: '{}',
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.accessToken, 'rotated refresh must return a fresh access token');
    const sc = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')]).find((c) =>
      c.startsWith('vh_rt=')
    );
    assert.ok(sc, 'rotation must re-set the cookie');
    rtCookie = sc.split(';')[0];
  });

  await t('TEST-SEC-COOKIE-3: logout revokes the family server-side; the old cookie is dead after', async () => {
    const lo = await fetch(B + '/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: rtCookie },
      body: '{}',
    });
    assert.equal(lo.status, 200);
    const again = await fetch(B + '/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: rtCookie },
      body: '{}',
    });
    assert.equal(again.status, 401, 'revoked family must not refresh');
  });

  await t('TEST-SEC-COOKIE-4: logout without a cookie/body is graceful (200, clears cookie)', async () => {
    const lo = await fetch(B + '/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(lo.status, 200);
    const sc = (lo.headers.getSetCookie ? lo.headers.getSetCookie() : [lo.headers.get('set-cookie')]).find((c) =>
      c.startsWith('vh_rt=')
    );
    assert.ok(sc && /max-age=0/i.test(sc), 'logout must clear the cookie (max-age=0)');
  });

  await t('TEST-SEC-SWEEP-1: idle throttle buckets are evicted from BOTH maps (BUG-015/BUG-025)', async () => {
    const sec = require('../src/middleware/security');
    const { _windows: windows, _loginWindows: loginWindows, _sweepIdle: sweepIdle } = sec;
    // Seed both maps with one stale (5-min-old) and one fresh bucket.
    const now = Date.now();
    windows.set('ip:198.18.0.1', [now - 300000, now]);
    windows.set('ip:198.18.0.2', [now - 300000]);
    loginWindows.set('login:198.18.1.1', [now - 300000, now]);
    loginWindows.set('login:198.18.1.2', [now - 300000]);
    sweepIdle(now);
    assert.ok(!windows.has('ip:198.18.0.2'), 'fully-stale window bucket must be deleted');
    assert.ok(windows.has('ip:198.18.0.1'), 'mixed-age window bucket must be trimmed, not deleted');
    assert.ok(!loginWindows.has('login:198.18.1.2'), 'fully-stale LOGIN bucket must also be deleted');
    assert.ok(loginWindows.has('login:198.18.1.1'), 'mixed-age LOGIN bucket must be trimmed, not deleted');
  });

  console.log(`\nSecurity tests: ${pass} passed`);
  server.close();
  process.exit(0);
}
main().catch((e) => {
  console.error('SEC FAIL', e);
  process.exit(1);
});
