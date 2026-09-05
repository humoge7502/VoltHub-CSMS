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
    try {
      _oracledb = require('oracledb');
    } catch (e) {
      throw new Error('oracledb not installed (npm i -w apps/api oracledb)');
    }
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
    poolMin: 1,
    poolMax: Number(process.env.ORACLE_POOL_MAX || 8),
    poolIncrement: 1,
  });
}

async function ping(pool) {
  const c = await pool.getConnection();
  try {
    await c.execute('SELECT 1 FROM DUAL');
    return true;
  } finally {
    try {
      await c.close();
    } catch {}
  }
}

// Hydrate local Maps from Oracle tables (best-effort per table; empty DB => keep seeds).
async function hydrate(local, pool) {
  const c = await pool.getConnection();
  const stats = {};
  try {
    const q = async (sql, map, fn) => {
      try {
        const r = await c.execute(sql, [], { outFormat: driver().OUT_FORMAT_OBJECT });
        (r.rows || []).forEach((row) => fn(row));
        stats[map] = (r.rows || []).length;
      } catch (e) {
        stats[map] = `skip:${e.message.slice(0, 60)}`;
      }
    };
    await q('SELECT user_id, email, password_hash, full_name, phone, role, status FROM app_user', 'users', (r) => {
      local.users.set(Number(r.USER_ID), {
        user_id: Number(r.USER_ID),
        email: r.EMAIL,
        password_hash: r.PASSWORD_HASH,
        full_name: r.FULL_NAME,
        phone: r.PHONE,
        role: r.ROLE,
        status: r.STATUS,
        created_at: '',
      });
      local.seq.user = Math.max(local.seq.user, Number(r.USER_ID));
    });
    await q('SELECT user_id, balance, currency FROM wallet_account', 'wallets', (r) => {
      local.wallets.set(Number(r.USER_ID), {
        user_id: Number(r.USER_ID),
        balance: Number(r.BALANCE),
        currency: r.CURRENCY,
        updated_at: '',
      });
    });
    await q(
      'SELECT station_id, name, latitude, longitude, address_line, city, state, pincode, status, operator_id FROM station',
      'stations',
      (r) => {
        local.stations.set(Number(r.STATION_ID), {
          station_id: Number(r.STATION_ID),
          name: r.NAME,
          latitude: Number(r.LATITUDE),
          longitude: Number(r.LONGITUDE),
          address_line: r.ADDRESS_LINE,
          city: r.CITY,
          state: r.STATE,
          pincode: r.PINCODE,
          status: r.STATUS,
          operator_id: r.OPERATOR_ID ? Number(r.OPERATOR_ID) : null,
          created_at: '',
        });
        local.seq.station = Math.max(local.seq.station, Number(r.STATION_ID));
      }
    );
    await q(
      'SELECT cp_id, station_id, ocpp_identity, vendor, model, firmware_version, status, auth_secret FROM charge_point',
      'cps',
      (r) => {
        const id = Number(r.CP_ID);
        local.cps.set(id, {
          cp_id: id,
          station_id: Number(r.STATION_ID),
          ocpp_identity: r.OCPP_IDENTITY,
          auth_secret: r.AUTH_SECRET || `dev-${r.OCPP_IDENTITY}`,
          vendor: r.VENDOR,
          model: r.MODEL,
          firmware_version: r.FIRMWARE_VERSION,
          status: r.STATUS,
          last_boot_at: null,
          last_seen_at: null,
        });
        local.cpsByOcpp.set(r.OCPP_IDENTITY, id);
        local.seq.cp = Math.max(local.seq.cp, id);
      }
    );
    await q('SELECT cp_id, connector_no, standard_id, max_power_kw, status FROM connector', 'connectors', (r) => {
      local.connectors.set(`${r.CP_ID}:${r.CONNECTOR_NO}`, {
        cp_id: Number(r.CP_ID),
        connector_no: Number(r.CONNECTOR_NO),
        standard_id: Number(r.STANDARD_ID),
        max_power_kw: Number(r.MAX_POWER_KW),
        status: r.STATUS,
        last_state_change_at: new Date().toISOString(),
      });
    });
    await q('SELECT plan_id, group_id, version_no, name, currency, session_fee FROM tariff_plan', 'plans', (r) => {
      local.plans.set(Number(r.PLAN_ID), {
        plan_id: Number(r.PLAN_ID),
        group_id: Number(r.GROUP_ID),
        version_no: Number(r.VERSION_NO),
        name: r.NAME,
        currency: r.CURRENCY,
        session_fee: Number(r.SESSION_FEE),
        idle_fee_per_30min: 0,
        active_from: '',
        active_to: null,
        supersedes_plan_id: null,
        created_by: null,
        created_at: '',
      });
      local.seq.plan = Math.max(local.seq.plan, Number(r.PLAN_ID));
    });
    await q(
      "SELECT band_id, plan_id, day_scope, TO_CHAR(start_time, 'HH24:MI') s, TO_CHAR(end_time, 'HH24:MI') e, price_per_kwh FROM tariff_band",
      'bands',
      (r) => {
        local.bands.push({
          band_id: Number(r.BAND_ID),
          plan_id: Number(r.PLAN_ID),
          day_scope: r.DAY_SCOPE,
          start_time: r.S,
          end_time: r.E,
          price_per_kwh: Number(r.PRICE_PER_KWH),
        });
        local.seq.band = Math.max(local.seq.band, Number(r.BAND_ID));
      }
    );
    // B2G-005: hydrate the transactional world (reservations → sessions → invoices → ledger).
    // Best-effort per table; empty DB => keep seeds. seq counters reseeded from MAX(id).
    await q(
      `SELECT reservation_id, connector_ref, cp_id, connector_no, user_id, vehicle_id, start_at, end_at, status,
         TO_CHAR(created_at,'YYYY-MM-DD"T"HH24:MI:SS') c FROM reservation`,
      'reservations',
      (r) => {
        const cpId = r.CP_ID != null ? Number(r.CP_ID) : Number(String(r.CONNECTOR_REF).split(':')[0]);
        const connNo = r.CONNECTOR_NO != null ? Number(r.CONNECTOR_NO) : Number(String(r.CONNECTOR_REF).split(':')[1]);
        local.reservations.set(Number(r.RESERVATION_ID), {
          reservation_id: Number(r.RESERVATION_ID),
          connector_ref: r.CONNECTOR_REF,
          cp_id: cpId,
          connector_no: connNo,
          user_id: Number(r.USER_ID),
          vehicle_id: r.VEHICLE_ID ? Number(r.VEHICLE_ID) : null,
          start_at: new Date(r.START_AT).toISOString(),
          end_at: new Date(r.END_AT).toISOString(),
          status: r.STATUS,
          created_at: r.C,
        });
        local.seq.res = Math.max(local.seq.res, Number(r.RESERVATION_ID));
      }
    );
    await q(
      `SELECT session_id, user_id, vehicle_id, reservation_id, connector_ref, cp_id, connector_no, tariff_plan_id, id_tag,
      state, billing_state, started_at, ended_at, start_meter_kwh, end_meter_kwh, energy_kwh, stop_reason FROM charging_session`,
      'sessions',
      (r) => {
        const id = Number(r.SESSION_ID);
        const cpId = r.CP_ID != null ? Number(r.CP_ID) : Number(String(r.CONNECTOR_REF).split(':')[0]);
        const connNo = r.CONNECTOR_NO != null ? Number(r.CONNECTOR_NO) : Number(String(r.CONNECTOR_REF).split(':')[1]);
        local.sessions.set(id, {
          session_id: id,
          user_id: Number(r.USER_ID),
          vehicle_id: r.VEHICLE_ID ? Number(r.VEHICLE_ID) : null,
          reservation_id: r.RESERVATION_ID ? Number(r.RESERVATION_ID) : null,
          connector_ref: r.CONNECTOR_REF,
          cp_id: cpId,
          connector_no: connNo,
          tariff_plan_id: Number(r.TARIFF_PLAN_ID),
          id_tag: r.ID_TAG,
          state: r.STATE,
          billing_state: r.BILLING_STATE,
          started_at: r.STARTED_AT ? new Date(r.STARTED_AT).toISOString() : new Date().toISOString(),
          ended_at: r.ENDED_AT ? new Date(r.ENDED_AT).toISOString() : null,
          start_meter_kwh: Number(r.START_METER_KWH ?? 0),
          end_meter_kwh: r.END_METER_KWH != null ? Number(r.END_METER_KWH) : null,
          energy_kwh: r.ENERGY_KWH != null ? Number(r.ENERGY_KWH) : null,
          stop_reason: r.STOP_REASON,
        });
        local.seq.sess = Math.max(local.seq.sess, id);
      }
    );
    await q(
      'SELECT session_id, seq_no, taken_at, meter_kwh, power_kw, voltage_v, current_a, source FROM meter_reading',
      'readings',
      (r) => {
        const sid = Number(r.SESSION_ID),
          seq = Number(r.SEQ_NO);
        local.readings.push({
          session_id: sid,
          seq_no: seq,
          taken_at: new Date(r.TAKEN_AT).toISOString(),
          meter_kwh: Number(r.METER_KWH),
          power_kw: r.POWER_KW != null ? Number(r.POWER_KW) : null,
          voltage_v: r.VOLTAGE_V != null ? Number(r.VOLTAGE_V) : null,
          current_a: r.CURRENT_A != null ? Number(r.CURRENT_A) : null,
          source: r.SOURCE,
        });
        let seen = local._seqSeen.get(sid);
        if (!seen) {
          seen = new Set();
          local._seqSeen.set(sid, seen);
        }
        seen.add(seq);
        // rebuild local ticks projection for telemetry fallback
        const sess = local.sessions.get(sid);
        local.ticks.push({
          ts: new Date(r.TAKEN_AT).toISOString(),
          session_id: sid,
          connector_ref: sess?.connector_ref || '',
          meter_kwh: Number(r.METER_KWH),
          power_kw: r.POWER_KW != null ? Number(r.POWER_KW) : null,
          voltage_v: r.VOLTAGE_V != null ? Number(r.VOLTAGE_V) : null,
          current_a: r.CURRENT_A != null ? Number(r.CURRENT_A) : null,
        });
      }
    );
    await q('SELECT invoice_id, session_id, tariff_plan_id, status, total FROM invoice', 'invoices', (r) => {
      const id = Number(r.INVOICE_ID);
      local.invoices.set(id, {
        invoice_id: id,
        session_id: Number(r.SESSION_ID),
        tariff_plan_id: Number(r.TARIFF_PLAN_ID),
        status: r.STATUS,
        total: Number(r.TOTAL),
        currency: 'INR',
        issued_at: new Date().toISOString(),
      });
      local.seq.inv = Math.max(local.seq.inv, id);
    });
    await q(
      'SELECT invoice_id, line_no, kind, description, quantity, unit, unit_price, amount FROM invoice_line',
      'lines',
      (r) => {
        local.lines.push({
          invoice_id: Number(r.INVOICE_ID),
          line_no: Number(r.LINE_NO),
          kind: r.KIND,
          description: r.DESCRIPTION,
          quantity: r.QUANTITY != null ? Number(r.QUANTITY) : null,
          unit: r.UNIT,
          unit_price: r.UNIT_PRICE != null ? Number(r.UNIT_PRICE) : null,
          amount: Number(r.AMOUNT),
        });
      }
    );
    await q('SELECT payment_id, invoice_id, amount, method, status, reference FROM payment', 'payments', (r) => {
      const id = Number(r.PAYMENT_ID);
      local.payments.set(id, {
        payment_id: id,
        invoice_id: Number(r.INVOICE_ID),
        amount: Number(r.AMOUNT),
        method: r.METHOD,
        status: r.STATUS,
        reference: r.REFERENCE,
        created_at: new Date().toISOString(),
      });
      local.seq.pay = Math.max(local.seq.pay, id);
    });
    await q(
      'SELECT user_id, seq_no, kind, amount, balance_after, payment_id, note FROM wallet_ledger',
      'ledger',
      (r) => {
        local.ledgers.push({
          user_id: Number(r.USER_ID),
          seq_no: Number(r.SEQ_NO),
          kind: r.KIND,
          amount: Number(r.AMOUNT),
          balance_after: Number(r.BALANCE_AFTER),
          payment_id: r.PAYMENT_ID ? Number(r.PAYMENT_ID) : null,
          note: r.NOTE,
          created_at: new Date().toISOString(),
        });
      }
    );
    await q(
      'SELECT fault_id, connector_ref, cp_id, error_code, severity, source, description, reported_by, reported_at, cleared_at FROM fault',
      'faults',
      (r) => {
        const id = Number(r.FAULT_ID);
        local.faults.set(id, {
          fault_id: id,
          connector_ref: r.CONNECTOR_REF,
          cp_id: r.CP_ID ? Number(r.CP_ID) : null,
          error_code: r.ERROR_CODE,
          severity: r.SEVERITY,
          source: r.SOURCE,
          description: r.DESCRIPTION,
          reported_by: r.REPORTED_BY ? Number(r.REPORTED_BY) : null,
          reported_at: r.REPORTED_AT ? new Date(r.REPORTED_AT).toISOString() : new Date().toISOString(),
          cleared_at: r.CLEARED_AT ? new Date(r.CLEARED_AT).toISOString() : null,
        });
        local.seq.fault = Math.max(local.seq.fault, id);
      }
    );
    await q('SELECT notification_id, user_id, kind, title, is_read FROM notification', 'notifications', (r) => {
      local.notifs.push({
        notification_id: Number(r.NOTIFICATION_ID),
        user_id: Number(r.USER_ID),
        kind: r.KIND,
        title: r.TITLE,
        payload: {},
        is_read: r.IS_READ,
        created_at: new Date().toISOString(),
      });
      local.seq.notif = Math.max(local.seq.notif, Number(r.NOTIFICATION_ID));
    });
    await q(
      'SELECT vehicle_id, user_id, nickname, make, model, battery_kwh, is_default FROM vehicle',
      'vehicles',
      (r) => {
        const id = Number(r.VEHICLE_ID);
        local.vehicles.set(id, {
          vehicle_id: id,
          user_id: Number(r.USER_ID),
          nickname: r.NICKNAME,
          make: r.MAKE,
          model: r.MODEL,
          battery_kwh: Number(r.BATTERY_KWH),
          is_default: r.IS_DEFAULT,
          created_at: '',
        });
        local.seq.vehicle = Math.max(local.seq.vehicle, id);
      }
    );
    await q('SELECT event_id, kind, dedupe_key, payload, created_at, processed_at FROM outbox_event', 'outbox', (r) => {
      const id = Number(r.EVENT_ID);
      let payload = {};
      try {
        payload = JSON.parse(r.PAYLOAD);
      } catch {}
      local.outbox.push({
        event_id: id,
        kind: r.KIND,
        dedupe_key: r.DEDUPE_KEY,
        payload,
        created_at: r.CREATED_AT ? new Date(r.CREATED_AT).toISOString() : new Date().toISOString(),
        processed_at: r.PROCESSED_AT ? new Date(r.PROCESSED_AT).toISOString() : null,
      });
      local.seq.outbox = Math.max(local.seq.outbox, id);
    });
    await q('SELECT key_value, status_code, response_body FROM idempotency_key', 'idem', (r) => {
      try {
        local.idem.set(r.KEY_VALUE, { status_code: Number(r.STATUS_CODE), response_body: r.RESPONSE_BODY });
      } catch {}
    });
    await q(
      'SELECT token_hash, user_id, device_label, family_id, generation, expires_at, revoked_at FROM refresh_token',
      'refresh',
      (r) => {
        // best-effort: older DBs may lack family_id/generation columns -> skip table
        local.refresh.set(r.TOKEN_HASH, {
          token_hash: r.TOKEN_HASH,
          user_id: Number(r.USER_ID),
          device_label: r.DEVICE_LABEL,
          family_id: r.FAMILY_ID || r.TOKEN_HASH,
          generation: r.GENERATION ? Number(r.GENERATION) : 0,
          created_at: '',
          expires_at: r.EXPIRES_AT ? new Date(r.EXPIRES_AT).toISOString() : '',
          revoked_at: r.REVOKED_AT ? new Date(r.REVOKED_AT).toISOString() : null,
        });
      }
    );
  } finally {
    try {
      await c.close();
    } catch {}
  }
  return stats;
}

