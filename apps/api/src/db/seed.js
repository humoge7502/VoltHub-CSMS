// Deterministic demo seed — story-shaped per masterplan §16:
// 18-21h peak, one faulted CCS2 highway connector, tariff v1->v2 mid-window,
// one no-show + one insufficient-funds wallet. Fixed RNG for reproducibility.
'use strict';
const { hashPassword } = require('./store');

function rng(seed) { let a = seed >>> 0; return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296); }

function seedStore(s, profile = 'demo') {
  const R = rng(20260904);
  const N = profile === 'full' ? { users: 400, sessions: 10000 } : { users: 12, sessions: 60 };

  // users: 1 admin, 2 operators, rest drivers
  const admin = { user_id: ++s.seq.user, email: 'admin@volthub.in', password_hash: hashPassword('Admin@123'), full_name: 'VoltHub Admin', role: 'ADMIN', status: 'ACTIVE', created_at: new Date().toISOString() };
  s.users.set(admin.user_id, admin);
  const ops = [];
  [['arjun@volthub.in', 'Arjun Operator'], ['meera@volthub.in', 'Meera Operator']].forEach(([email, full_name]) => {
    const u = { user_id: ++s.seq.user, email, password_hash: hashPassword('Operator@123'), full_name, role: 'OPERATOR', status: 'ACTIVE', created_at: new Date().toISOString() };
    s.users.set(u.user_id, u); s.wallets.set(u.user_id, { user_id: u.user_id, balance: 0, currency: 'INR', updated_at: new Date().toISOString() }); ops.push(u);
  });
  const drivers = [];
  const names = [['Karthik', 'Raja'], ['Divya', 'Shankar'], ['Rohan', 'Menon'], ['Priya', 'Nair'], ['Vikram', 'Iyer'], ['Ananya', 'Gupta'], ['Suresh', 'Pillai'], ['Kavya', 'Reddy'], ['Aditya', 'Verma']];
  for (let i = 0; i < (profile === 'full' ? 360 : 9); i++) {
    const [fn, ln] = names[i % names.length];
    const u = { user_id: ++s.seq.user, email: `${fn.toLowerCase()}.${ln.toLowerCase()}${i}@example.in`, password_hash: hashPassword('Driver@123'), full_name: `${fn} ${ln}`, role: 'DRIVER', status: 'ACTIVE', created_at: new Date().toISOString() };
    s.users.set(u.user_id, u);
    const bal = i === 0 ? 20 : Math.round(200 + R() * 3000); // driver[0] = insufficient-funds story
    s.wallets.set(u.user_id, { user_id: u.user_id, balance: bal, currency: 'INR', updated_at: new Date().toISOString() });
    s.ledgers.push({ user_id: u.user_id, seq_no: 1, kind: 'TOPUP', amount: bal, balance_after: bal, payment_id: null, note: 'seed top-up', created_at: new Date().toISOString() });
    drivers.push(u);
    // vehicle
    const vid = ++s.seq.vehicle;
    s.vehicles.set(vid, { vehicle_id: vid, user_id: u.user_id, nickname: 'My EV', make: 'Tata', model: 'Nexon EV', battery_kwh: 40.5, is_default: 'Y', created_at: new Date().toISOString() });
    s.vehicleStd.push({ vehicle_id: vid, standard_id: 1 }, { vehicle_id: vid, standard_id: 2 });
  }

  // stations: Chennai + OMR corridor (real-ish geocodes)
  const stationDefs = [
    ['VIT Chennai Gate', 12.9716, 80.0412, 'Vandalur-Kelambakkam Rd, Chennai', 'Chennai', 'Tamil Nadu', '600127', ['CAFE', 'WIFI', 'PARKING', 'CCTV']],
    ['OMR Perungudi Hub', 12.9698, 80.2436, 'Rajiv Gandhi Salai, Perungudi', 'Chennai', 'Tamil Nadu', '600096', ['SHOP', 'RESTROOM', 'PARKING']],
    ['Guindy Depot', 13.0067, 80.2206, 'GST Rd, Guindy', 'Chennai', 'Tamil Nadu', '600032', ['CANOPY', 'CCTV', 'PARKING']],
    ['ECR Highway Stop', 12.8691, 80.2267, 'East Coast Rd, Kanathur', 'Chennai', 'Tamil Nadu', '603110', ['CAFE', 'RESTROOM', 'CANOPY']],
  ];
  stationDefs.forEach(([name, lat, lng, addr, city, state, pin, ams], i) => {
    const station_id = ++s.seq.station;
    s.stations.set(station_id, { station_id, name, latitude: lat, longitude: lng, address_line: addr, city, state, pincode: pin, status: 'ACTIVE', operator_id: ops[i % ops.length].user_id, created_at: new Date().toISOString() });
    ams.forEach(a => s.amenities.push({ station_id, amenity: a }));
    for (let p = 0; p < 2; p++) {
      const cp_id = ++s.seq.cp;
      const ocpp = `VH-${station_id}-CP${p + 1}`;
      // SEC-003: per-CP Basic secret (Security Profile 1). Deterministic in demo seeds so the
      // simulator can derive it; production provisions random secrets via SQL (V005 default).
      s.cps.set(cp_id, { cp_id, station_id, ocpp_identity: ocpp, auth_secret: `dev-${ocpp}`, vendor: 'VoltHub', model: p === 0 ? 'VH-DC60' : 'VH-AC22', firmware_version: '1.6.5', status: 'ONLINE', last_boot_at: new Date().toISOString(), last_seen_at: new Date().toISOString() });
      s.cpsByOcpp.set(ocpp, cp_id);
      const defs = p === 0 ? [[1, 1, 22], [2, 2, 60]] : [[1, 1, 22], [2, 2, 120]];
      defs.forEach(([std, no, kw], k) => {
        s.connectors.set(`${cp_id}:${no}`, { cp_id, connector_no: no, standard_id: std, max_power_kw: kw, status: 'AVAILABLE', last_state_change_at: new Date().toISOString() });
      });
    }
  });
  // fault story: one CCS2 highway connector faulted
  const faultCp = 7; // ECR station DC point
  if (s.connectors.get(`${faultCp}:2`)) {
    s.connectors.get(`${faultCp}:2`).status = 'FAULTED';
    const fid = ++s.seq.fault;
    s.faults.set(fid, { fault_id: fid, connector_ref: `${faultCp}:2`, cp_id: faultCp, error_code: 'GroundFailure', severity: 'CRITICAL', source: 'OCPP', description: 'Ground fault detected mid-session (seed story)', reported_by: null, reported_at: new Date(Date.now() - 30 * 3600000).toISOString(), cleared_at: null });
  }

  // tariffs: group 1 City v1->v2 (ToU day 22/kWh, peak 18-22h 28/kWh), group 2 Highway flat
  const mkPlan = (group, ver, name, fee, from, prev) => {
    const plan_id = ++s.seq.plan;
    s.plans.set(plan_id, { plan_id, group_id: group, version_no: ver, name, currency: 'INR', session_fee: fee, idle_fee_per_30min: 0, active_from: from, active_to: null, supersedes_plan_id: prev || null, created_by: admin.user_id, created_at: new Date().toISOString() });
    if (prev) s.plans.get(prev).active_to = from;
    return plan_id;
  };
  const v1 = mkPlan(1, 1, 'City Day v1', 20, new Date(Date.now() - 60 * 86400000).toISOString(), null);
  const v2 = mkPlan(1, 2, 'City Day v2', 20, new Date(Date.now() - 15 * 86400000).toISOString(), v1);
  const h1 = mkPlan(2, 1, 'Highway Flat v1', 49, new Date(Date.now() - 60 * 86400000).toISOString(), null);
  const t = (d) => d; // times stored as HH:MM strings (B8: '24:00' unrepresentable in Oracle TIMESTAMP — canonical '23:59')
  [[v1, 18], [v2, 22], [h1, 25]].forEach(([p, day]) => {
    const b1 = ++s.seq.band; s.bands.push({ band_id: b1, plan_id: p, day_scope: 'ALL', start_time: '00:00', end_time: '18:00', price_per_kwh: day });
    const b2 = ++s.seq.band; s.bands.push({ band_id: b2, plan_id: p, day_scope: 'ALL', start_time: '18:00', end_time: '22:00', price_per_kwh: day + 6 });
    const b3 = ++s.seq.band; s.bands.push({ band_id: b3, plan_id: p, day_scope: 'ALL', start_time: '22:00', end_time: '23:59', price_per_kwh: day });
  });

  // sessions: diurnal (18-21h 2.5x), some invoiced+paid
  const connKeys = [...s.connectors.keys()].filter(k => s.connectors.get(k).status === 'AVAILABLE');
  const count = profile === 'full' ? 400 : N.sessions;
  for (let i = 0; i < count; i++) {
    const d = drivers[Math.floor(R() * drivers.length)];
    const key = connKeys[Math.floor(R() * connKeys.length)];
    const [cp, no] = key.split(':').map(Number);
    const start = new Date(Date.now() - Math.floor(R() * 30) * 86400000 - Math.floor(R() * 86400) * 1000);
    const durMin = Math.min(30 + R() * 60, 240);
    const end = new Date(start.getTime() + durMin * 60000);
    const kwh = +(5 + R() * 35).toFixed(3);
    const sid = ++s.seq.sess;
    const planId = start < new Date(Date.now() - 15 * 86400000) ? v1 : v2;
    s.sessions.set(sid, { session_id: sid, user_id: d.user_id, vehicle_id: [...s.vehicles.values()].find(v => v.user_id === d.user_id)?.vehicle_id || null, reservation_id: null, connector_ref: key, tariff_plan_id: planId, id_tag: `TAG-${d.user_id}`, state: 'COMPLETED', billing_state: 'UNBILLED', started_at: start.toISOString(), ended_at: end.toISOString(), start_meter_kwh: 0, end_meter_kwh: kwh, energy_kwh: kwh, stop_reason: 'SEED' });
    const nTicks = 4 + Math.floor(R() * 8);
    for (let q = 1; q <= nTicks; q++) {
      const ts = new Date(start.getTime() + (durMin * 60000 * q) / nTicks).toISOString();
      const mk = +(kwh * q / nTicks).toFixed(3);
      s.readings.push({ session_id: sid, seq_no: q, taken_at: ts, meter_kwh: mk, power_kw: +(20 + R() * 40).toFixed(1), voltage_v: 400, current_a: 80, source: 'SYNTHETIC' });
      s.ticks.push({ ts, session_id: sid, connector_ref: key, meter_kwh: mk, power_kw: 30, voltage_v: 400, current_a: 80 });
    }
    // bill 94%, pay most (driver[0] keeps failing -> insufficient funds story visible)
    // BUG-013 fix: invoice math routes through the same band resolver + plan fee as billSession.
    if (R() < 0.94) {
      try {
        const bandPrice = s.resolveBandPrice(planId, start.toISOString());
        const plan = s.plans.get(planId);
        const fee = plan ? Number(plan.session_fee) : 0;
        const amt = +((kwh * bandPrice) + fee).toFixed(2);
        const inv = ++s.seq.inv;
        s.invoices.set(inv, { invoice_id: inv, session_id: sid, tariff_plan_id: planId, status: 'DUE', total: amt, currency: 'INR', issued_at: end.toISOString() });
        s.lines.push({ invoice_id: inv, line_no: 1, kind: 'ENERGY', description: `Energy ${kwh} kWh @ Rs.${bandPrice}`, quantity: kwh, unit: 'kWh', unit_price: bandPrice, amount: +((kwh * bandPrice).toFixed(2)) });
        if (fee > 0) s.lines.push({ invoice_id: inv, line_no: 2, kind: 'SESSION_FEE', description: 'Session fee', quantity: 1, unit: null, unit_price: fee, amount: fee });
        const sess = s.sessions.get(sid); sess.billing_state = 'BILLED';
        const w = s.wallets.get(d.user_id);
        if (w && w.balance >= amt && R() < 0.9) {
          const seq = s.ledgers.filter(l => l.user_id === d.user_id).length + 1;
          const pid = ++s.seq.pay;
          s.payments.set(pid, { payment_id: pid, invoice_id: inv, amount: amt, method: 'WALLET', status: 'SUCCESS', reference: `SEED-${pid}`, created_at: end.toISOString() });
          s.ledgers.push({ user_id: d.user_id, seq_no: seq, kind: 'PAYMENT', amount: -amt, balance_after: +(w.balance - amt).toFixed(2), payment_id: pid, note: `Invoice ${inv}`, created_at: end.toISOString() });
          w.balance = +(w.balance - amt).toFixed(2);
          s.invoices.get(inv).status = 'PAID';
        }
      } catch { /* keep UNBILLED */ }
    }
  }
  // one no-show reservation (EXPIRED story)
  const rid = ++s.seq.res;
  s.reservations.set(rid, { reservation_id: rid, connector_ref: connKeys[0], user_id: drivers[1].user_id, vehicle_id: null, start_at: new Date(Date.now() - 3 * 3600000).toISOString(), end_at: new Date(Date.now() - 2 * 3600000).toISOString(), status: 'EXPIRED', created_at: new Date().toISOString() });

  return { users: s.users.size, stations: s.stations.size, sessions: s.sessions.size, invoices: s.invoices.size };
}

module.exports = { seedStore };
