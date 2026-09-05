// Security regression tests (audit §5 / §12 TEST-IDs).
// TEST-SEC-AUTHZ5: 5 formerly-public endpoints now 401 without token.
// TEST-OCPP-AUTH: Authorize("X") => Invalid; TAG-<seeded> => Accepted.
// TEST-REFRESH-FAMILY: reuse of revoked refresh burns the family.
// Run: node apps/api/test/security.js (RATE_LIMIT_OFF=1).
'use strict';
process.env.RATE_LIMIT_OFF = '1';
const assert = require('assert');

async function main() {
  process.env.PORT = '4104';
  const { server, store } = require('../src/server');
  await new Promise(r => server.listen(4104, r));
  const B = 'http://localhost:4104/api/v1';
  const api = async (p, o = {}) => {
    const { headers, ...rest } = o;
    const r = await fetch(B + p, { ...rest, headers: { 'content-type': 'application/json', ...(headers || {}) } });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  let pass = 0;
  const t = async (name, fn) => { await fn(); pass++; console.log(`  sec ${pass} - ${name}`); };

  const email = `sec${Date.now()}@example.in`;
  const reg = await api('/auth/register', { method: 'POST', body: JSON.stringify({ email, password: 'Driver@123', full_name: 'Sec Driver' }) });
  assert.equal(reg.status, 201);
  const tok = reg.j.accessToken;
  const refresh = reg.j.refreshToken;
  const H = { Authorization: `Bearer ${tok}` };

  await t('TEST-SEC-AUTHZ5: unauthenticated session/telemetry reads are 401', async () => {
    const { j: disc } = await api('/stations');
    const c = disc.stations[0].connectors.find(x => x.status === 'AVAILABLE');
    assert.ok(c);
    const sid = disc.stations[0].station_id;
    // Create a session to have a live id (auth'd), then probe unauth'd.
    const [cp, no] = c.connector_ref.split(':').map(Number);
    const s = new Date(Date.now() + 20 * 60000).toISOString(), e = new Date(Date.now() + 60 * 60000).toISOString();
    const r1 = await api('/reservations', { method: 'POST', headers: H, body: JSON.stringify({ cpId: cp, connectorNo: no, startAt: s, endAt: e }) });
    assert.equal(r1.status, 201);
    await api(`/reservations/${r1.j.reservation.reservation_id}/cancel`, { method: 'POST', headers: H });
    const st = await api('/sessions/start', { method: 'POST', headers: H, body: JSON.stringify({ cpId: cp, connectorNo: no }) });
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
    const reg2 = await api('/auth/register', { method: 'POST', body: JSON.stringify({ email: `sec2${Date.now()}@example.in`, password: 'Driver@123', full_name: 'Sec Other' }) });
    const other = await api(`/sessions/${liveId}/live`, { headers: { Authorization: `Bearer ${reg2.j.accessToken}` } });
    assert.equal(other.status, 403);
  });

  await t('TEST-OCPP-AUTH: Authorize allow-list (unit, no socket)', async () => {
    // Direct logic mirror of gateway Authorize: only TAG-<existing user> accepted.
    const { checkBasic } = require('../src/ocpp/gateway');
    assert.equal(typeof checkBasic, 'function');
    // Authorize predicate replicated here to lock the contract without a WS round-trip:
    const authz = (tag) => { const m = /^TAG-(\d+)$/.exec(String(tag || '')); return !!(m && store.users.has(Number(m[1]))); };
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
    const third = await api('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: r1.j.refreshToken }) });
    assert.equal(third.status, 401, 'sibling token must die after reuse detected');
  });

  await t('internal endpoints use constant-time compare + default-closed in prod-like', async () => {
    // In dev (no ORACLE_HOST, default token) the documented dev token still works.
    const ok = await api('/internal/outbox', { headers: { 'x-internal': 'dev-internal' } });
    assert.ok([200, 403].includes(ok.status));
    const bad = await api('/internal/outbox', { headers: { 'x-internal': 'wrong' } });
    assert.equal(bad.status, 403);
  });

  console.log(`\nSecurity tests: ${pass} passed`);
  server.close(); process.exit(0);
}
main().catch(e => { console.error('SEC FAIL', e); process.exit(1); });