function wrapWithOracle(local, pool) {
  const oracledb = driver();
  const withConn = async (fn) => {
    const conn = await pool.getConnection();
    try {
      return await fn(conn);
    } finally {
      try {
        await conn.close();
      } catch {}
    }
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
          {
            p_user: uid,
            p_vehicle: vehicleId || null,
            p_cp: cpId,
            p_conn: connNo,
            p_start: new Date(startAt),
            p_end: new Date(endAt),
            p_res_id: BIND_OUT_NUM,
          }
        );
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
        return {
          reservation_id: out,
          connector_ref: `${cpId}:${connNo}`,
          cp_id: Number(cpId),
          connector_no: Number(connNo),
          user_id: uid,
          vehicle_id: vehicleId || null,
          start_at: new Date(startAt).toISOString(),
          end_at: new Date(endAt).toISOString(),
          status: 'BOOKED',
          oracle: true,
        };
      }
    } catch (e) {
      throw fromDriver(e);
    }
  };

  const origTransition = local.transition.bind(local);
  local.transition = async (sid, to, reason) => {
    try {
      await withConn(async (conn) => {
        await conn.execute('BEGIN charge_session_pkg.transition(:p_session, :p_to, :p_reason); END;', {
          p_session: Number(sid),
          p_to: to,
          p_reason: reason || null,
        });
        await conn.commit();
      });
    } catch (e) {
      throw fromDriver(e);
    }
    return origTransition(sid, to, reason).catch(() => local.sessions.get(Number(sid)));
  };

  const origRecordTick = local.recordTick.bind(local);
  local.recordTick = async (sid, seq, at, kwh, kw, v, a) => {
    try {
      await withConn(async (conn) => {
        await conn.execute(
          'BEGIN charge_session_pkg.record_meter_tick(:p_session, :p_seq, :p_at, :p_kwh, :p_kw, :p_v, :p_a); END;',
          {
            p_session: Number(sid),
            p_seq: seq,
            p_at: at ? new Date(at) : new Date(),
            p_kwh: kwh,
            p_kw: kw ?? null,
            p_v: v ?? null,
            p_a: a ?? null,
          }
        );
        await conn.commit();
      });
    } catch (e) {
      throw fromDriver(e);
    }
    return origRecordTick(sid, seq, at, kwh, kw, v, a);
  };

  const origBill = local.billSession.bind(local);
  local.billSession = async (sid) => {
    try {
      const invId = await withConn(async (conn) => {
        const r = await conn.execute('BEGIN billing_pkg.bill_session(:p_session, :p_invoice); END;', {
          p_session: Number(sid),
          p_invoice: BIND_OUT_NUM,
        });
        await conn.commit();
        return r.outBinds.p_invoice;
      });
      try {
        return await origBill(sid);
      } catch {
        return local.invoices.get(invId) || { invoice_id: invId, session_id: Number(sid), oracle: true };
      }
    } catch (e) {
      throw fromDriver(e);
    }
  };

  const origPay = local.payInvoice.bind(local);
  local.payInvoice = async (invId, uid) => {
    try {
      await withConn(async (conn) => {
        await conn.execute('BEGIN billing_pkg.pay_invoice(:p_invoice, :p_user, :p_payment); END;', {
          p_invoice: Number(invId),
          p_user: uid,
          p_payment: BIND_OUT_NUM,
        });
        await conn.commit();
      });
    } catch (e) {
      throw fromDriver(e);
    }
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
    } catch {
      return origExpire();
    }
  };

  return local;
}

module.exports = { createPool, ping, hydrate, wrapWithOracle };
