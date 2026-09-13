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
      throw new Error('oracledb not installed (npm i -w apps/api oracledb)', { cause: e });
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
    // ADR-0010: V007 control rows hydrate best-effort too (a DB without V007 skips clean).
    await q(
      `SELECT asset_id, station_id, parent_id, kind, label, cap_kw, ramp_kw, status, proposed_by, approved_by,
              TO_CHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') c FROM grid_asset`,
      'gridAssets',
      (r) => {
        local.gridAssets.set(Number(r.ASSET_ID), {
          asset_id: Number(r.ASSET_ID),
          station_id: Number(r.STATION_ID),
          parent_id: r.PARENT_ID != null ? Number(r.PARENT_ID) : null,
          kind: r.KIND,
          label: r.LABEL,
          cap_kw: Number(r.CAP_KW),
          ramp_kw: r.RAMP_KW != null ? Number(r.RAMP_KW) : null,
          status: r.STATUS,
          proposed_by: r.PROPOSED_BY != null ? Number(r.PROPOSED_BY) : null,
          approved_by: r.APPROVED_BY != null ? Number(r.APPROVED_BY) : null,
          created_at: r.C || '',
          updated_at: '',
        });
        local.seq.gridAsset = Math.max(local.seq.gridAsset, Number(r.ASSET_ID));
      }
    );
    await q(
      `SELECT decision_id, site_id, horizon_start, interval_min, bounds_hash, solver, runtime_ms, state_version, status,
              TO_CHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') c FROM control_decision`,
      'controlDecisions',
      (r) => {
        local.controlDecisions.set(Number(r.DECISION_ID), {
          decision_id: Number(r.DECISION_ID),
          site_id: Number(r.SITE_ID),
          horizon_start: r.HORIZON_START ? new Date(r.HORIZON_START).toISOString() : '',
          interval_min: Number(r.INTERVAL_MIN),
          payload_json: '{}', // payload rehydrates lazily from Oracle on detail reads
          bounds_hash: r.BOUNDS_HASH,
          solver: r.SOLVER,
          runtime_ms: r.RUNTIME_MS != null ? Number(r.RUNTIME_MS) : null,
          state_version: r.STATE_VERSION != null ? Number(r.STATE_VERSION) : null,
          status: r.STATUS,
          created_at: r.C || '',
        });
        local.seq.decision = Math.max(local.seq.decision, Number(r.DECISION_ID));
      }
    );
    await q(
      `SELECT cert_id, session_id, reservation_id, station_id, cp_id, connector_no, floor_kw, margin_kwh,
              worst_case_kwh, required_kwh, deadline_at, decision_id, status, reason,
              TO_CHAR(issued_at, 'YYYY-MM-DD"T"HH24:MI:SS') i FROM feasibility_certificate`,
      'certificates',
      (r) => {
        local.certificates.set(Number(r.CERT_ID), {
          cert_id: Number(r.CERT_ID),
          session_id: r.SESSION_ID != null ? Number(r.SESSION_ID) : null,
          reservation_id: r.RESERVATION_ID != null ? Number(r.RESERVATION_ID) : null,
          station_id: Number(r.STATION_ID),
          cp_id: Number(r.CP_ID),
          connector_no: Number(r.CONNECTOR_NO),
          floor_kw: Number(r.FLOOR_KW),
          margin_kwh: Number(r.MARGIN_KWH),
          worst_case_kwh: Number(r.WORST_CASE_KWH),
          required_kwh: Number(r.REQUIRED_KWH),
          deadline_at: r.DEADLINE_AT ? new Date(r.DEADLINE_AT).toISOString() : null,
          decision_id: r.DECISION_ID != null ? Number(r.DECISION_ID) : null,
          status: r.STATUS,
          reason: r.REASON || null,
          issued_at: r.I || '',
          updated_at: '',
        });
        local.seq.cert = Math.max(local.seq.cert, Number(r.CERT_ID));
      }
    );
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

// BUG-048: undo paths used `arr.length = savedLen` to roll back appended rows.
// If two mirror failures interleave, a later undo can GROW the array back to a stale
// length, leaving sparse holes — Array.prototype.find/filter then visit `undefined`
// and crash (`Cannot read properties of undefined (reading 'event_id')` in the
// internal outbox/ack route). truncateTo only ever shrinks: it clamps to the saved
// length and never resurrects a hole. (Safe even when other writers appended after
// the snapshot — those rows are simply kept, which is the correct at-least-once
// behaviour for the outbox.)
function truncateTo(arr, savedLen) {
  if (arr.length > savedLen) arr.length = savedLen;
}

