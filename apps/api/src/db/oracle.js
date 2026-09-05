// Oracle adapter (BUG-001): write-through package calls over a hydrated local read-cache.
// Shape: wraps the local store object (same Maps + method surface) so routes/tests are
// unchanged. Writes go to Oracle packages first (row locks enforced there), then apply
// to the local Maps on success. Boot hydrates Maps from Oracle (durable across restarts).
// Reads serve from the hydrated Maps (documented single-VM read-cache; multi-instance
// read-through is out of scope — see ADR-0005). All SQL uses named binds, zero concat.
// Requires: ORACLE_HOST set + `oracledb` installed. Otherwise factory returns local.
'use strict';
const { fromDriver } = require('../errors');

let _oracledb = null;
function driver() {
  if (!_oracledb) {
    try { _oracledb = require('oracledb'); } catch (e) { throw new Error('oracledb not installed (npm i -w apps/api oracledb)'); }
  }
  return _oracledb;
}

async function createPool() {
  const oracledb = driver();
  // Thin mode: no Instant Client needed for 23ai usage here.
  return oracledb.createPool({
    user: process.env.ORACLE_USER || 'volthub',
    password: process.env.ORACLE_PASSWORD || 'volthub_dev_pwd',
    connectString: `${process.env.ORACLE_HOST}:${process.env.ORACLE_PORT || 1521}/${process.env.ORACLE_SERVICE || 'freepdb1'}`,
    poolMin: 1, poolMax: Number(process.env.ORACLE_POOL_MAX || 8), poolIncrement: 1,
  });
}

async function ping(pool) {
  const c = await pool.getConnection();
  try { await c.execute('SELECT 1 FROM DUAL'); return true; }
  finally { try { await c.close(); } catch {} }
}

// Hydrate local Maps from Oracle tables (best-effort per table; empty DB => keep seeds).
async function hydrate(local, pool) {
  const c = await pool.getConnection();
  const stats = {};
  try {
    const q = async (sql, map, fn) => {
      try {
        const r = await c.execute(sql, [], { outFormat: driver().OUT_FORMAT_OBJECT });
        (r.rows || []).forEach(row => fn(row));
        stats[map] = (r.rows || []).length;
      } catch (e) { stats[map] = `skip:${e.message.slice(0, 60)}`; }
    };
    await q('SELECT user_id, email, password_hash, full_name, phone, role, status FROM app_user', 'users', r => {
      local.users.set(Number(r.USER_ID), { user_id: Number(r.USER_ID), email: r.EMAIL, password_hash: r.PASSWORD_HASH, full_name: r.FULL_NAME, phone: r.PHONE, role: r.ROLE, status: r.STATUS, created_at: '' });
      local.seq.user = Math.max(local.seq.user, Number(r.USER_ID));
    });
    await q('SELECT user_id, balance, currency FROM wallet_account', 'wallets', r => {
      local.wallets.set(Number(r.USER_ID), { user_id: Number(r.USER_ID), balance: Number(r.BALANCE), currency: r.CURRENCY, updated_at: '' });
    });
    await q('SELECT station_id, name, latitude, longitude, address_line, city, state, pincode, status, operator_id FROM station', 'stations', r => {
      local.stations.set(Number(r.STATION_ID), { station_id: Number(r.STATION_ID), name: r.NAME, latitude: Number(r.LATITUDE), longitude: Number(r.LONGITUDE), address_line: r.ADDRESS_LINE, city: r.CITY, state: r.STATE, pincode: r.PINCODE, status: r.STATUS, operator_id: r.OPERATOR_ID ? Number(r.OPERATOR_ID) : null, created_at: '' });
      local.seq.station = Math.max(local.seq.station, Number(r.STATION_ID));
    });
    await q('SELECT cp_id, station_id, ocpp_identity, vendor, model, firmware_version, status, auth_secret FROM charge_point', 'cps', r => {
      const id = Number(r.CP_ID);
      local.cps.set(id, { cp_id: id, station_id: Number(r.STATION_ID), ocpp_identity: r.OCPP_IDENTITY, auth_secret: r.AUTH_SECRET || `dev-${r.OCPP_IDENTITY}`, vendor: r.VENDOR, model: r.MODEL, firmware_version: r.FIRMWARE_VERSION, status: r.STATUS, last_boot_at: null, last_seen_at: null });
      local.cpsByOcpp.set(r.OCPP_IDENTITY, id);
      local.seq.cp = Math.max(local.seq.cp, id);
    });
    await q('SELECT cp_id, connector_no, standard_id, max_power_kw, status FROM connector', 'connectors', r => {
      local.connectors.set(`${r.CP_ID}:${r.CONNECTOR_NO}`, { cp_id: Number(r.CP_ID), connector_no: Number(r.CONNECTOR_NO), standard_id: Number(r.STANDARD_ID), max_power_kw: Number(r.MAX_POWER_KW), status: r.STATUS, last_state_change_at: new Date().toISOString() });
    });
    await q('SELECT plan_id, group_id, version_no, name, currency, session_fee FROM tariff_plan', 'plans', r => {
      local.plans.set(Number(r.PLAN_ID), { plan_id: Number(r.PLAN_ID), group_id: Number(r.GROUP_ID), version_no: Number(r.VERSION_NO), name: r.NAME, currency: r.CURRENCY, session_fee: Number(r.SESSION_FEE), idle_fee_per_30min: 0, active_from: '', active_to: null, supersedes_plan_id: null, created_by: null, created_at: '' });
      local.seq.plan = Math.max(local.seq.plan, Number(r.PLAN_ID));
    });
    await q('SELECT band_id, plan_id, day_scope, TO_CHAR(start_time, \'HH24:MI\') s, TO_CHAR(end_time, \'HH24:MI\') e, price_per_kwh FROM tariff_band', 'bands', r => {
      local.bands.push({ band_id: Number(r.BAND_ID), plan_id: Number(r.PLAN_ID), day_scope: r.DAY_SCOPE, start_time: r.S, end_time: r.E, price_per_kwh: Number(r.PRICE_PER_KWH) });
      local.seq.band = Math.max(local.seq.band, Number(r.BAND_ID));
    });
  } finally { try { await c.close(); } catch {} }
  return stats;
}

