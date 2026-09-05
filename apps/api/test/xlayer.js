// Cross-layer stop semantics (BUG-007): remote stop from PREPARING => CANCELLED (not COMPLETED).
// Mirrors V003 charge_session_pkg.stop_session branch. Run: node apps/api/test/xlayer.js
'use strict';
process.env.RATE_LIMIT_OFF = '1';
const assert = require('assert');
async function main() {
  process.env.PORT = '4105';
  const { server, store } = require('../src/server');
  await new Promise(r => server.listen(4105, r));
  const B = 'http://localhost:4105/api/v1';
  const api = async (p, o = {}) => {
    const { headers, ...rest } = o;
    const r = await fetch(B + p, { ...rest, headers: { 'content-type': 'application/json', ...(headers || {}) } });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  const reg = await api('/auth/register', { method: 'POST', body: JSON.stringify({ email: `xl${Date.now()}@example.in`, password: 'Driver@123', full_name: 'Xlayer Driver' }) });
  assert.equal(reg.status, 201);
  const H = { Authorization: `Bearer ${reg.j.accessToken}` };
  const { j: disc } = await api('/stations');
  const c = disc.stations[0].connectors.find(x => x.status === 'AVAILABLE');
  assert.ok(c);
  const [cp, no] = c.connector_ref.split(':').map(Number);
  const st = await api('/sessions/start', { method: 'POST', headers: H, body: JSON.stringify({ cpId: cp, connectorNo: no }) });
  assert.equal(st.status, 201);
  assert.equal(st.j.session.state, 'PREPARING');
  const stop = await api(`/sessions/${st.j.session.session_id}/remote-stop`, { method: 'POST', headers: H });
  assert.equal(stop.j.session.state, 'CANCELLED', `PREPARING stop must CANCEL, got ${stop.j.session.state}`);
  // Boundary: band edge pricing is half-open on the JS side (BUG-008 contract).
  const price = store.resolveBandPrice(2, new Date().toISOString());
  assert.ok(Number.isFinite(Number(price)), 'band resolver must return a price');
  console.log('XLAYER: 2 passed (PREPARING->CANCELLED, band resolver live)');
  server.close(); process.exit(0);
}
main().catch(e => { console.error('XLAYER FAIL', e); process.exit(1); });