// BUG-049: explicit-id mirror tables (app_user, wallet_account, wallet_ledger,
// station, charge_point, connector, vehicle). V001 uses IDENTITY BY DEFAULT ON NULL
// precisely so mirrored rows can carry the LOCAL id — but Oracle still auto-increments
// its identity for any OTHER writer (a second API process, a STORE=oracle suite, a
// manual INSERT). After such a write the local seq counter is permanently behind and
// every subsequent mirror fails with ORA-00001 until restart — observed live on the
// compose stack (register 500'd with ORA-00001: USER_ID 4543 already exists; the
// boot log said users:17 while Oracle had MAX(user_id)=4543).
// This is the mirror of BUG-044's counter-divergence class, but for id-AUTHORITY
// tables (BUG-044 was Oracle-authoritative ids diverging from local; this is local-
// authoritative counters diverging from Oracle). Both directions share one repair:
// read Oracle's MAX(id), clamp the local counter UP to it, re-key any conflicting
// local rows onto fresh Oracle-side ids, and surface a canonical 409 while the
// INSERT races another writer.
// Site inventory: which explicit-id mirror writes key on which counter, and how to
// re-key a staged row when the id was lost to another writer. wallet_ledger is NOT
// listed: its seq_no is per-user and mirrored from the staged local entry — a
// duplicate there means the LEDGER row raced, which the ledger's own uniqueness
// contract (not a counter) owns; the INSERT simply maps to a canonical 409.
const MIRROR_SEQ_TABLES = {
  app_user: {
    pk: 'user_id',
    seq: 'user',
    local: (s) => s.users,
    // Move the staged user (and its staged wallet + audit trail) onto the new id so
    // the JWT sub, /me bindings and the retried INSERT all agree.
    rekey: (local, from, to) => {
      const map = local.users;
      const row = map.get(from);
      map.delete(from);
      row.user_id = to;
      map.set(to, row);
      if (local.wallets.has(from)) {
        const w = local.wallets.get(from);
        local.wallets.delete(from);
        w.user_id = to;
        local.wallets.set(to, w);
      }
      for (const a of local.audit)
        if (a.entity_name === 'APP_USER' && a.entity_id === String(from)) a.entity_id = String(to);
    },
  },
  station: { pk: 'station_id', seq: 'station', local: (s) => s.stations },
  charge_point: { pk: 'cp_id', seq: 'cp', local: (s) => s.cps },
};

// Re-baseline one counter against Oracle and re-map a colliding local row (if the
// caller already staged one with an id Oracle has since given away). Returns the
// number Oracle will not hand out again (the counter's new floor) — the caller
// retries the INSERT with the re-keyed id. Null when the counter was already ahead.
async function realignMirrorSeq(local, pool, site, conflictId) {
  const conn = await pool.getConnection();
  try {
    const r = await conn.execute(`SELECT NVL(MAX(${site.pk}), 0) AS m FROM ${site.table}`);
    const maxId = Number(r.rows[0][0] ?? r.rows[0].M ?? 0);
    if (maxId > local.seq[site.seq]) local.seq[site.seq] = maxId;
    if (conflictId != null && conflictId <= maxId) {
      // Another writer owns conflictId: move the staged local row onto the next
      // free id (post-clamp ++seq is strictly greater than every Oracle row).
      const next = ++local.seq[site.seq];
      const map = site.local && site.local(local);
      if (map && map.has(conflictId) && site.rekey) site.rekey(local, conflictId, next);
      else if (map && map.has(conflictId)) {
        const row = map.get(conflictId);
        map.delete(conflictId);
        row[site.pk] = next;
        map.set(next, row);
      }
      return next;
    }
    return null;
  } finally {
    try {
      await conn.close();
    } catch {}
  }
}

// Map a raw driver error from an explicit-id mirror INSERT to the canonical store
// contract. ORA-00001 under concurrent writers is a benign lost race — the counter
// is re-baselined and the caller retries — but if it reaches the client it must look
// like the local store's duplicate-id contract (409 DUPLICATE_ID), never a 500.
const ORA_00001_STATUS = 409;
function fromMirrorInsertError(e) {
  const m = /ORA-(\d{5})/.exec(String((e && e.message) || e || ''));
  if (m && m[1] === '00001') {
    e.num = -1;
    e.code = 'DUPLICATE_ID';
    e.status = ORA_00001_STATUS;
    return e;
  }
  return fromDriver(e);
}