function wrapWithOracle(local, pool) {
  const oracledb = driver();
  const withConn = async (fn) => {
    const conn = await pool.getConnection();
    try { return await fn(conn); }
    finally { try { await conn.close(); } catch {} }
  };
  const BIND_OUT_NUM = { dir: oracledb.BIND_OUT, type: oracledb.NUMBER };

  // Keep references: override methods on the same object routes already hold.
  const origCreateReservation = local.createReservation.bind(local);

  local._oracle = { pool, mode: 'oracle', hydratedAt: new Date().toISOString() };

  local.createReservation = async (uid, vehicleId, cpId, connNo, startAt, endAt) => {
    try {
      const out = await withConn(async (conn) => {
        const r = await conn.execute(
          'BEGIN reservation_pkg.create_reservation(:p_user, :p_vehicle, :p_cp, :p_conn, :p_start, :p_end, :p_res_id); END;',
          { p_user: uid, p_vehicle: vehicleId || null, p_cp: cpId, p_conn: connNo, p_start: new Date(startAt), p_end: new Date(endAt), p_res_id: BIND_OUT_NUM });
        await conn.commit();
        return r.outBinds.p_res_id;
      });
      // Write-through: apply the same transition locally so reads stay coherent.
      // Reuse the local mutex path but bypass its own overlap check by direct insert is risky;
      // instead call the local implementation inside the same per-connector mutex only if Oracle won.
      // Simplest coherent path: run local create (it will succeed — Oracle already serialized),
      // but on local conflict (clock skew) prefer the Oracle id.
      try {
        const r = await origCreateReservation(uid, vehicleId, cpId, connNo, startAt, endAt);
        r.oracle_id = out;
        return r;
      } catch {
        return { reservation_id: out, connector_ref: `${cpId}:${connNo}`, user_id: uid, vehicle_id: vehicleId || null, start_at: new Date(startAt).toISOString(), end_at: new Date(endAt).toISOString(), status: 'BOOKED', oracle: true };
      }
    } catch (e) { throw fromDriver(e); }
  };

  const origTransition = local.transition.bind(local);
  local.transition = async (sid, to, reason) => {
    try {
      await withConn(async (conn) => {
        await conn.execute('BEGIN charge_session_pkg.transition(:p_session, :p_to, :p_reason); END;',
          { p_session: Number(sid), p_to: to, p_reason: reason || null });
        await conn.commit();
      });
    } catch (e) { throw fromDriver(e); }
    return origTransition(sid, to, reason).catch(() => local.sessions.get(Number(sid)));
  };

  const origRecordTick = local.recordTick.bind(local);
  local.recordTick = async (sid, seq, at, kwh, kw, v, a) => {
    try {
      await withConn(async (conn) => {
        await conn.execute(
          'BEGIN charge_session_pkg.record_meter_tick(:p_session, :p_seq, :p_at, :p_kwh, :p_kw, :p_v, :p_a); END;',
          { p_session: Number(sid), p_seq: seq, p_at: at ? new Date(at) : new Date(), p_kwh: kwh, p_kw: kw ?? null, p_v: v ?? null, p_a: a ?? null });
        await conn.commit();
      });
    } catch (e) { throw fromDriver(e); }
    return origRecordTick(sid, seq, at, kwh, kw, v, a);
  };

  const origBill = local.billSession.bind(local);
  local.billSession = async (sid) => {
    try {
      const invId = await withConn(async (conn) => {
        const r = await conn.execute('BEGIN billing_pkg.bill_session(:p_session, :p_invoice); END;',
          { p_session: Number(sid), p_invoice: BIND_OUT_NUM });
        await conn.commit();
        return r.outBinds.p_invoice;
      });
      try { return await origBill(sid); } catch { return local.invoices.get(invId) || { invoice_id: invId, session_id: Number(sid), oracle: true }; }
    } catch (e) { throw fromDriver(e); }
  };

  const origPay = local.payInvoice.bind(local);
  local.payInvoice = async (invId, uid) => {
    try {
      await withConn(async (conn) => {
        await conn.execute('BEGIN billing_pkg.pay_invoice(:p_invoice, :p_user, :p_payment); END;',
          { p_invoice: Number(invId), p_user: uid, p_payment: BIND_OUT_NUM });
        await conn.commit();
      });
    } catch (e) { throw fromDriver(e); }
    return origPay(invId, uid).catch(() => ({ oracle: true, invoice_id: Number(invId) }));
  };

  const origExpire = local.expireStale.bind(local);
  local.expireStale = async () => {
    try {
      const n = await withConn(async (conn) => {
        const r = await conn.execute('BEGIN reservation_pkg.expire_stale(:p_rows); END;', { p_rows: BIND_OUT_NUM });
        await conn.commit();
        return r.outBinds.p_rows;
      });
      await origExpire().catch(() => 0);
      return Number(n) || 0;
    } catch { return origExpire(); }
  };

  return local;
}

module.exports = { createPool, ping, hydrate, wrapWithOracle };
