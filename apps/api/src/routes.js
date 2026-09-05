// VoltHub REST API — /api/v1 (masterplan §18). Thin over store packages;
// Oracle error numbers mapped to HTTP: -20501->422, -20502/-20503->409,
// -20601->409, -20703/20704->409, -20705->402.
'use strict';
const express = require('express');
const crypto = require('crypto');
const { vRegister, vReservation, vVehicle } = require('@volthub/shared');
const { signAccess, issueRefresh, authRequired, roles, scopeCheck, requireOwned } = require('./middleware/auth');
const { checkLoginThrottle } = require('./middleware/security');
const { oraStatus } = require('./errors');

module.exports = function routes(store) {
  const r = express.Router();
  const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---- auth ----
  r.post(
    '/auth/register',
    safe(async (req, res) => {
      vRegister(req.body);
      const u = store.createUser({
        email: req.body.email,
        password: req.body.password,
        full_name: req.body.full_name,
        role: 'DRIVER',
      });
      store.topup(u.user_id, 500); // welcome credit (capped demo economy; see topup caps)
      store.auditLog(u.user_id, 'APP_USER', u.user_id, 'REGISTER', null, { email: u.email });
      res.status(201).json({
        user: pub(u),
        accessToken: signAccess(u, store),
        refreshToken: issueRefresh(store, u, req.body.device),
      });
    })
  );
  r.post(
    '/auth/login',
    safe(async (req, res) => {
      // B2G-010: login tier 10/min per IP with Retry-After.
      if (!checkLoginThrottle(req, res)) return;
      const u = [...store.users.values()].find((x) => x.email === req.body.email);
      const { verifyPassword } = require('./db/store');
      if (!u || !verifyPassword(req.body.password || '', u.password_hash)) {
        store.auditLog(u?.user_id ?? null, 'APP_USER', u?.user_id ?? 0, 'LOGIN_FAIL', null, { email: req.body.email });
        return res.status(401).json({ error: { code: 'BAD_CREDENTIALS', message: 'invalid email/password' } });
      }
      if (u.status !== 'ACTIVE')
        return res.status(403).json({ error: { code: 'SUSPENDED', message: 'account suspended' } });
      store.auditLog(u.user_id, 'APP_USER', u.user_id, 'LOGIN_SUCCESS', null, { at: new Date().toISOString() });
      res.json({
        user: pub(u),
        accessToken: signAccess(u, store),
        refreshToken: issueRefresh(store, u, req.body.device),
      });
    })
  );
  r.post(
    '/auth/refresh',
    safe(async (req, res) => {
      const { consumeRefresh } = require('./middleware/auth');
      const c = consumeRefresh(store, req.body.refreshToken);
      if (!c.ok) {
        if (c.familyRevoked)
          store.auditLog(null, 'APP_USER', 0, 'REFRESH_REUSE', null, { at: new Date().toISOString() });
        return res.status(401).json({
          error: {
            code: 'BAD_REFRESH',
            message:
              c.reason === 'revoked-reuse' ? 'refresh reuse detected — family revoked' : 'refresh invalid/expired',
          },
        });
      }
      const t = c.token;
      t.revoked_at = new Date().toISOString(); // rotation
      const u = store.users.get(t.user_id);
      res.json({
        accessToken: signAccess(u, store),
        refreshToken: issueRefresh(store, u, t.device_label, t.family_id),
      });
    })
  );
  r.get(
    '/me',
    authRequired,
    safe(async (req, res) => {
      const u = store.users.get(req.user.id);
      res.json({ user: pub(u), wallet: store.wallets.get(u.user_id) || null });
    })
  );
  r.post(
    '/me/wallet/topup',
    authRequired,
    safe(async (req, res) => {
      res.json({ wallet: store.topup(req.user.id, Number(req.body.amount)) });
    })
  );
  // vehicles
  r.get(
    '/me/vehicles',
    authRequired,
    safe(async (req, res) => {
      res.json({ vehicles: [...store.vehicles.values()].filter((v) => v.user_id === req.user.id) });
    })
  );
  r.post(
    '/me/vehicles',
    authRequired,
    safe(async (req, res) => {
      vVehicle(req.body);
      res.status(201).json({ vehicle: store.createVehicle(req.user.id, req.body) });
    })
  );

  // ---- stations / discovery ----
  r.get(
    '/stations',
    safe(async (req, res) => {
      const { q, std, minKw, lat, lng, radius, page = 1 } = req.query;
      let list = [...store.stations.values()].filter((s) => s.status === 'ACTIVE');
      if (q)
        list = list.filter((s) => (s.name + s.city + s.address_line).toLowerCase().includes(String(q).toLowerCase()));
      let rows = list.map((s) => {
        const cps = [...store.cps.values()].filter((c) => c.station_id === s.station_id);
        const conns = cps.flatMap((c) =>
          [...store.connectors.values()]
            .filter((x) => x.cp_id === c.cp_id)
            .map((x) => ({
              ...x,
              ocpp_identity: c.ocpp_identity,
              connector_ref: `${x.cp_id}:${x.connector_no}`,
              standard_code: store.standards.find((t) => t.standard_id === x.standard_id)?.code,
            }))
        );
        return {
          ...s,
          connectors: conns,
          available_count: conns.filter((c) => c.status === 'AVAILABLE').length,
          connector_count: conns.length,
        };
      });
      if (std)
        rows = rows
          .map((s) => ({ ...s, connectors: s.connectors.filter((c) => c.standard_code === std) }))
          .filter((s) => s.connectors.length);
      if (minKw)
        rows = rows
          .map((s) => ({ ...s, connectors: s.connectors.filter((c) => c.max_power_kw >= Number(minKw)) }))
          .filter((s) => s.connectors.length);
      if (lat && lng) {
        // haversine sort (km)
        const R = 6371,
          la = (Number(lat) * Math.PI) / 180,
          ln = (Number(lng) * Math.PI) / 180;
        rows.forEach((s) => {
          const dLa = (s.latitude * Math.PI) / 180 - la,
            dLn = (s.longitude * Math.PI) / 180 - ln;
          const a =
            Math.sin(dLa / 2) ** 2 + Math.cos(la) * Math.cos((s.latitude * Math.PI) / 180) * Math.sin(dLn / 2) ** 2;
          s.distance_km = +(2 * R * Math.asin(Math.sqrt(a))).toFixed(2);
        });
        if (radius) rows = rows.filter((s) => s.distance_km <= Number(radius));
        rows.sort((a, b) => a.distance_km - b.distance_km);
      }
      const per = 20,
        p = Math.max(1, Number(page));
      res.json({ stations: rows.slice((p - 1) * per, p * per), page: p, total: rows.length });
    })
  );
  r.get(
    '/stations/:id',
    safe(async (req, res) => {
      const s = store.stations.get(Number(req.params.id));
      if (!s) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'station' } });
      const cps = [...store.cps.values()]
        .filter((c) => c.station_id === s.station_id)
        .map((c) => ({
          ...c,
          connectors: [...store.connectors.values()]
            .filter((x) => x.cp_id === c.cp_id)
            .map((x) => ({
              ...x,
              connector_ref: `${x.cp_id}:${x.connector_no}`,
              standard_code: store.standards.find((t) => t.standard_id === x.standard_id)?.code,
            })),
        }));
      // per-station rating: reviews whose session ran on this station's connectors
      const stationCpIds = new Set(cps.map((c) => String(c.cp_id)));
      const stationRevs = [...store.reviews.values()].filter((r) => {
        const sess = store.sessions.get(r.session_id);
        return sess && stationCpIds.has(sess.connector_ref.split(':')[0]);
      });
      res.json({
        station: {
          ...s,
          charge_points: cps,
          amenities: store.amenities.filter((a) => a.station_id === s.station_id).map((a) => a.amenity),
          avg_rating: stationRevs.length
            ? +(stationRevs.reduce((a, x) => a + x.rating, 0) / stationRevs.length).toFixed(2)
            : null,
          review_count: stationRevs.length,
        },
      });
    })
  );
  r.get(
    '/stations/:id/connectors/live',
    safe(async (req, res) => {
      const sid = Number(req.params.id);
      const rows = [...store.connectors.values()]
        .filter((c) => store.cps.get(c.cp_id)?.station_id === sid)
        .map((c) => ({
          connector_ref: `${c.cp_id}:${c.connector_no}`,
          ...c,
          standard_code: store.standards.find((t) => t.standard_id === c.standard_id)?.code,
          ocpp_identity: store.cps.get(c.cp_id)?.ocpp_identity,
        }));
      res.json({ connectors: rows });
    })
  );

  // ---- reservations ----
  r.post(
    '/reservations',
    authRequired,
    safe(async (req, res) => {
      // Idempotency-Key replay (R5) — B2G-014: durable under STORE=oracle (table + Map).
      const ik = req.headers['idempotency-key'];
      const idemKey = ik ? `${req.user.id}:${ik}` : null;
      if (idemKey) {
        const hit = store.idem.get(idemKey);
        if (hit) return res.status(hit.status_code).json(JSON.parse(hit.response_body));
        // B2G-014: Oracle durable path — survives restart / multi-instance.
        if (store._pool) {
          try {
            const c = await store._pool.getConnection();
            try {
              const r2 = await c.execute(
                'SELECT status_code, response_body FROM idempotency_key WHERE key_value = :k',
                { k: idemKey },
                { outFormat: c.oracleDb?.OUT_FORMAT_OBJECT }
              );
              // oracledb thin: rows as arrays unless OUT_FORMAT_OBJECT; handle both.
              const row = r2.rows?.[0];
              if (row) {
                const sc = row.STATUS_CODE ?? row[0],
                  body = row.RESPONSE_BODY ?? row[1];
                const bodyStr =
                  typeof body === 'string' ? body : body?.getData ? await body.getData() : JSON.stringify(body);
                store.idem.set(idemKey, { status_code: Number(sc), response_body: bodyStr });
                return res.status(Number(sc)).json(JSON.parse(bodyStr));
              }
            } finally {
              try {
                await c.close();
              } catch {}
            }
          } catch {
            /* fall through to normal path */
          }
        }
      }
      vReservation(req.body);
      try {
        const reservation = await store.createReservation(
          req.user.id,
          req.body.vehicleId,
          req.body.cpId,
          req.body.connectorNo,
          req.body.startAt,
          req.body.endAt
        );
        const body = JSON.stringify({ reservation });
        if (idemKey) {
          store.idem.set(idemKey, { status_code: 201, response_body: body });
          // B2G-014: persist durable row (expires 24h); prune opportunistically.
          if (store._pool) {
            try {
              const c = await store._pool.getConnection();
              try {
                await c.execute(
                  `INSERT INTO idempotency_key (key_value, user_id, method, path, status_code, response_body, expires_at)
                VALUES (:k, :u, 'POST', '/reservations', 201, :b, SYSTIMESTAMP + INTERVAL '1' DAY)`,
                  { k: idemKey, u: req.user.id, b: body }
                );
                await c.commit();
                await c.execute(`DELETE FROM idempotency_key WHERE expires_at < SYSTIMESTAMP`).catch(() => {});
                await c.commit().catch(() => {});
              } finally {
                try {
                  await c.close();
                } catch {}
              }
            } catch {
              /* Map remains the fast path */
            }
          }
        }
        res.status(201).json({ reservation });
      } catch (e) {
        res
          .status(oraStatus(e))
          .json({ error: { code: e.code || 'RESERVE_FAILED', message: e.message, ora: e.num || null } });
      }
    })
  );
  r.get(
    '/reservations',
    authRequired,
    safe(async (req, res) => {
      let list = [...store.reservations.values()];
      if (req.user.role === 'DRIVER') list = list.filter((x) => x.user_id === req.user.id);
      if (req.query.status) list = list.filter((x) => x.status === req.query.status);
      list.sort((a, b) => b.reservation_id - a.reservation_id);
      res.json({ reservations: list });
    })
  );
  r.post(
    '/reservations/:id/cancel',
    authRequired,
    safe(async (req, res) => {
      try {
        res.json({ reservation: await store.cancelReservation(req.params.id, req.user.id, req.user.role) });
      } catch (e) {
        res.status(oraStatus(e)).json({ error: { code: e.code, message: e.message } });
      }
    })
  );

  // ---- sessions ----
  r.post(
    '/sessions/start',
    authRequired,
    safe(async (req, res) => {
      try {
        const planId = req.body.planId ? Number(req.body.planId) : store.defaultPlanId ? store.defaultPlanId() : 2;
        const s = await store.startSession({
          uid: req.user.id,
          vehicleId: req.body.vehicleId,
          cpId: req.body.cpId,
          connNo: req.body.connectorNo,
          planId,
          reservationId: req.body.reservationId,
          idTag: req.body.idTag || `TAG-${req.user.id}`,
        });
        res.status(201).json({ session: s });
      } catch (e) {
        res.status(oraStatus(e)).json({ error: { code: e.code, message: e.message } });
      }
    })
  );
  // SEC-001: per-connector active session exposes user_id/id_tag — auth required.
  r.get(
    '/sessions/active/:ref',
    authRequired,
    safe(async (req, res) => {
      const s = [...store.sessions.values()].find(
        (x) => x.connector_ref === req.params.ref && ['PREPARING', 'CHARGING', 'SUSPENDED'].includes(x.state)
      );
      res.json({ session: s || null });
    })
  );
  // SEC-001: live session exposes energy profile + user_id — driver-own or staff only.
  r.get(
    '/sessions/:id/live',
    authRequired,
    safe(async (req, res) => {
      const s = store.sessions.get(Number(req.params.id));
      if (!s) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'session' } });
      if (req.user.role === 'DRIVER' && s.user_id !== req.user.id)
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'not your session' } });
      const ticks = store.readings.filter((x) => x.session_id === s.session_id);
      // BUG-016 fix: energy from session's stored start_meter_kwh (real chargers report absolute registers).
      const energy = ticks.length ? +(ticks[ticks.length - 1].meter_kwh - (s.start_meter_kwh ?? 0)).toFixed(3) : 0;
      const kw = ticks.length ? ticks[ticks.length - 1].power_kw : null;
      let price = 20,
        fee = 0;
      try {
        price = store.resolveBandPrice(s.tariff_plan_id, s.started_at);
      } catch {
        /* keep */
      }
      try {
        fee = Number(store.plans.get(Number(s.tariff_plan_id))?.session_fee || 0);
      } catch {
        /* keep */
      }
      const elapsed_s = Math.floor((new Date(s.ended_at || Date.now()) - new Date(s.started_at)) / 1000);
      res.json({
        session: s,
        live: {
          energy_kwh: energy,
          power_kw: kw,
          elapsed_s,
          est_cost: +(energy * price + fee).toFixed(2),
          ticks: ticks.slice(-60),
        },
      });
    })
  );
  r.post(
    '/sessions/:id/remote-stop',
    authRequired,
    requireOwned(store, 'session'),
    safe(async (req, res) => {
      try {
        const sess = await store.stopSession(req.params.id, 'REMOTE_STOP');
        // B2G-009: fire RemoteStopTransaction to the charger (fire-and-forget; failures logged).
        try {
          const { stopTransaction } = require('./ocpp/gateway');
          const registry = global.__ocppRegistry;
          if (registry && stopTransaction) {
            const cpId = Number(String(sess.connector_ref).split(':')[0]);
            const cp = store.cps.get(cpId);
            if (cp?.ocpp_identity)
              stopTransaction(registry, cp.ocpp_identity, sess.session_id, req.log || console).catch(() => {});
          }
        } catch {
          /* gateway not mounted in tests */
        }
        res.json({ session: sess });
      } catch (e) {
        res.status(oraStatus(e)).json({ error: { code: e.code, message: e.message } });
      }
    })
  );
  // B3G-001: operator RemoteStart — same plumbing as RemoteStop, allow-list gated.
  // Body: { cpId, connectorNo, idTag }. Fires RemoteStartTransaction to the CP.
  r.post(
    '/sessions/remote-start',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const cpId = Number(req.body.cpId);
      const connectorNo = Number(req.body.connectorNo);
      const idTag = String(req.body.idTag || '');
      const cp = store.cps.get(cpId);
      if (!cp) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'charge point' } });
      const m = /^TAG-(\d+)$/.exec(idTag);
      if (!m || !store.users.has(Number(m[1])))
        return res.status(422).json({ error: { code: 'INVALID_IDTAG', message: 'allow-list only' } });
      try {
        const { startTransaction } = require('./ocpp/gateway');
        const registry = global.__ocppRegistry;
        const out = await startTransaction(registry, cp.ocpp_identity, idTag, connectorNo, req.log || console);
        res.status(202).json({ accepted: true, ...out });
      } catch (e) {
        res.status(e.status || 409).json({ error: { code: e.code || 'CP_OFFLINE', message: e.message } });
      }
    })
  );
  r.get(
    '/sessions',
    authRequired,
    safe(async (req, res) => {
      // keyset pagination (started_at, session_id) — OFFSET banned except admin<=1k
      let list = [...store.sessions.values()];
      if (req.user.role === 'DRIVER' || req.query.userId) {
        const uid = req.query.userId ? Number(req.query.userId) : req.user.id;
        if (req.user.role === 'DRIVER' && uid !== req.user.id)
          return res.status(403).json({ error: { code: 'FORBIDDEN', message: '' } });
        list = list.filter((x) => x.user_id === uid);
      }
      list.sort((a, b) => b.started_at.localeCompare(a.started_at) || b.session_id - a.session_id);
      if (req.query.cursor) {
        try {
          const [cts, cid] = Buffer.from(String(req.query.cursor), 'base64').toString().split('|');
          list = list.filter((x) => x.started_at < cts || (x.started_at === cts && x.session_id < Number(cid)));
        } catch {
          /* ignore */
        }
      }
      const page = list.slice(0, 20);
      const last = page[page.length - 1];
      res.json({
        sessions: page,
        nextCursor: last ? Buffer.from(`${last.started_at}|${last.session_id}`).toString('base64') : null,
      });
    })
  );
  r.post(
    '/sessions/:id/bill',
    authRequired,
    requireOwned(store, 'session'),
    safe(async (req, res) => {
      try {
        res.status(201).json({ invoice: await store.billSession(req.params.id) });
      } catch (e) {
        res.status(oraStatus(e)).json({ error: { code: e.code, message: e.message } });
      }
    })
  );

  // ---- billing ----
  r.get(
    '/invoices',
    authRequired,
    safe(async (req, res) => {
      let list = [...store.invoices.values()];
      if (req.user.role === 'DRIVER') {
        const mine = new Set(
          [...store.sessions.values()].filter((s) => s.user_id === req.user.id).map((s) => s.session_id)
        );
        list = list.filter((i) => mine.has(i.session_id));
      }
      if (req.query.status) list = list.filter((i) => i.status === req.query.status);
      list.sort((a, b) => b.invoice_id - a.invoice_id);
      res.json({ invoices: list });
    })
  );
  r.get(
    '/invoices/:id',
    authRequired,
    requireOwned(store, 'invoice'),
    safe(async (req, res) => {
      const i = store.invoices.get(Number(req.params.id));
      if (!i) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'invoice' } });
      res.json({
        invoice: i,
        lines: store.lines.filter((l) => l.invoice_id === i.invoice_id),
        payments: [...store.payments.values()].filter((p) => p.invoice_id === i.invoice_id),
      });
    })
  );
  r.post(
    '/invoices/:id/pay',
    authRequired,
    safe(async (req, res) => {
      try {
        res.status(201).json({ payment: await store.payInvoice(req.params.id, req.user.id) });
      } catch (e) {
        res.status(oraStatus(e)).json({ error: { code: e.code || 'PAY_FAILED', message: e.message } });
      }
    })
  );

  // ---- faults / maintenance ----
  // B2G-003b: manual fault reports are staff-only; driver-originated reports must not
  // flip connector state without an operator ack (abuse vector otherwise).
  r.post(
    '/stations/:id/faults',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      // Validate connector_ref belongs to this station when provided.
      if (req.body.connector_ref) {
        const cpId = Number(String(req.body.connector_ref).split(':')[0]);
        const cp = store.cps.get(cpId);
        if (!cp || cp.station_id !== Number(req.params.id))
          return res
            .status(422)
            .json({ error: { code: 'INVALID_CONNECTOR', message: 'connector_ref not in this station' } });
      }
      const fid = ++store.seq.fault;
      const f = {
        fault_id: fid,
        connector_ref: req.body.connector_ref || null,
        cp_id: req.body.cpId || null,
        error_code: req.body.error_code || 'ManualReport',
        severity: req.body.severity || 'WARN',
        source: 'MANUAL',
        description: req.body.description || null,
        reported_by: req.user.id,
        reported_at: new Date().toISOString(),
        cleared_at: null,
      };
      store.faults.set(fid, f);
      // B2G-003b: operator-originated reports create the fault row only; the connector flips
      // only via maintenance_pkg.report_fault in Oracle or an explicit operator state transition.
      store.auditLog(req.user.id, 'FAULT', fid, 'REPORT', null, f.error_code);
      res.status(201).json({ fault: f });
    })
  );
  r.get(
    '/faults',
    authRequired,
    safe(async (req, res) => {
      let list = [...store.faults.values()].sort((a, b) => b.fault_id - a.fault_id);
      if (req.query.open === '1') list = list.filter((f) => !f.cleared_at);
      if (req.query.station) {
        const sid = String(req.query.station);
        list = list.filter((f) => {
          if (f.connector_ref) return String(store.cps.get(Number(f.connector_ref.split(':')[0]))?.station_id) === sid;
          if (f.cp_id) return String(store.cps.get(Number(f.cp_id))?.station_id) === sid;
          return false;
        });
      }
      res.json({ faults: list });
    })
  );
  r.post(
    '/faults/:id/maintenance',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const rid = ++store.seq.maint;
      const m = {
        record_id: rid,
        fault_id: Number(req.params.id),
        performed_by: req.user.id,
        work_type: req.body.work_type || 'INSPECT',
        description: req.body.description || '',
        cost: Number(req.body.cost || 0),
        started_at: new Date().toISOString(),
        resolved_at: null,
        resolution: null,
      };
      store.maint.set(rid, m);
      res.status(201).json({ record: m });
    })
  );
  r.patch(
    '/maintenance/:id/complete',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const m = store.maint.get(Number(req.params.id));
      if (!m) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'record' } });
      m.resolved_at = new Date().toISOString();
      m.resolution = req.body.resolution || 'resolved';
      const f = store.faults.get(m.fault_id);
      if (f) {
        f.cleared_at = new Date().toISOString();
        if (f.connector_ref && store.connectors.get(f.connector_ref)?.status === 'FAULTED')
          store.connectors.get(f.connector_ref).status = 'AVAILABLE';
      }
      store.auditLog(req.user.id, 'MAINTENANCE_RECORD', m.record_id, 'RESOLVE', null, m.resolution);
      res.json({ record: m });
    })
  );

  // ---- analytics (operator) ----
  // B2G-003a: station revenue is sensitive business data — staff only (OWASP API5 BFLA).
  r.get(
    '/stations/:id/analytics',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const sid = Number(req.params.id);
      const keys = new Set([...store.cps.values()].filter((c) => c.station_id === sid).map((c) => String(c.cp_id)));
      const sess = [...store.sessions.values()].filter(
        (s) => keys.has(s.connector_ref.split(':')[0]) && s.state === 'COMPLETED'
      );
      const invs = sess
        .map((s) => [...store.invoices.values()].find((i) => i.session_id === s.session_id))
        .filter(Boolean);
      res.json({
        revenue: +invs
          .filter((i) => ['PAID', 'DUE'].includes(i.status))
          .reduce((a, i) => a + i.total, 0)
          .toFixed(2),
        energy_kwh: +sess.reduce((a, s) => a + (s.energy_kwh || 0), 0).toFixed(3),
        sessions: sess.length,
        active: [...store.sessions.values()].filter(
          (s) => keys.has(s.connector_ref.split(':')[0]) && ['PREPARING', 'CHARGING', 'SUSPENDED'].includes(s.state)
        ).length,
        open_faults: [...store.faults.values()].filter(
          (f) => !f.cleared_at && f.connector_ref && keys.has(f.connector_ref.split(':')[0])
        ).length,
      });
    })
  );

  // ---- telemetry (DA3 reads; prod hits TimescaleDB caggs) ----
  // SEC-001: station-aggregate telemetry is auth-gated (prevents longitudinal presence mining).
  r.get(
    '/telemetry/load-curve',
    authRequired,
    safe(async (req, res) => {
      const { station, from, to, bucket = '5m' } = req.query;
      let ticks = store.ticks;
      if (station) {
        const keys = new Set(
          [...store.cps.values()].filter((c) => c.station_id === Number(station)).map((c) => String(c.cp_id))
        );
        ticks = ticks.filter((t) => keys.has(t.connector_ref.split(':')[0]));
      }
      if (from) ticks = ticks.filter((t) => t.ts >= new Date(from).toISOString());
      if (to) ticks = ticks.filter((t) => t.ts <= new Date(to).toISOString());
      const mins = bucket === '1h' ? 60 : bucket === '1m' ? 1 : 5;
      const buckets = new Map();
      ticks.forEach((t) => {
        const b = new Date(Math.floor(new Date(t.ts).getTime() / (mins * 60000)) * mins * 60000).toISOString();
        if (!buckets.has(b)) buckets.set(b, { bucket: b, sum: 0, max: 0, n: 0 });
        const o = buckets.get(b);
        o.sum += t.power_kw || 0;
        o.max = Math.max(o.max, t.power_kw || 0);
        o.n++;
      });
      res.json({
        points: [...buckets.values()]
          .map((o) => ({
            bucket: o.bucket,
            avg_kw: +(o.sum / Math.max(o.n, 1)).toFixed(2),
            peak_kw: +o.max.toFixed(2),
          }))
          .sort((a, b) => a.bucket.localeCompare(b.bucket)),
        source: process.env.TS_HOST ? 'timescaledb' : 'local-rollup',
      });
    })
  );
  r.get(
    '/telemetry/utilization-heatmap',
    authRequired,
    safe(async (req, res) => {
      // 7x24 matrix from stateEvents (prod: state_1m cagg)
      const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
      store.stateEvents.forEach((e) => {
        const d = new Date(e.ts);
        grid[d.getDay()][d.getHours()] += e.to_state === 'OCCUPIED' ? 1 : 0;
      });
      res.json({ heatmap: grid });
    })
  );

  // ---- reviews ----
  r.post(
    '/sessions/:id/review',
    authRequired,
    safe(async (req, res) => {
      const sid = Number(req.params.id);
      if ([...store.reviews.values()].some((x) => x.session_id === sid))
        return res.status(409).json({ error: { code: 'DUPLICATE_REVIEW', message: 'one review per session' } });
      const rid = ++store.seq.review;
      const rev = {
        review_id: rid,
        session_id: sid,
        user_id: req.user.id,
        rating: Number(req.body.rating),
        comment_text: req.body.comment || null,
        created_at: new Date().toISOString(),
      };
      if (!(rev.rating >= 1 && rev.rating <= 5))
        return res.status(422).json({ error: { code: 'INVALID_RATING', message: '1..5' } });
      store.reviews.set(rid, rev);
      res.status(201).json({ review: rev });
    })
  );

  // ---- admin ----
  r.get(
    '/admin/audit-logs',
    authRequired,
    roles('ADMIN'),
    safe(async (req, res) => {
      res.json({ logs: store.audit.slice(-200).reverse() });
    })
  );
  r.post(
    '/admin/users',
    authRequired,
    roles('ADMIN'),
    safe(async (req, res) => {
      const u = store.createUser({
        email: req.body.email,
        password: req.body.password || 'Temp@1234',
        full_name: req.body.full_name,
        role: req.body.role || 'OPERATOR',
      });
      if (req.body.stationId) {
        const s = store.stations.get(Number(req.body.stationId));
        if (s) s.operator_id = u.user_id;
      }
      res.status(201).json({ user: pub(u) });
    })
  );
  r.patch(
    '/admin/users/:id',
    authRequired,
    roles('ADMIN'),
    safe(async (req, res) => {
      const u = store.users.get(Number(req.params.id));
      if (!u) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'user' } });
      if (req.body.status) u.status = req.body.status;
      if (req.body.stationId) {
        const s = store.stations.get(Number(req.body.stationId));
        if (s) s.operator_id = u.user_id;
      }
      store.auditLog(req.user.id, 'APP_USER', u.user_id, 'UPDATE', null, { status: u.status });
      res.json({ user: pub(u) });
    })
  );
  r.post(
    '/admin/tariff-plans',
    authRequired,
    roles('ADMIN'),
    scopeCheck,
    safe(async (req, res) => {
      // immutable-version rule: new version, never edit active
      const group = Number(req.body.group_id || 1);
      const vers = [...store.plans.values()].filter((p) => p.group_id === group);
      const max = vers.reduce((m, p) => Math.max(m, p.version_no), 0);
      const prev = vers.find((p) => p.version_no === max);
      const plan_id = ++store.seq.plan;
      const plan = {
        plan_id,
        group_id: group,
        version_no: max + 1,
        name: req.body.name || `Plan v${max + 1}`,
        currency: 'INR',
        session_fee: Number(req.body.session_fee || 0),
        idle_fee_per_30min: 0,
        active_from: new Date().toISOString(),
        active_to: null,
        supersedes_plan_id: prev?.plan_id || null,
        created_by: req.user.id,
        created_at: new Date().toISOString(),
      };
      store.plans.set(plan_id, plan);
      if (prev) prev.active_to = plan.active_from;
      (req.body.bands || [{ day_scope: 'ALL', start_time: '00:00', end_time: '23:59', price_per_kwh: 22 }]).forEach(
        (b) => {
          store.bands.push({
            band_id: ++store.seq.band,
            plan_id,
            day_scope: b.day_scope,
            start_time: b.start_time,
            end_time: b.end_time,
            price_per_kwh: Number(b.price_per_kwh),
          });
        }
      );
      store.auditLog(req.user.id, 'TARIFF_PLAN', plan_id, 'VERSION', prev?.plan_id ?? null, plan.name);
      res.status(201).json({ plan });
    })
  );
  r.get(
    '/admin/tariff-plans',
    authRequired,
    roles('ADMIN', 'OPERATOR'),
    safe(async (req, res) => {
      res.json({ plans: [...store.plans.values()], bands: store.bands });
    })
  );

  // ---- internal (worker) ----
  // SEC-007: constant-time compare; fail-closed only in production (demo compose uses
  // the documented dev default pair, which logs a warning — see middleware/auth.js).
  function internalOk(req) {
    const want = process.env.INTERNAL_TOKEN;
    const prod = process.env.NODE_ENV === 'production';
    if (!want || want === 'dev-internal') {
      if (prod) return false;
      return (req.headers['x-internal'] || '') === 'dev-internal';
    }
    const got = Buffer.from(String(req.headers['x-internal'] || ''));
    const exp = Buffer.from(String(want));
    if (got.length !== exp.length) return false;
    try {
      return crypto.timingSafeEqual(got, exp);
    } catch {
      return false;
    }
  }
  const requireInternal = (req, res, next) => {
    if (!internalOk(req)) return res.status(403).json({ error: { code: 'FORBIDDEN', message: '' } });
    next();
  };
  r.get(
    '/internal/outbox',
    requireInternal,
    safe(async (req, res) => {
      res.json({ events: store.outbox.filter((e) => !e.processed_at).slice(0, 500) });
    })
  );
  r.post(
    '/internal/outbox/ack',
    requireInternal,
    safe(async (req, res) => {
      const ids = (req.body.ids || []).map(Number);
      ids.forEach((id) => {
        const e = store.outbox.find((x) => x.event_id === Number(id));
        if (e) e.processed_at = new Date().toISOString();
      });
      // B2G-005: also mark Oracle outbox_event processed (else that table grows unbounded).
      if (store._pool && ids.length) {
        const c = await store._pool.getConnection();
        try {
          await c.execute(
            `UPDATE outbox_event SET processed_at = SYSTIMESTAMP WHERE event_id IN (${ids.map((_, i) => `:id${i}`).join(',')})`,
            Object.fromEntries(ids.map((v, i) => [`id${i}`, v]))
          );
          await c.commit();
        } finally {
          try {
            await c.close();
          } catch {}
        }
      }
      res.json({ ok: true });
    })
  );
  r.post(
    '/internal/expire',
    requireInternal,
    safe(async (req, res) => {
      res.json({ expired: await store.expireStale() });
    })
  );

  // ---- health ----
  r.get(
    '/health',
    safe(async (req, res) => {
      const lag = store.outbox.filter((e) => !e.processed_at).length;
      res.json({
        status: 'ok',
        mode: store._mode || 'local',
        oracle: store._pool ? 'connected' : process.env.ORACLE_HOST ? store._mode || 'connecting' : 'local-store',
        timescale: process.env.TS_HOST ? 'configured' : 'local-rollup',
        outbox_lag: lag,
        now: new Date().toISOString(),
      });
    })
  );
  // /health/deep: real SELECT 1 FROM DUAL + pool presence + Timescale reachability when wired.
  r.get(
    '/health/deep',
    safe(async (req, res) => {
      const out = { status: 'ok', mode: store._mode || 'local', checks: {}, now: new Date().toISOString() };
      if (store._pool) {
        try {
          const c = await store._pool.getConnection();
          try {
            await c.execute('SELECT 1 FROM DUAL');
            out.checks.oracle = 'connected';
          } finally {
            try {
              await c.close();
            } catch {}
          }
        } catch (e) {
          out.status = 'degraded';
          out.checks.oracle = `error: ${e.message.slice(0, 120)}`;
        }
      } else {
        out.checks.oracle = process.env.ORACLE_HOST
          ? store._oracleError
            ? `unreachable: ${String(store._oracleError).slice(0, 120)}`
            : store._mode || 'connecting'
          : 'local-store';
      }
      out.checks.timescale = process.env.TS_HOST ? 'configured (see worker relay-timescale)' : 'local-rollup';
      out.checks.outbox_lag = store.outbox.filter((e) => !e.processed_at).length;
      res.status(out.status === 'ok' ? 200 : 503).json(out);
    })
  );
  // /metrics: Prometheus text (see observability.js) — Grafana scrapes this, no exporter zoo.
  r.get(
    '/metrics',
    safe(async (req, res) => {
      res.setHeader('content-type', 'text/plain; version=0.0.4');
      res.send(require('./observability').render(store));
    })
  );

  function pub(u) {
    const { password_hash: _password_hash, ...rest } = u;
    return rest;
  }
  return r;
};
