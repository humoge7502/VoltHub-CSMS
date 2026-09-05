// Full-journey E2E (demo insurance, masterplan §33.6): boots an ephemeral API,
// runs register → discover → reserve → plug-in → ticks → stop → bill → pay →
// review → operator fault triage → admin tariff version. Any throw = red.
'use strict';
process.env.RATE_LIMIT_OFF = '1';
const assert = require('assert');

async function main() {
  const { server, store } = require('../../apps/api/src/server');
  await new Promise((r) => server.listen(4103, r));
  const B = 'http://localhost:4103/api/v1';
  const api = async (p, o = {}) => {
    const { headers, ...rest } = o;
    const r = await fetch(B + p, { ...rest, headers: { 'content-type': 'application/json', ...(headers || {}) } });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, j };
  };
  let n = 0;
  const t = async (name, fn) => {
    await fn();
    n++;
    console.log(`  e2e ${n} - ${name}`);
  };
  let tok, opTok;
  await t('driver registers with credit', async () => {
    const r = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: `e2e${Date.now()}@example.in`, password: 'Driver@123', full_name: 'E2E Driver' }),
    });
    assert.equal(r.status, 201);
    tok = r.j.accessToken;
  });
  const H = () => ({ Authorization: `Bearer ${tok}` });
  let conn, stationId;
  await t('discovers a live CCS2 connector', async () => {
    const { j } = await api('/stations?std=CCS2&lat=12.97&lng=80.06&radius=60');
    const s = j.stations.find((x) => x.connectors.some((c) => c.status === 'AVAILABLE'));
    assert.ok(s);
    stationId = s.station_id;
    conn = s.connectors.find((c) => c.status === 'AVAILABLE');
  });
  let res;
  await t('reserves it', async () => {
    const [cp, no] = conn.connector_ref.split(':').map(Number);
    const r = await api('/reservations', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({
        cpId: cp,
        connectorNo: no,
        startAt: new Date(Date.now() + 20 * 60000).toISOString(),
        endAt: new Date(Date.now() + 60 * 60000).toISOString(),
      }),
    });
    assert.equal(r.status, 201);
    res = r.j.reservation;
  });
  let sid;
  await t('plugs in and streams ticks', async () => {
    const [cp, no] = conn.connector_ref.split(':').map(Number);
    const r = await api('/sessions/start', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ cpId: cp, connectorNo: no, reservationId: res.reservation_id, planId: 2 }),
    });
    assert.equal(r.status, 201);
    sid = r.j.session.session_id;
    for (let i = 1; i <= 6; i++) await store.recordTick(sid, i, new Date().toISOString(), i * 2, 30 + i, 400, 75);
    const live = await api(`/sessions/${sid}/live`, { headers: H() });
    assert.ok(live.j.live.energy_kwh >= 10);
  });
  await t('stops, bills, pays in full', async () => {
    await api(`/sessions/${sid}/remote-stop`, { method: 'POST', headers: H() });
    const b = await api(`/sessions/${sid}/bill`, { method: 'POST', headers: H() });
    assert.equal(b.status, 201);
    await api('/me/wallet/topup', { method: 'POST', headers: H(), body: JSON.stringify({ amount: 5000 }) });
    const p = await api(`/invoices/${b.j.invoice.invoice_id}/pay`, { method: 'POST', headers: H() });
    assert.equal(p.status, 201);
    const rev = await api(`/sessions/${sid}/review`, {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ rating: 5, comment: 'e2e verified electrons' }),
    });
    assert.equal(rev.status, 201);
  });
  await t('operator triages a fault', async () => {
    const op = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'arjun@volthub.in', password: 'Operator@123' }),
    });
    assert.ok(op.j.accessToken);
    opTok = op.j.accessToken;
    const OH = { Authorization: `Bearer ${opTok}` };
    const f = await api(`/stations/${stationId}/faults`, {
      method: 'POST',
      headers: OH,
      body: JSON.stringify({
        connector_ref: conn.connector_ref,
        error_code: 'E2E-Test',
        severity: 'INFO',
        description: 'e2e fault',
      }),
    });
    assert.equal(f.status, 201);
    const m = await api(`/faults/${f.j.fault.fault_id}/maintenance`, {
      method: 'POST',
      headers: OH,
      body: JSON.stringify({ work_type: 'INSPECT', description: 'e2e check' }),
    });
    assert.equal(m.status, 201);
    const done = await api(`/maintenance/${m.j.record.record_id}/complete`, {
      method: 'PATCH',
      headers: OH,
      body: JSON.stringify({ resolution: 'e2e ok' }),
    });
    assert.equal(done.status, 200);
    const live = await api(`/stations/${stationId}/connectors/live`);
    assert.equal(live.j.connectors.find((c) => c.connector_ref === conn.connector_ref).status, 'AVAILABLE');
  });
  await t('admin versions a tariff', async () => {
    const adm = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@volthub.in', password: 'Admin@123' }),
    });
    const v = await api('/admin/tariff-plans', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adm.j.accessToken}` },
      body: JSON.stringify({
        group_id: 1,
        name: 'E2E vX',
        session_fee: 20,
        bands: [{ day_scope: 'ALL', start_time: '00:00', end_time: '23:59', price_per_kwh: 23 }],
      }),
    });
    assert.equal(v.status, 201);
  });
  console.log(`\nE2E: ${n} steps passed (register→reserve→charge→pay→review→triage→tariff)`);
  server.close();
  process.exit(0);
}
main().catch((e) => {
  console.error('E2E FAIL', e);
  process.exit(1);
});
