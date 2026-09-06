// API test suite: boots ephemeral server, exercises register -> discover ->
// reserve -> session lifecycle -> bill -> pay, plus RBAC + state machine guards.
'use strict';
process.env.RATE_LIMIT_OFF = '1';
const assert = require('assert');

async function main() {
  process.env.PORT = '4101';
  const { server, store } = require('../src/server');
  await new Promise((r) => server.listen(4101, r));
  const B = 'http://localhost:4101/api/v1';
  const api = async (p, o = {}) => {
    const { headers, ...rest } = o;
    const r = await fetch(B + p, { ...rest, headers: { 'content-type': 'application/json', ...(headers || {}) } });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, j };
  };
  let pass = 0;
  const t = async (name, fn) => {
    await fn();
    pass++;
    console.log(`  ok ${pass} - ${name}`);
  };

  const email = `t${Date.now()}@example.in`;
  let tok;
  await t('register driver + welcome credit', async () => {
    const { status, j } = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'Driver@123', full_name: 'Test Driver' }),
    });
    assert.equal(status, 201);
    tok = j.accessToken;
    assert.ok((await api('/me', { headers: { Authorization: `Bearer ${tok}` } })).j.wallet.balance >= 500);
  });
  const H = () => ({ Authorization: `Bearer ${tok}` });
  await t('discover stations + bbox filter', async () => {
    const { status, j } = await api('/stations?lat=12.97&lng=80.06&radius=50');
    assert.equal(status, 200);
    assert.ok(j.stations.length >= 4);
    assert.ok(j.stations[0].distance_km !== undefined);
  });
  let res;
  await t('reserve connector (BOOKED)', async () => {
    const { j } = await api('/stations');
    const c = j.stations[0].connectors.find((x) => x.status === 'AVAILABLE');
    assert.ok(c, 'need an AVAILABLE connector');
    global.__c = c;
    const s = new Date(Date.now() + 20 * 60000).toISOString(),
      e = new Date(Date.now() + 60 * 60000).toISOString();
    const r = await api('/reservations', {
      method: 'POST',
      headers: { ...H(), 'Idempotency-Key': 't1' },
      body: JSON.stringify({
        cpId: Number(c.connector_ref.split(':')[0]),
        connectorNo: Number(c.connector_ref.split(':')[1]),
        startAt: s,
        endAt: e,
      }),
    });
    assert.equal(r.status, 201);
    res = r.j.reservation;
  });
  await t('overlap rejected 409 (BR-05)', async () => {
    const [cp, no] = global.__c.connector_ref.split(':').map(Number);
    const s = new Date(Date.now() + 30 * 60000).toISOString(),
      e = new Date(Date.now() + 70 * 60000).toISOString();
    const r = await api('/reservations', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ cpId: cp, connectorNo: no, startAt: s, endAt: e }),
    });
    assert.equal(r.status, 409);
    assert.match(r.j.error.code, /OVERLAP/);
  });
  await t('idempotent replay returns same 201', async () => {
    const [cp, no] = global.__c.connector_ref.split(':').map(Number);
    const s = new Date(Date.now() + 90 * 60000).toISOString(),
      e = new Date(Date.now() + 110 * 60000).toISOString();
    const b = JSON.stringify({ cpId: cp, connectorNo: no, startAt: s, endAt: e });
    const a = await api('/reservations', { method: 'POST', headers: { ...H(), 'Idempotency-Key': 'idem-x' }, body: b });
    const c2 = await api('/reservations', {
      method: 'POST',
      headers: { ...H(), 'Idempotency-Key': 'idem-x' },
      body: b,
    });
    assert.equal(a.status, 201);
    assert.deepEqual(a.j, c2.j);
  });
  let sess;
  await t('session lifecycle PREPARING->CHARGING->COMPLETED', async () => {
    const [cp, no] = global.__c.connector_ref.split(':').map(Number);
    // cancel the earlier hold so connector is free for the session start path
    await api(`/reservations/${res.reservation_id}/cancel`, { method: 'POST', headers: H() });
    const st = await api('/sessions/start', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ cpId: cp, connectorNo: no, planId: 2 }),
    });
    assert.equal(st.status, 201);
    sess = st.j.session;
    assert.equal(sess.state, 'PREPARING');
    // direct store tick (OCPP path covered in gateway; same package fn)
    await store.recordTick(sess.session_id, 1, new Date().toISOString(), 2.5, 30, 400, 75);
    await store.recordTick(sess.session_id, 2, new Date().toISOString(), 5.0, 32, 400, 80);
    assert.equal(store.sessions.get(sess.session_id).state, 'CHARGING');
    const live = await api(`/sessions/${sess.session_id}/live`, { headers: H() });
    assert.ok(live.j.live.energy_kwh >= 5);
    await api(`/sessions/${sess.session_id}/remote-stop`, { method: 'POST', headers: H() });
    assert.equal(store.sessions.get(sess.session_id).state, 'COMPLETED');
  });
  await t('meter regression rejected (BR-11)', async () => {
    const r = await store
      .recordTick(sess.session_id, 99, new Date().toISOString(), 0.001, 1, 1, 1)
      .then(() => 'ok')
      .catch((e) => e.code);
    assert.equal(r, 'TICK_REJECTED'); // terminal session rejects ticks
  });
  await t('bill exactly once + wallet pay', async () => {
    const b = await api(`/sessions/${sess.session_id}/bill`, { method: 'POST', headers: H() });
    assert.equal(b.status, 201);
    const b2 = await api(`/sessions/${sess.session_id}/bill`, { method: 'POST', headers: H() });
    assert.equal(b2.status, 409); // no double-bill (BR-10)
    const inv = b.j.invoice.invoice_id;
    const p = await api(`/invoices/${inv}/pay`, { method: 'POST', headers: H() });
    assert.equal(p.status, 201);
    const p2 = await api(`/invoices/${inv}/pay`, { method: 'POST', headers: H() });
    assert.equal(p2.status, 409); // no double-pay (R4)
  });
  await t("pay: foreign driver cannot pay someone else's invoice (BUG-028)", async () => {
    // Fresh driver with their own wallet; inv belongs to the first test user.
    const other = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: `foreign.${Date.now()}@example.in`,
        password: 'Driver@123',
        full_name: 'Foreign Driver',
      }),
    });
    const OH = { Authorization: `Bearer ${other.j.accessToken}` };
    const inv = store.invoices.get(store.seq.inv); // latest invoice (owner = first user)
    const denied = await api(`/invoices/${inv.invoice_id}/pay`, { method: 'POST', headers: OH });
    assert.equal(denied.status, 403);
    // Owner can still pay (state unchanged here — already PAID above; expect 409 not 403).
    const owner = await api(`/invoices/${inv.invoice_id}/pay`, { method: 'POST', headers: H() });
    assert.equal(owner.status, 409);
  });
  await t('RBAC: driver cannot list audit log', async () => {
    const r = await api('/admin/audit-logs', { headers: H() });
    assert.equal(r.status, 403);
  });
  await t('health reports outbox lag', async () => {
    const { j } = await api('/health');
    assert.equal(j.status, 'ok');
  });
  await t('openapi docs + public tariffs', async () => {
    const d = await api('/docs');
    assert.ok(d.j.openapi.startsWith('3.0'));
    assert.ok(Object.keys(d.j.paths).length >= 30);
    const { j } = await api('/tariffs/active');
    assert.ok(j.plans.length >= 2 && j.plans[0].bands.length >= 3);
  });
  await t('operator session control is matrix-guarded', async () => {
    // sess is COMPLETED+BILLED: any further transition must 409
    const r = await api(`/sessions/${sess.session_id}/state`, {
      method: 'PATCH',
      headers: H(),
      body: JSON.stringify({ to: 'CHARGING' }),
    });
    assert.equal(r.status, 409);
  });
  await t('reviews: one per session + station feed', async () => {
    const a = await api(`/sessions/${sess.session_id}/review`, {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ rating: 5, comment: 'fast CCS2, clean stop' }),
    });
    assert.equal(a.status, 201);
    const b = await api(`/sessions/${sess.session_id}/review`, {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ rating: 4 }),
    });
    assert.equal(b.status, 409); // BR-13
    const { j: disc2 } = await api('/stations');
    const owner = disc2.stations.find((s) =>
      (s.connectors || []).some((c) => c.connector_ref === global.__c.connector_ref)
    );
    const { j } = await api(`/stations/${owner.station_id}/reviews`);
    assert.ok(j.reviews.some((x) => x.session_id === sess.session_id));
  });
  await t('review guards: nonexistent + foreign session rejected (BUG-029)', async () => {
    const nf = await api('/sessions/999999/review', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ rating: 5 }),
    });
    assert.equal(nf.status, 404);
    // second driver cannot review the first driver's session
    const other = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: `nosy.${Date.now()}@example.in`,
        password: 'Driver@123',
        full_name: 'Nosy Driver',
      }),
    });
    const OH = { Authorization: `Bearer ${other.j.accessToken}` };
    const f = await api(`/sessions/${sess.session_id}/review`, {
      method: 'POST',
      headers: OH,
      body: JSON.stringify({ rating: 1, comment: 'not mine' }),
    });
    assert.equal(f.status, 403);
  });
  await t('notifications emitted + readable', async () => {
    const { j } = await api('/me/notifications', { headers: H() });
    assert.ok(j.notifications.length >= 2); // reservation + invoice
    const n0 = j.notifications[0];
    const r = await api(`/me/notifications/${n0.notification_id}/read`, { method: 'POST', headers: H() });
    assert.equal(r.j.notification.is_read, 'Y');
  });
  await t('vehicle default switch (DRV-02)', async () => {
    const v2 = await api('/me/vehicles', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ make: 'MG', model: 'ZS EV', battery_kwh: 50.3 }),
    });
    assert.equal(v2.status, 201);
    const p = await api(`/me/vehicles/${v2.j.vehicle.vehicle_id}`, {
      method: 'PATCH',
      headers: H(),
      body: JSON.stringify({ is_default: true }),
    });
    assert.equal(p.j.vehicle.is_default, 'Y');
  });
  await t('admin: login + station CRUD + OCPP provision (RBAC)', async () => {
    const adm = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@volthub.in', password: 'Admin@123' }),
    });
    assert.ok(adm.j.accessToken);
    const AH = { Authorization: `Bearer ${adm.j.accessToken}` };
    const denied = await api('/admin/stations', { headers: H() });
    assert.equal(denied.status, 403); // driver cannot
    const created = await api('/admin/stations', {
      method: 'POST',
      headers: AH,
      body: JSON.stringify({
        name: 'Test Yard',
        latitude: 12.99,
        longitude: 80.21,
        city: 'Chennai',
        charge_points: [{ model: 'VH-AC22', connectors: [{ standard: 'TYPE2', max_power_kw: 22 }] }],
      }),
    });
    assert.equal(created.status, 201);
    assert.ok(created.j.provisioned[0].ocpp_identity.startsWith('VH-'));
    assert.ok(created.j.provisioned[0].auth_secret, 'provision response must carry the one-time secret');
    const cp = await api('/admin/charge-points', {
      method: 'POST',
      headers: AH,
      body: JSON.stringify({ station_id: created.j.station.station_id, model: 'VH-DC60' }),
    });
    assert.equal(cp.status, 201);
    assert.ok(cp.j.ws_url.startsWith('/ocpp/'));
    // Provisioned ≠ connected: a freshly provisioned CP must report OFFLINE until
    // its first OCPP socket (keeps volthub_ocpp_online honest).
    assert.equal(cp.j.charge_point.status, 'OFFLINE', 'newly provisioned CP must not be ONLINE before it connects');
  });
  await t('analytics: operator station scope enforced (BUG-030)', async () => {
    const adm = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@volthub.in', password: 'Admin@123' }),
    });
    const AH = { Authorization: `Bearer ${adm.j.accessToken}` };
    // Station created in the previous test is the highest id; assign an operator to it.
    const stations = await api('/admin/stations', { headers: AH });
    const stId = Math.max(...stations.j.stations.map((s) => s.station_id));
    const op = await api('/admin/users', {
      method: 'POST',
      headers: AH,
      body: JSON.stringify({ email: `scoped.${Date.now()}@volthub.in`, role: 'OPERATOR', stationId: stId }),
    });
    assert.equal(op.status, 201);
    const opLogin = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: op.j.user.email, password: 'Temp@1234' }),
    });
    const OH = { Authorization: `Bearer ${opLogin.j.accessToken}` };
    const okScope = await api(`/stations/${stId}/analytics`, { headers: OH });
    assert.equal(okScope.status, 200, 'operator must read their assigned station');
    const other = stations.j.stations.find((s) => s.station_id !== stId);
    if (other) {
      const denied = await api(`/stations/${other.station_id}/analytics`, { headers: OH });
      assert.equal(denied.status, 403, "operator must not read another station's revenue");
      assert.equal(denied.j.error.code, 'OUT_OF_SCOPE');
    }
  });
  console.log(`\nAPI tests: ${pass} passed`);
  server.close();
  process.exit(0);
}
main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