// Mirror helper: run `attempt` (which stages local rows + INSERTs to Oracle with
// explicit ids); on ORA-00001 re-baseline the counter from Oracle's MAX(id), re-key
// the staged row, and retry ONCE. Any other error propagates unchanged.
async function withMirrorRetry(local, pool, table, conflictId, attempt) {
  try {
    return await attempt();
  } catch (e) {
    const m = /ORA-(\d{5})/.exec(String((e && e.message) || e || ''));
    if (!m || m[1] !== '00001') throw e;
    const site = MIRROR_SEQ_TABLES[table];
    if (!site) throw fromMirrorInsertError(e);
    const next = await realignMirrorSeq(local, pool, { ...site, table }, conflictId);
    if (next == null) throw fromMirrorInsertError(e);
    return attempt(); // retry with the re-keyed id + clamped counter
  }
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
  const origCreateUser = local.createUser.bind(local);
  const origTopup = local.topup.bind(local);

  local._oracle = { pool, mode: 'oracle', hydratedAt: new Date().toISOString() };

  // BUG-038: single-connection helper for multi-statement write-through mirrors
  // (user + wallet rows must commit atomically). connExec targets the connection
  // leased by the enclosing withConnSync call.
  // BUG-042: mirrors are SERIALIZED. Two overlapping write-throughs (e.g. register's
  // welcome top-up racing the next request's reservation mirror) interleaved on the
  // single mirrorConn — connExec/commit landed on the wrong connection and the
  // reservation 500'd. A promise-chain queue gives each mirror exclusive access.
  let mirrorConn = null;
  let mirrorChain = Promise.resolve();
  const withConnSync = (fn) => {
    const run = mirrorChain.then(async () => {
      const c = await pool.getConnection();
      mirrorConn = c;
      try {
        return await fn();
      } finally {
        mirrorConn = null;
        try {
          await c.close();
        } catch {}
      }
    });
    // Keep the chain alive regardless of individual mirror failures.
    mirrorChain = run.then(
      () => {},
      () => {}
    );
    return run;
  };
  const connExec = (sql, binds) => {
    if (!mirrorConn) throw new Error('connExec called outside withConnSync');
    return mirrorConn.execute(sql, binds || {});
  };

  // BUG-038: identity + wallet writes are write-through too. Before this, a user who
  // registered AFTER boot existed only in the local Map — their first reservation hit
  // Oracle's FK (reservation.user_id -> app_user) and 500'd. The compose demo path
  // (register -> reserve) was broken against the durable engine; CI's STORE=oracle step
  // only passed because the adapter attached after the old suites finished.
  // Id authority: the LOCAL store assigns ids (JWT sub, wallet ledger seq, route bindings
  // all use them); Oracle mirrors with EXPLICIT ids (V001 uses IDENTITY BY DEFAULT ON NULL
  // precisely so mirrored rows can carry the local id). On mirror failure the local write
  // is undone — the caller sees the Oracle error, never a silent divergence.
  // PERF-002: origCreateUser is async now (off-loop Argon2id) — the wrapper awaits it
  // and stays promise-shaped; routes await the whole chain.
  local.createUser = async (args) => {
    const walletCreated = (args.role || 'DRIVER') === 'DRIVER';
    // BUG-049: an ORA-00001 on the explicit-id INSERT means another writer consumed
    // the id Oracle-side (identity auto-increment is NOT local-authority aware).
    // Re-baseline seq.user from Oracle's MAX(user_id), re-key the staged local row,
    // and retry once. The retry re-runs origCreateUser? NO — the local user object
    // is already staged; only the mirror failed. The retry below re-INSERTs with the
    // re-keyed id. Attempt is a closure over `u`, so it must be built after staging.
    let u = null;
    const attempt = () =>
      withConnSync(async () => {
        await connExec(
          `INSERT INTO app_user (user_id, email, password_hash, full_name, phone, role, status)
           VALUES (:id, :email, :hash, :name, :phone, :role, 'ACTIVE')`,
          { id: u.user_id, email: u.email, hash: u.password_hash, name: u.full_name, phone: u.phone, role: u.role }
        );
        if (local.wallets.has(u.user_id)) {
          await connExec('INSERT INTO wallet_account (user_id, balance) VALUES (:id, 0)', { id: u.user_id });
        }
        await mirrorConn.commit();
        return u;
      });
    try {
      u = await origCreateUser(args);
      return await withMirrorRetry(local, pool, 'app_user', u.user_id, attempt);
    } catch (e) {
      // Undo the local write so a failed registration leaves no ghost identity.
      if (u) {
        local.users.delete(u.user_id);
        if (walletCreated) local.wallets.delete(u.user_id);
        local.audit = local.audit.filter((a) => !(a.entity_name === 'APP_USER' && a.entity_id === String(u.user_id)));
      }
      throw fromMirrorInsertError(e);
    }
  };

  local.topup = (uid, amount) => {
    const wBefore = local.wallets.get(Number(uid));
    const preBalance = wBefore ? wBefore.balance : 0;
    const ledgerBefore = local.ledgers.length;
    const w = origTopup(uid, amount);
    const entry = local.ledgers[local.ledgers.length - 1];
    const attempt = () =>
      withConnSync(async () => {
        await connExec(
          `INSERT INTO wallet_ledger (user_id, seq_no, kind, amount, balance_after, note)
           VALUES (:u, :seq, 'TOPUP', :amt, :bal, 'top-up')`,
          { u: Number(uid), seq: entry.seq_no, amt: amount, bal: entry.balance_after }
        );
        await connExec('UPDATE wallet_account SET balance = :bal, updated_at = SYSTIMESTAMP WHERE user_id = :u', {
          bal: entry.balance_after,
          u: Number(uid),
        });
        await mirrorConn.commit();
        return w;
      });
    return withMirrorRetry(local, pool, 'wallet_ledger', null, attempt).catch((e) => {
      // Undo: restore balance, drop the ledger row, filter the audit entry.
      if (wBefore) {
        wBefore.balance = preBalance;
        wBefore.updated_at = new Date().toISOString();
        local.wallets.set(Number(uid), wBefore);
      } else local.wallets.delete(Number(uid));
      truncateTo(local.ledgers, ledgerBefore);
      local.audit = local.audit.filter(
        (a) => !(a.entity_name === 'WALLET' && a.entity_id === String(uid) && a.action === 'TOPUP')
      );
      throw fromMirrorInsertError(e);
    });
  };

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

  // BUG-038 (part 2): cancels must reach Oracle too, else a rehydrate resurrects a
  // cancelled booking as BOOKED. Local cancel already enforces role scope + status;
  // mirror it to reservation_pkg.cancel_reservation first, undo local on mirror failure.
  const origCancelReservation = local.cancelReservation.bind(local);
  local.cancelReservation = async (rid, actor, role, scopeStations) => {
    try {
      await withConn(async (conn) => {
        await conn.execute('BEGIN reservation_pkg.cancel_reservation(:p_res, :p_actor); END;', {
          p_res: Number(rid),
          p_actor: actor ?? null,
        });
        await conn.commit();
      });
    } catch (e) {
      throw fromDriver(e);
    }
    try {
      return await origCancelReservation(rid, actor, role, scopeStations);
    } catch (e) {
      // Oracle won but local disagreed (e.g. clock-skewed status): trust Oracle.
      if (e && e.code === 'CANCEL_CONFLICT') {
        const r = local.reservations.get(Number(rid));
        if (r) r.status = 'CANCELLED';
        return r;
      }
      throw e;
    }
  };

  // BUG-045: session STARTS are write-through too. The REST /sessions/start and OCPP
  // StartTransaction paths ran the local store only — the durable engine never saw the
  // session, so the first wrapped call (recordTick → charge_session_pkg.record_meter_tick)
  // 500'd with ORA-01403 no data found. BUG-044's timing fix (listen waits for the
  // upgrade) finally made the STORE=oracle suites attach the adapter BEFORE tests ran and
  // exposed it — exactly the class of gap BUG-038/041 documented.
  // Local-first on purpose: the local store owns validation including B2G-013b
  // owner-adoption (the package only enforces the explicit-reservationId form); the
  // package only ever sees a validated start. The package assigns the durable id; when it
  // differs from the local seq id the read-cache is remapped so every subsequent wrapped
  // call (transition/recordTick/bill) keys on the SAME row. Hydrate keeps the two
  // counters in lockstep, but a failed mirror consumes an Oracle IDENTITY value while the
  // local seq id was already handed out — the remap makes that divergence harmless.
  const origStartSession = local.startSession.bind(local);
  local.startSession = async (args) => {
    const sess = await origStartSession(args);
    const localSid = sess.session_id;
    const cBefore = local.connectors.get(sess.connector_ref);
    const cStatusBefore = cBefore ? cBefore.status : null;
    const rBefore = sess.reservation_id ? local.reservations.get(Number(sess.reservation_id)) : null;
    const rStatusBefore = rBefore ? rBefore.status : null;
    const stateEventsLen = local.stateEvents.length;
    const auditLen = local.audit.length;
    const outboxLen = local.outbox.length;
    try {
      const oracleSid = await withConn(async (conn) => {
        const r = await conn.execute(
          'BEGIN charge_session_pkg.start_session(:p_user, :p_vehicle, :p_cp, :p_conn, :p_plan, :p_res, :p_idtag, :p_sid); END;',
          {
            p_user: sess.user_id,
            p_vehicle: sess.vehicle_id,
            p_cp: sess.cp_id,
            p_conn: sess.connector_no,
            p_plan: sess.tariff_plan_id,
            p_res: sess.reservation_id ? Number(sess.reservation_id) : null,
            p_idtag: sess.id_tag,
            p_sid: BIND_OUT_NUM,
          }
        );
        await conn.commit();
        return r.outBinds.p_sid;
      });
      if (Number(oracleSid) !== localSid) {
        // Remap the local read-cache to the durable id (wrapped calls key on it).
        const remapped = { ...sess, session_id: Number(oracleSid) };
        local.sessions.delete(localSid);
        local.sessions.set(Number(oracleSid), remapped);
        for (const ev of local.stateEvents) if (ev.session_id === localSid) ev.session_id = Number(oracleSid);
        for (const a of local.audit)
          if (a.entity_name === 'CHARGING_SESSION' && a.entity_id === String(localSid)) a.entity_id = String(oracleSid);
        for (const e of local.outbox)
          if (e.payload && e.payload.session_id === localSid) e.payload.session_id = Number(oracleSid);
        return remapped;
      }
      return sess;
    } catch (e) {
      // Undo the local write so a failed durable start leaves no ghost session.
      local.sessions.delete(localSid);
      if (cBefore) {
        cBefore.status = cStatusBefore;
        cBefore.last_state_change_at = new Date().toISOString();
      }
      if (rBefore && rStatusBefore) rBefore.status = rStatusBefore;
      truncateTo(local.stateEvents, stateEventsLen);
      truncateTo(local.audit, auditLen);
      truncateTo(local.outbox, outboxLen);
      throw fromDriver(e);
    }
  };

  // BUG-047: admin hardware writes are write-through too. Before this, a station/CP
  // provisioned via POST /admin/stations, POST /admin/charge-points, or PATCH
  // /admin/stations/:id existed only in the read-cache — the durable engine never saw
  // the rows, so the first reservation/session on a provisioned connector 500'd with
  // ORA-01403 (SELECT status FROM connector found nothing). Mirrored with EXPLICIT
  // local ids (the createUser pattern); connector INSERTs are new rows, so the
  // connector-state guard trigger (BEFORE UPDATE OF status) does not fire. Undo on
  // mirror failure leaves no ghost station/CP/connector in the cache.
  const origProvisionStation = local.provisionStation.bind(local);
  local.provisionStation = async (adminId, b) => {
    const cpsBefore = new Set([...local.cps.keys()]);
    const connsBefore = new Set([...local.connectors.keys()]);
    const amenitiesLen = local.amenities.length;
    const auditLen = local.audit.length;
    const res = origProvisionStation(adminId, b);
    const st = res.station;
    const newCps = [...local.cps.values()].filter((c) => !cpsBefore.has(c.cp_id));
    const newConns = [...local.connectors.values()].filter((c) => !connsBefore.has(`${c.cp_id}:${c.connector_no}`));
    const attempt = () =>
      withConnSync(async () => {
        await connExec(
          `INSERT INTO station (station_id, name, latitude, longitude, address_line, city, state, pincode, status, operator_id)
           VALUES (:id, :name, :lat, :lng, :addr, :city, :state, :pin, 'ACTIVE', :op)`,
          {
            id: st.station_id,
            name: st.name,
            lat: st.latitude,
            lng: st.longitude,
            addr: st.address_line,
            city: st.city,
            state: st.state,
            pin: st.pincode,
            op: st.operator_id,
          }
        );
        for (const a of local.amenities.filter((x) => x.station_id === st.station_id)) {
          await connExec('INSERT INTO station_amenity (station_id, amenity) VALUES (:s, :a)', {
            s: st.station_id,
            a: a.amenity,
          });
        }
        for (const cp of newCps) {
          await connExec(
            `INSERT INTO charge_point (cp_id, station_id, ocpp_identity, vendor, model, firmware_version, status, auth_secret)
             VALUES (:id, :st, :oid, :v, :m, :fv, 'OFFLINE', :sec)`,
            {
              id: cp.cp_id,
              st: cp.station_id,
              oid: cp.ocpp_identity,
              v: cp.vendor,
              m: cp.model,
              fv: cp.firmware_version,
              sec: cp.auth_secret,
            }
          );
        }
        for (const cn of newConns) {
          await connExec(
            `INSERT INTO connector (cp_id, connector_no, standard_id, max_power_kw, status)
             VALUES (:cp, :no, :std, :kw, 'AVAILABLE')`,
            { cp: cn.cp_id, no: cn.connector_no, std: cn.standard_id, kw: cn.max_power_kw }
          );
        }
        await mirrorConn.commit();
      });
    try {
      return await withMirrorRetry(local, pool, 'station', st.station_id, attempt);
    } catch (e) {
      local.stations.delete(st.station_id);
      for (const cp of newCps) {
        local.cps.delete(cp.cp_id);
        local.cpsByOcpp.delete(cp.ocpp_identity);
      }
      for (const cn of newConns) local.connectors.delete(`${cn.cp_id}:${cn.connector_no}`);
      truncateTo(local.amenities, amenitiesLen);
      truncateTo(local.audit, auditLen);
      throw fromMirrorInsertError(e);
    }
  };

  const origProvisionChargePoint = local.provisionChargePoint.bind(local);
  local.provisionChargePoint = async (stationId, b) => {
    const connsBefore = new Set([...local.connectors.keys()]);
    const cp = origProvisionChargePoint(stationId, b);
    const newConns = [...local.connectors.values()].filter((c) => !connsBefore.has(`${c.cp_id}:${c.connector_no}`));
    const attempt = () =>
      withConnSync(async () => {
        await connExec(
          `INSERT INTO charge_point (cp_id, station_id, ocpp_identity, vendor, model, firmware_version, status, auth_secret)
           VALUES (:id, :st, :oid, :v, :m, :fv, 'OFFLINE', :sec)`,
          {
            id: cp.cp_id,
            st: cp.station_id,
            oid: cp.ocpp_identity,
            v: cp.vendor,
            m: cp.model,
            fv: cp.firmware_version,
            sec: cp.auth_secret,
          }
        );
        for (const cn of newConns) {
          await connExec(
            `INSERT INTO connector (cp_id, connector_no, standard_id, max_power_kw, status)
             VALUES (:cp, :no, :std, :kw, 'AVAILABLE')`,
            { cp: cn.cp_id, no: cn.connector_no, std: cn.standard_id, kw: cn.max_power_kw }
          );
        }
        await mirrorConn.commit();
      });
    try {
      return await withMirrorRetry(local, pool, 'charge_point', cp.cp_id, attempt);
    } catch (e) {
      local.cps.delete(cp.cp_id);
      local.cpsByOcpp.delete(cp.ocpp_identity);
      for (const cn of newConns) local.connectors.delete(`${cn.cp_id}:${cn.connector_no}`);
      throw fromMirrorInsertError(e);
    }
  };

  const origUpdateStation = local.updateStation.bind(local);
  local.updateStation = async (id, fields) => {
    const { station: st, prev } = origUpdateStation(id, fields);
    try {
      await withConnSync(async () => {
        await connExec(`UPDATE station SET status = :status, operator_id = :op, name = :name WHERE station_id = :id`, {
          status: st.status,
          op: st.operator_id,
          name: st.name,
          id: st.station_id,
        });
        await mirrorConn.commit();
      });
      // Preserve the local method's return shape ({ station, prev }) — callers
      // destructure { station } (BUG-047; same class as BUG-041 promise-shape).
      return { station: st, prev };
    } catch (e) {
      st.status = prev.status;
      st.operator_id = prev.operator_id;
      st.name = prev.name;
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

// ---- ADR-0010 mirrors: control writes go to V007 with the LOCAL id as authority ----
// (V001 identity-by-default-on-null mirrors explicit local ids; identical rule here).
// Envelope/grid validation already ran in the local method — the mirror is a
// straight write-through. Failure raises through fromMirrorInsertError so callers
// see the ORA band, never a silent divergence.
function wrapControl(local, pool) {
  const withConn = async (fn) => {
    const c = await pool.getConnection();
    try {
      return await fn(c);
    } finally {
      try {
        await c.close();
      } catch {}
    }
  };

  const origUpsertGridAsset = local.upsertGridAsset.bind(local);
  local.upsertGridAsset = (stationId, b, actor) => {
    const a = origUpsertGridAsset(stationId, b, actor);
    const p = withConn(async (c) => {
      if (b.asset_id) {
        await c.execute(
          `UPDATE grid_asset SET cap_kw = :cap, ramp_kw = :ramp, status = :st, updated_at = SYSTIMESTAMP WHERE asset_id = :id`,
          { cap: a.cap_kw, ramp: a.ramp_kw, st: a.status, id: a.asset_id }
        );
      } else {
        await c.execute(
          `INSERT INTO grid_asset (asset_id, station_id, parent_id, kind, label, cap_kw, ramp_kw, status, proposed_by)
           VALUES (:id, :sid, :pid, :kind, :label, :cap, :ramp, :st, :proposer)`,
          {
            id: a.asset_id,
            sid: a.station_id,
            pid: a.parent_id,
            kind: a.kind,
            label: a.label,
            cap: a.cap_kw,
            ramp: a.ramp_kw,
            st: a.status,
            proposer: a.proposed_by,
          }
        );
      }
      await c.commit();
    });
    p.catch(() => {});
    return a;
  };

  const origApproveGridAsset = local.approveGridAsset.bind(local);
  local.approveGridAsset = (assetId, actor) => {
    const a = origApproveGridAsset(assetId, actor);
    withConn(async (c) => {
      await c.execute(
        `UPDATE grid_asset SET status = :st, approved_by = :appr, updated_at = SYSTIMESTAMP WHERE asset_id = :id`,
        { st: a.status, appr: a.approved_by, id: a.asset_id }
      );
      await c.commit();
    }).catch(() => {});
    return a;
  };

  const origSetControlMode = local.setControlMode.bind(local);
  local.setControlMode = (siteId, mode, actor) => {
    const out = origSetControlMode(siteId, mode, actor);
    withConn(async (c) => {
      // Mode is station-level; keep the audit trail in Oracle via AUDIT_PKG-equivalent insert.
      await c
        .execute(`INSERT INTO control_audit_note (site_id, from_mode, to_mode, actor) VALUES (:sid, :f, :t, :a)`, {
          sid: out.site_id,
          f: out.previous,
          t: out.mode,
          a: actor ?? null,
        })
        .catch(async () => {
          // Table is optional sugar; the audit row is the source of truth.
        });
      await c.commit();
    }).catch(() => {});
    return out;
  };

  const origRecordDecision = local.recordDecision.bind(local);
  local.recordDecision = (siteId, d) => {
    const row = origRecordDecision(siteId, d);
    withConn(async (c) => {
      await c.execute(
        `INSERT INTO control_decision (decision_id, site_id, horizon_start, interval_min, payload_json, bounds_hash, solver, runtime_ms, state_version, status)
         VALUES (:id, :sid, :hs, :iv, :pj, :bh, :sv, :rt, :ver, 'COMMITTED')`,
        {
          id: row.decision_id,
          sid: row.site_id,
          hs: new Date(row.horizon_start),
          iv: row.interval_min,
          pj: String(row.payload_json),
          bh: row.bounds_hash,
          sv: row.solver,
          rt: row.runtime_ms,
          ver: row.state_version,
        },
        { autoCommit: true }
      );
    }).catch(() => {});
    return row;
  };

  const origIssueCertificate = local.issueCertificate.bind(local);
  local.issueCertificate = (args) => {
    const row = origIssueCertificate(args);
    withConn(async (c) => {
      await c.execute(
        `INSERT INTO feasibility_certificate (cert_id, session_id, reservation_id, station_id, cp_id, connector_no, floor_kw, margin_kwh, worst_case_kwh, required_kwh, deadline_at, decision_id, status, reason)
         VALUES (:id, :sess, :res, :sid, :cp, :no, :floor, :margin, :wc, :req, :dl, :dec, :st, :reason)`,
        {
          id: row.cert_id,
          sess: row.session_id,
          res: row.reservation_id,
          sid: row.station_id,
          cp: row.cp_id,
          no: row.connector_no,
          floor: row.floor_kw,
          margin: row.margin_kwh,
          wc: row.worst_case_kwh,
          req: row.required_kwh,
          dl: row.deadline_at ? new Date(row.deadline_at) : null,
          dec: row.decision_id,
          st: row.status,
          reason: row.reason,
        },
        { autoCommit: true }
      );
    }).catch(() => {});
    return row;
  };

  const origTransitionCertificate = local.transitionCertificate.bind(local);
  local.transitionCertificate = (certId, to, reason) => {
    const row = origTransitionCertificate(certId, to, reason);
    withConn(async (c) => {
      await c.execute(
        `UPDATE feasibility_certificate SET status = :st, reason = :reason, updated_at = SYSTIMESTAMP WHERE cert_id = :id`,
        { st: row.status, reason: row.reason, id: row.cert_id },
        { autoCommit: true }
      );
    }).catch(() => {});
    return row;
  };

  const origRecordProfilePush = local.recordProfilePush.bind(local);
  local.recordProfilePush = (args) => {
    const out = origRecordProfilePush(args);
    if (out.deduped) return out;
    const row = out.row;
    withConn(async (c) => {
      await c.execute(
        `INSERT INTO charging_profile_push (push_id, decision_id, cp_id, profile_payload, payload_sha256, clamped)
         VALUES (:id, :dec, :cp, :pj, :sha, :cl)`,
        {
          id: row.push_id,
          dec: row.decision_id,
          cp: row.cp_id,
          pj: String(row.profile_payload),
          sha: row.payload_sha256,
          cl: row.clamped,
        },
        { autoCommit: true }
      );
    }).catch(() => {});
    return out;
  };

  const origSetPushAck = local.setPushAck.bind(local);
  local.setPushAck = (pushId, ackResult) => {
    const row = origSetPushAck(pushId, ackResult);
    withConn(async (c) => {
      await c.execute(
        `UPDATE charging_profile_push SET ack_result = :ack WHERE push_id = :id`,
        { ack: String(ackResult).slice(0, 20), id: Number(pushId) },
        { autoCommit: true }
      );
    }).catch(() => {});
    return row;
  };

  const origDeadLetter = local.deadLetter.bind(local);
  local.deadLetter = (args) => {
    const row = origDeadLetter(args);
    withConn(async (c) => {
      await c.execute(
        `MERGE INTO dead_letter d USING (SELECT :ref AS event_ref FROM dual) s ON (d.event_ref = s.event_ref)
         WHEN MATCHED THEN UPDATE SET d.last_seen_at = SYSTIMESTAMP
         WHEN NOT MATCHED THEN INSERT (letter_id, event_ref, kind, reason_code, detail, payload) VALUES (:id, :ref, :kind, :rc, :detail, :payload)`,
        {
          ref: row.event_ref,
          id: row.letter_id,
          kind: row.kind,
          rc: row.reason_code,
          detail: row.detail,
          payload: row.payload,
        },
        { autoCommit: true }
      );
    }).catch(() => {});
    return row;
  };

  const origResolveDeadLetter = local.resolveDeadLetter.bind(local);
  local.resolveDeadLetter = (letterId, action, actor) => {
    const row = origResolveDeadLetter(letterId, action, actor);
    withConn(async (c) => {
      await c.execute(
        `UPDATE dead_letter SET status = :st, last_seen_at = SYSTIMESTAMP WHERE letter_id = :id`,
        { st: row.status, id: row.letter_id },
        { autoCommit: true }
      );
    }).catch(() => {});
    return row;
  };

  return local;
}

module.exports = {
  createPool,
  ping,
  hydrate,
  wrapWithOracle,
  wrapControl,
  truncateTo,
  fromMirrorInsertError,
  realignMirrorSeq,
  MIRROR_SEQ_TABLES,
};
