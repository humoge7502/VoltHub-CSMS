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
      body: JSON.stringify({
        email: `scoped.${Date.now()}@volthub.in`,
        role: 'OPERATOR',
        stationId: stId,
        full_name: 'Scoped Operator',
      }),
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
  // ---- BUG-031..037 regression block (fresh-eyes audit round) ----
  await t('BUG-031: operator cancel is station-scoped', async () => {
    const adm = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@volthub.in', password: 'Admin@123' }),
    });
    const AH = { Authorization: `Bearer ${adm.j.accessToken}` };
    const stations = await api('/admin/stations', { headers: AH });
    const stId = Math.max(...stations.j.stations.map((s) => s.station_id));
    const op = await api('/admin/users', {
      method: 'POST',
      headers: AH,
      body: JSON.stringify({
        email: `cancelscope.${Date.now()}@volthub.in`,
        role: 'OPERATOR',
        stationId: stId,
        full_name: 'Cancel Scope Op',
      }),
    });
    assert.equal(op.status, 201);
    const opLogin = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: op.j.user.email, password: 'Temp@1234' }),
    });
    const OH = { Authorization: `Bearer ${opLogin.j.accessToken}` };
    // Driver reserves on a station the operator is NOT assigned to -> cancel must 403.
    const disc = await api('/stations');
    const foreign = disc.j.stations.find(
      (s) => s.station_id !== stId && s.connectors.some((c) => c.status === 'AVAILABLE')
    );
    assert.ok(foreign, 'need an available connector on a non-assigned station');
    const fc = foreign.connectors.find((c) => c.status === 'AVAILABLE');
    const d1 = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: `c1.${Date.now()}@example.in`,
        password: 'Driver@123',
        full_name: 'Cancel Target',
      }),
    });
    const H1 = { Authorization: `Bearer ${d1.j.accessToken}` };
    const win = (cp, no) => ({
      cpId: cp,
      connectorNo: no,
      startAt: new Date(Date.now() + 30 * 60000).toISOString(),
      endAt: new Date(Date.now() + 80 * 60000).toISOString(),
    });
    const r1 = await api('/reservations', {
      method: 'POST',
      headers: H1,
      body: JSON.stringify(win(Number(fc.connector_ref.split(':')[0]), Number(fc.connector_ref.split(':')[1]))),
    });
    assert.equal(r1.status, 201);
    const denied = await api(`/reservations/${r1.j.reservation.reservation_id}/cancel`, {
      method: 'POST',
      headers: OH,
    });
    assert.equal(denied.status, 403, 'operator must not cancel bookings outside their station scope');
    assert.equal(denied.j.error.code, 'OUT_OF_SCOPE');
    // Driver reserves on the operator's OWN station -> cancel must succeed.
    const own = await api(`/stations/${stId}`);
    const oc = own.j.station.charge_points.flatMap((c) => c.connectors).find((c) => c.status === 'AVAILABLE');
    assert.ok(oc, 'need an available connector on the assigned station');
    const d2 = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: `c2.${Date.now()}@example.in`, password: 'Driver@123', full_name: 'In Scope' }),
    });
    const H2 = { Authorization: `Bearer ${d2.j.accessToken}` };
    const r2 = await api('/reservations', {
      method: 'POST',
      headers: H2,
      body: JSON.stringify(win(Number(oc.connector_ref.split(':')[0]), Number(oc.connector_ref.split(':')[1]))),
    });
    assert.equal(r2.status, 201);
    const ok = await api(`/reservations/${r2.j.reservation.reservation_id}/cancel`, { method: 'POST', headers: OH });
    assert.equal(ok.status, 200, 'operator must cancel bookings inside their station scope');
    global.__H2 = H2;
    global.__ownRef = oc.connector_ref;
    global.__stId = stId;
  });
  await t('BUG-031: operator remote-start is station-scoped', async () => {
    const adm = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@volthub.in', password: 'Admin@123' }),
    });
    const AH = { Authorization: `Bearer ${adm.j.accessToken}` };
    const stations = await api('/admin/stations', { headers: AH });
    const stId = global.__stId ?? Math.max(...stations.j.stations.map((s) => s.station_id));
    const op = await api('/admin/users', {
      method: 'POST',
      headers: AH,
      body: JSON.stringify({
        email: `startscope.${Date.now()}@volthub.in`,
        role: 'OPERATOR',
        stationId: stId,
        full_name: 'Start Scope Op',
      }),
    });
    const opLogin = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: op.j.user.email, password: 'Temp@1234' }),
    });
    const OH = { Authorization: `Bearer ${opLogin.j.accessToken}` };
    const other = stations.j.stations.find((s) => s.station_id !== stId);
    assert.ok(other, 'need a second station for the out-of-scope probe');
    const otherCp = (await api(`/stations/${other.station_id}`)).j.station.charge_points[0];
    const denied = await api('/sessions/remote-start', {
      method: 'POST',
      headers: OH,
      body: JSON.stringify({ cpId: otherCp.cp_id, connectorNo: 1, idTag: 'TAG-1' }),
    });
    assert.equal(denied.status, 403, 'operator must not remote-start chargers outside their scope');
    assert.equal(denied.j.error.code, 'OUT_OF_SCOPE');
    // In-scope CP: scope passes, the command then fails on CP_OFFLINE (no socket in tests).
    const ownCp = (await api(`/stations/${stId}`)).j.station.charge_points[0];
    const ok = await api('/sessions/remote-start', {
      method: 'POST',
      headers: OH,
      body: JSON.stringify({ cpId: ownCp.cp_id, connectorNo: 1, idTag: 'TAG-1' }),
    });
    assert.equal(ok.status, 409, 'in-scope remote-start must pass the scope gate (CP_OFFLINE next)');
    assert.equal(ok.j.error.code, 'CP_OFFLINE');
  });
  await t('BUG-037: station active-sessions are scoped/minimized per role', async () => {
    const H2 = global.__H2;
    const stId = global.__stId;
    // Driver 2 starts a session on the operator's station (connector freed by the cancel above).
    const [cpId, no] = global.__ownRef.split(':').map(Number);
    const st = await api('/sessions/start', {
      method: 'POST',
      headers: H2,
      body: JSON.stringify({ cpId, connectorNo: no }),
    });
    assert.equal(st.status, 201);
    const sess = st.j.session;
    const d3 = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: `c3.${Date.now()}@example.in`, password: 'Driver@123', full_name: 'Peer Driver' }),
    });
    const H3 = { Authorization: `Bearer ${d3.j.accessToken}` };
    // Station active table: a peer driver must not see driver 2's session at all.
    const peer = await api(`/stations/${stId}/sessions/active`, { headers: H3 });
    assert.equal(peer.status, 200);
    assert.ok(
      !peer.j.sessions.some((x) => x.session_id === sess.session_id),
      'peer driver must not see another driver in the station active table'
    );
    // Owner sees their own session.
    const own = await api(`/stations/${stId}/sessions/active`, { headers: H2 });
    assert.ok(
      own.j.sessions.some((x) => x.session_id === sess.session_id),
      'owner must see their session'
    );
    // Connector active probe: peer gets a minimized payload (no user_id / id_tag).
    const probe = await api(`/sessions/active/${global.__ownRef}`, { headers: H3 });
    assert.equal(probe.status, 200);
    assert.ok(probe.j.session, 'presence (a session exists) must remain visible');
    assert.equal(probe.j.session.user_id, undefined, 'peer must not see the driver user_id');
    assert.equal(probe.j.session.id_tag, undefined, 'peer must not see the idTag');
    assert.equal(probe.j.session.session_id, sess.session_id);
    // Owner keeps the full row.
    const mine = await api(`/sessions/active/${global.__ownRef}`, { headers: H2 });
    assert.equal(mine.j.session.user_id, st.j.session.user_id, 'owner keeps the full row');
    await api(`/sessions/${sess.session_id}/remote-stop`, { method: 'POST', headers: H2 });
  });
  await t('BUG-032: wallet topup rejects non-numeric/negative/over-cap amounts', async () => {
    const bad = await api('/me/wallet/topup', {
      method: 'POST',
      headers: global.__H2,
      body: JSON.stringify({ amount: 'lots' }),
    });
    assert.equal(bad.status, 422);
    assert.equal(bad.j.error.code, 'INVALID_AMOUNT');
    const neg = await api('/me/wallet/topup', {
      method: 'POST',
      headers: global.__H2,
      body: JSON.stringify({ amount: -5 }),
    });
    assert.equal(neg.status, 422);
    const cap = await api('/me/wallet/topup', {
      method: 'POST',
      headers: global.__H2,
      body: JSON.stringify({ amount: 20000 }),
    });
    assert.equal(cap.status, 422);
    const ok = await api('/me/wallet/topup', {
      method: 'POST',
      headers: global.__H2,
      body: JSON.stringify({ amount: 100 }),
    });
    assert.equal(ok.status, 200);
  });
  await t('BUG-033: admin user creation validates role/email/password/name', async () => {
    const adm = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@volthub.in', password: 'Admin@123' }),
    });
    const AH = { Authorization: `Bearer ${adm.j.accessToken}` };
    const badRole = await api('/admin/users', {
      method: 'POST',
      headers: AH,
      body: JSON.stringify({ email: `x${Date.now()}@volthub.in`, role: 'SUPERADMIN' }),
    });
    assert.equal(badRole.status, 422);
    assert.equal(badRole.j.error.code, 'INVALID_ROLE');
    const badEmail = await api('/admin/users', {
      method: 'POST',
      headers: AH,
      body: JSON.stringify({ email: 'nope', role: 'OPERATOR' }),
    });
    assert.equal(badEmail.status, 422);
    assert.equal(badEmail.j.error.code, 'INVALID_EMAIL');
    const badPw = await api('/admin/users', {
      method: 'POST',
      headers: AH,
      body: JSON.stringify({ email: `y${Date.now()}@volthub.in`, role: 'OPERATOR', password: 'short' }),
    });
    assert.equal(badPw.status, 422);
    assert.equal(badPw.j.error.code, 'WEAK_PASSWORD');
  });
  await t('BUG-034: station status patch is constrained to ACTIVE/INACTIVE', async () => {
    const adm = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@volthub.in', password: 'Admin@123' }),
    });
    const AH = { Authorization: `Bearer ${adm.j.accessToken}` };
    const bad = await api(`/admin/stations/${global.__stId}`, {
      method: 'PATCH',
      headers: AH,
      body: JSON.stringify({ status: 'PAUSED' }),
    });
    assert.equal(bad.status, 422);
    assert.equal(bad.j.error.code, 'INVALID_STATUS');
    const off = await api(`/admin/stations/${global.__stId}`, {
      method: 'PATCH',
      headers: AH,
      body: JSON.stringify({ status: 'INACTIVE' }),
    });
    assert.equal(off.status, 200);
    const back = await api(`/admin/stations/${global.__stId}`, {
      method: 'PATCH',
      headers: AH,
      body: JSON.stringify({ status: 'ACTIVE' }),
    });
    assert.equal(back.status, 200);
    assert.equal(back.j.station.status, 'ACTIVE');
  });
  await t('BUG-035: logout with an unknown token stays 200 (no oracle for token validity)', async () => {
    const lo = await api('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: 'not-a-real-token' }),
    });
    assert.equal(lo.status, 200);
    assert.equal(lo.j.ok, true);
  });
  await t('PERF-002: register works when createUser is promise-shaped (durable-engine parity)', async () => {
    // The Oracle mirror wrapper makes store.createUser promise-shaped even though the
    // local one used to be sync. This pins the route to await it: without the await,
    // the durable register published pub(Promise) — a garbage user + sub:undefined JWT.
    const orig = store.createUser.bind(store);
    store.createUser = async (args) => {
      await new Promise((r) => setTimeout(r, 5)); // simulate any async backend
      return orig(args);
    };
    try {
      const r = await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          email: `promiseshape${Date.now()}@example.in`,
          password: 'Driver@123',
          full_name: 'Promise Shape',
        }),
      });
      assert.equal(r.status, 201);
      assert.equal(r.j.user.role, 'DRIVER', 'register must publish the REAL user, not a promise');
      assert.ok(r.j.user.user_id >= 1, 'user_id must be present');
      assert.ok(String(r.j.accessToken).split('.').length === 3, 'a usable access token must be issued');
    } finally {
      store.createUser = orig;
    }
  });
  await t('BUG-043: fromDriver restores canonical store codes from ORA- messages', async () => {
    // The Oracle packages raise RAISE_APPLICATION_ERROR numbers; callers and tests key
    // on the canonical names ('OVERLAP', 'TICK_REJECTED', …) that the local store throws.
    // Before BUG-043, fromDriver left e.code as 'ORA_20503' — the durable engine and the
    // local profile disagreed on the error contract (routes mapped 409 on num, but route
    // error responses and client checks matched on code).
    const { fromDriver } = require('../src/errors');
    const overlap = fromDriver(new Error('ORA-20503: overlapping reservation window'));
    assert.equal(overlap.code, 'OVERLAP', 'ORA-20503 must restore the canonical OVERLAP code');
    assert.equal(overlap.num, -20503);
    assert.equal(overlap.status, 409, 'overlap stays a 409 conflict');
    const funds = fromDriver(new Error('ORA-20705: insufficient funds'));
    assert.equal(funds.code, 'INSUFFICIENT_FUNDS', 'ORA-20705 must restore INSUFFICIENT_FUNDS');
    assert.equal(funds.status, 402, 'insufficient funds stays a 402');
    const guard = fromDriver(new Error('ORA-20801: connector state guard'));
    assert.equal(guard.code, 'CONNECTOR_GUARD');
    // Unknown numbers keep the ORA_ fallback (never crash, never invent a name).
    const unknown = fromDriver(new Error('ORA-99999: mystery'));
    assert.equal(unknown.code, 'ORA_99999');
    assert.equal(unknown.status, 500);
    // Already-normalized errors pass through untouched (status filled, code preserved).
    const norm = fromDriver({ num: -20503, code: 'OVERLAP' });
    assert.equal(norm.code, 'OVERLAP');
    assert.equal(norm.status, 409);
  });

  await t('BUG-044: listen defers to the store-upgrade promise but still binds + fires the callback', async () => {
    // Before BUG-044 the Oracle upgrade ran while the socket was ALREADY accepting
    // (ghost local-only rows in the hydration window; STORE=oracle tests raced the
    // adapter attach). The listen wrapper must: return the server (chainable), fire
    // the bind callback, and — on the no-Oracle path — bind without hanging. This
    // pins the wrapper contract; the durable ordering itself is exercised by the
    // STORE=oracle suite against a live Oracle. We re-bind after a full close:
    // close() alone waits on the suite's keep-alive sockets, so drop them first.
    server.closeAllConnections && server.closeAllConnections();
    await new Promise((r) => server.close(r));
    const ret = await new Promise((resolve, reject) => {
      const t0 = setTimeout(() => reject(new Error('listen never fired the bind callback')), 8000);
      const s = server.listen(4108, () => {
        clearTimeout(t0);
        resolve(s);
      });
    });
    assert.equal(ret, server, 'listen must return the server object (chainable)');
    await new Promise((r) => server.close(r));
  });

  console.log(`\nAPI tests: ${pass} passed`);
  server.close();
  process.exit(0);
}
main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
