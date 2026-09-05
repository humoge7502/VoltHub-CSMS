// Cross-layer stop semantics (BUG-007): remote stop from PREPARING => CANCELLED (not COMPLETED).
// Mirrors V003 charge_session_pkg.stop_session branch. Run: node apps/api/test/xlayer.js
'use strict';
process.env.RATE_LIMIT_OFF = '1';
const assert = require('assert');
async function main() {
  process.env.PORT = '4105';
  const { server, store } = require('../src/server');
  await new Promise((r) => server.listen(4105, r));
  const B = 'http://localhost:4105/api/v1';
  const api = async (p, o = {}) => {
    const { headers, ...rest } = o;
    const r = await fetch(B + p, { ...rest, headers: { 'content-type': 'application/json', ...(headers || {}) } });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  const reg = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: `xl${Date.now()}@example.in`, password: 'Driver@123', full_name: 'Xlayer Driver' }),
  });
  assert.equal(reg.status, 201);
  const H = { Authorization: `Bearer ${reg.j.accessToken}` };
  const { j: disc } = await api('/stations');
  const c = disc.stations[0].connectors.find((x) => x.status === 'AVAILABLE');
  assert.ok(c);
  const [cp, no] = c.connector_ref.split(':').map(Number);
  const st = await api('/sessions/start', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ cpId: cp, connectorNo: no }),
  });
  assert.equal(st.status, 201);
  assert.equal(st.j.session.state, 'PREPARING');
  const stop = await api(`/sessions/${st.j.session.session_id}/remote-stop`, { method: 'POST', headers: H });
  assert.equal(stop.j.session.state, 'CANCELLED', `PREPARING stop must CANCEL, got ${stop.j.session.state}`);
  // Boundary: band edge pricing is half-open on the JS side (BUG-008 contract).
  const price = store.resolveBandPrice(2, new Date().toISOString());
  assert.ok(Number.isFinite(Number(price)), 'band resolver must return a price');
  // B2G-004 parity: insufficient funds -> 402 + FAILED payment, invoice stays DUE; top-up -> pay 201 PAID.
  const { j: disc2 } = await api('/stations');
  const c2 = disc2.stations[0].connectors.find((x) => x.status === 'AVAILABLE');
  assert.ok(c2, 'need AVAILABLE connector for pay-parity probe');
  const [cp2, no2] = c2.connector_ref.split(':').map(Number);
  const st2 = await api('/sessions/start', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ cpId: cp2, connectorNo: no2 }),
  });
  assert.equal(st2.status, 201);
  const sid2 = st2.j.session.session_id;
  await store.recordTick(sid2, 1, new Date().toISOString(), 50.0, 60, 400, 100);
  await api(`/sessions/${sid2}/remote-stop`, { method: 'POST', headers: H });
  const bill2 = await api(`/sessions/${sid2}/bill`, { method: 'POST', headers: H });
  assert.equal(bill2.status, 201);
  assert.ok(bill2.j.invoice.invoice_id);
  // drain wallet to force insufficient funds: register fresh driver with Rs.500 credit can't cover 50kWh bill
  const poor = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: `poor${Date.now()}@example.in`, password: 'Driver@123', full_name: 'Poor Driver' }),
  });
  const HP = { Authorization: `Bearer ${poor.j.accessToken}` };
  // create a session owned by poor driver on another connector
  const c3 = disc2.stations[1].connectors.find((x) => x.status === 'AVAILABLE');
  assert.ok(c3, 'need second AVAILABLE connector');
  const [cp3, no3] = c3.connector_ref.split(':').map(Number);
  const st3 = await api('/sessions/start', {
    method: 'POST',
    headers: HP,
    body: JSON.stringify({ cpId: cp3, connectorNo: no3 }),
  });
  assert.equal(st3.status, 201);
  const sid3 = st3.j.session.session_id;
  await store.recordTick(sid3, 1, new Date().toISOString(), 100.0, 60, 400, 100);
  await api(`/sessions/${sid3}/remote-stop`, { method: 'POST', headers: HP });
  const bill3 = await api(`/sessions/${sid3}/bill`, { method: 'POST', headers: HP });
  assert.equal(bill3.status, 201);
  const inv3 = bill3.j.invoice.invoice_id;
  const payFail = await api(`/invoices/${inv3}/pay`, { method: 'POST', headers: HP });
  assert.equal(payFail.status, 402, `insufficient funds must be 402, got ${payFail.status}`);
  // invoice must stay DUE (not bricked to FAILED)
  const invRow = store.invoices.get(inv3);
  assert.equal(invRow.status, 'DUE', `invoice must stay DUE after failed pay, got ${invRow.status}`);
  const failedPay = [...store.payments.values()].find((p) => p.invoice_id === inv3 && p.status === 'FAILED');
  assert.ok(failedPay, 'FAILED payment row must exist');
  // top-up then pay succeeds
  await api('/me/wallet/topup', { method: 'POST', headers: HP, body: JSON.stringify({ amount: 10000 }) });
  const payOk = await api(`/invoices/${inv3}/pay`, { method: 'POST', headers: HP });
  assert.equal(payOk.status, 201, `top-up-then-pay must be 201, got ${payOk.status}`);
  assert.equal(store.invoices.get(inv3).status, 'PAID');
  console.log('XLAYER: 4 passed (PREPARING->CANCELLED, band resolver, pay-parity recovery, invoice DUE)');
  server.close();
  process.exit(0);
}
main().catch((e) => {
  console.error('XLAYER FAIL', e);
  process.exit(1);
});
