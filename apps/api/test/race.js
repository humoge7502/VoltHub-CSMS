// Race suite (masterplan §31, R1+R4): must stay green in CI.
// R1: 2 parallel reserves same connector+window -> exactly 1x201 + 1x409, 1 row.
// R4: 2 parallel pays same invoice -> exactly 1 SUCCESS.
'use strict';
process.env.RATE_LIMIT_OFF = '1';
const assert = require('assert');

async function main() {
  process.env.PORT = '4102';
  const { server } = require('../src/server');
  await new Promise((r) => server.listen(4102, r));
  const B = 'http://localhost:4102/api/v1';
  const api = async (p, o = {}) => {
    const { headers, ...rest } = o;
    const r = await fetch(B + p, { ...rest, headers: { 'content-type': 'application/json', ...(headers || {}) } });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  const { j: reg } = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: `race${Date.now()}@example.in`, password: 'Driver@123', full_name: 'Race Driver' }),
  });
  const H = { Authorization: `Bearer ${reg.accessToken}` };
  const { j: disc } = await api('/stations');
  const c = disc.stations[0].connectors.find((x) => x.status === 'AVAILABLE');
  const [cp, no] = c.connector_ref.split(':').map(Number);
  const s = new Date(Date.now() + 20 * 60000).toISOString(),
    e = new Date(Date.now() + 60 * 60000).toISOString();
  const body = JSON.stringify({ cpId: cp, connectorNo: no, startAt: s, endAt: e });

  const out = await Promise.allSettled([
    api('/reservations', { method: 'POST', headers: { ...H, 'Idempotency-Key': `r1-${Date.now()}` }, body }),
    api('/reservations', { method: 'POST', headers: { ...H, 'Idempotency-Key': `r2-${Date.now()}` }, body }),
  ]);
  const codes = out.map((x) => x.value.status);
  console.log('R1 race:', codes.join(','));
  assert.ok(codes.includes(201) && codes.includes(409), `R1 needs 201+409, got ${codes}`);
  const { j: mine } = await api('/reservations', { headers: H });
  const wins = mine.reservations.filter((r) => r.connector_ref === c.connector_ref && r.status === 'BOOKED');
  assert.equal(wins.length, 1, 'exactly one BOOKED row (Q25 invariant)');
  // BUG-021 fix: backend-aware message — local mutex today, Oracle row lock when STORE=oracle.
  console.log(
    `R1-OK: exactly one winner, overlap prevented in ${process.env.ORACLE_HOST ? 'Oracle row lock (FOR UPDATE)' : 'in-process mutex (dev; Oracle FOR UPDATE in prod)'}`
  );

  // R4 double-pay: build a billable session on another connector
  const c2 =
    disc.stations[0].connectors.find((x) => x.status === 'AVAILABLE' && x.connector_ref !== c.connector_ref) || c;
  const [cp2, no2] = c2.connector_ref.split(':').map(Number);
  await api(`/reservations/${wins[0].reservation_id}/cancel`, { method: 'POST', headers: H });
  const st = await api('/sessions/start', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ cpId: cp2, connectorNo: no2, planId: 2 }),
  });
  const sid = st.j.session.session_id;
  const { store } = require('../src/server');
  await store.recordTick(sid, 1, new Date().toISOString(), 10, 30, 400, 75);
  await store.stopSession(sid, 'RACE_TEST');
  const { j: bill } = await api(`/sessions/${sid}/bill`, { method: 'POST', headers: H });
  const pays = await Promise.allSettled([
    api(`/invoices/${bill.invoice.invoice_id}/pay`, { method: 'POST', headers: H }),
    api(`/invoices/${bill.invoice.invoice_id}/pay`, { method: 'POST', headers: H }),
  ]);
  const pc = pays.map((x) => x.value.status);
  console.log('R4 race:', pc.join(','));
  assert.ok(pc.includes(201) && pc.filter((x) => x === 409 || x === 402).length >= 1, `R4 needs 1 winner, got ${pc}`);
  console.log('R4-OK: invoice lock prevents double-pay');
  console.log('\nRace tests: 2 passed (R1 double-reserve, R4 double-pay)');
  server.close();
  process.exit(0);
}
main().catch((e) => {
  console.error('RACE FAIL', e.message);
  process.exit(1);
});
