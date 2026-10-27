// Extended modules: tariffs-public, reviews-read, notifications, vehicle-default,
// operator session control, admin station hardware CRUD. Mounted at /api/v1.
'use strict';
const express = require('express');
const spec = require('./docs');
const { authRequired, roles } = require('./middleware/auth');
const { routerBarrier } = require('./middleware/security');
const { oraStatus } = require('./errors');

module.exports = function extended(store) {
  const r = express.Router();
  const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  // Router-wide barrier (CodeQL hardening — the admin and AI routes here all authorize).
  // Every request that reaches this router has already passed the whole-API envelope in
  // routes.js, so this bucket counts the same traffic a second time: it is belt-and-
  // braces for the case where that barrier is reordered or dropped, and it keeps a
  // recognized limiter on these authorizing routes for static analysis. It is NOT a
  // separate budget for traffic — see middleware/security.js routerBarrier().
  r.use(routerBarrier({ key: 'ext', limit: 120 }));

  r.get('/docs', (req, res) => res.json(spec));

  /* ---------------- ADR-0016: signed wallet rail ----------------
   * GET  /me/wallet              — balance, active links, recent intents, ledger tail
   * POST /me/wallet/challenge    — single-use EIP-4361 challenge for one address
   * POST /me/wallet/link         — link the address whose signature verifies
   * DEL  /me/wallet/link/:addr   — revoke (append-only: Oracle stamps revoked_at)
   * POST /me/wallet/intent       — amount-bearing authorisation to sign
   * POST /me/wallet/settle       — verify signature, then credit the ledger once
   *
   * Every response that carries a signature-verified fact names the mechanism, so a
   * client cannot mistake this rail for an on-chain transfer.
   */
  const fail = (res, e) =>
    res.status(e.status || oraStatus(e) || 500).json({
      error: { code: e.code || 'WALLET_ERROR', message: e.message },
    });
  // The challenge binds the origin the driver is actually on (EIP-4361 URI field), so a
  // signature harvested from a phishing origin is visibly a different message.
  const originOf = (req) => {
    const o = req.get('origin') || (process.env.WEB_ORIGIN || 'http://localhost:3000').split(',')[0];
    try {
      return new URL(o).origin;
    } catch {
      return 'http://localhost:3000';
    }
  };

  r.get(
    '/me/wallet',
    authRequired,
    safe(async (req, res) => {
      const out = store.walletOverview(req.user.id);
      res.json({
        ...out,
        rail: {
          chain_id: require('./wallet/rail').CHAIN_ID,
          chain_name: require('./wallet/rail').CHAIN_NAME,
          inr_per_eth: require('./wallet/rail').INR_PER_ETH,
          max_topup_inr: require('./wallet/rail').MAX_TOPUP_INR,
          standard: 'EIP-191 personal_sign · EIP-4361 challenge',
        },
      });
    })
  );

  r.post(
    '/me/wallet/challenge',
    authRequired,
    safe(async (req, res) => {
      try {
        const uri = originOf(req);
        res.status(201).json(
          store.walletChallenge(req.user.id, {
            address: req.body?.address,
            domain: new URL(uri).host,
            uri,
          })
        );
      } catch (e) {
        fail(res, e);
      }
    })
  );

  r.post(
    '/me/wallet/link',
    authRequired,
    safe(async (req, res) => {
      try {
        const { address, signature, nonce, label } = req.body || {};
        res.status(201).json({ link: await store.linkWallet(req.user.id, { address, signature, nonce, label }) });
      } catch (e) {
        fail(res, e);
      }
    })
  );

  r.delete(
    '/me/wallet/link/:address',
    authRequired,
    safe(async (req, res) => {
      try {
        res.json(await store.unlinkWallet(req.user.id, req.params.address));
      } catch (e) {
        fail(res, e);
      }
    })
  );

  r.post(
    '/me/wallet/intent',
    authRequired,
    safe(async (req, res) => {
      try {
        res.status(201).json({ intent: store.createTopupIntent(req.user.id, { amount: req.body?.amount }) });
      } catch (e) {
        fail(res, e);
      }
    })
  );

  r.post(
    '/me/wallet/settle',
    authRequired,
    safe(async (req, res) => {
      try {
        const { intent_id, signature } = req.body || {};
        res.status(201).json(await store.settleTopup(req.user.id, { intent_id, signature }));
      } catch (e) {
        fail(res, e);
      }
    })
  );

  // public current-tariff preview (drivers see prices before reserving)
  r.get(
    '/tariffs/active',
    safe(async (req, res) => {
      const byGroup = new Map();
      for (const p of store.plans.values()) {
        if (!byGroup.has(p.group_id) || byGroup.get(p.group_id).version_no < p.version_no) byGroup.set(p.group_id, p);
      }
      res.json({
        plans: [...byGroup.values()].map((p) => ({
          ...p,
          bands: store.bands.filter((b) => b.plan_id === p.plan_id),
        })),
      });
    })
  );

  // station reviews (read side of REV-01)
  r.get(
    '/stations/:id/reviews',
    safe(async (req, res) => {
      const sid = String(req.params.id);
      const cpIds = new Set(
        [...store.cps.values()].filter((c) => String(c.station_id) === sid).map((c) => String(c.cp_id))
      );
      const out = [...store.reviews.values()]
        .filter((r) => {
          const s = store.sessions.get(r.session_id);
          return s && cpIds.has(s.connector_ref.split(':')[0]);
        })
        .sort((a, b) => b.review_id - a.review_id)
        .slice(0, 50)
        // BUG-018 fix: never render "undefined" — single-token / missing names degrade gracefully.
        .map((x) => {
          const full = (store.users.get(x.user_id)?.full_name || '').trim().split(/\s+/).filter(Boolean);
          const driver = full.length >= 2 ? `${full[0]} ${full[1][0]}.` : full[0] || 'Driver';
          return { ...x, driver };
        });
      res.json({ reviews: out });
    })
  );

  // active sessions per station (O1 active table) — SEC-001: auth required (per-driver presence data).
  // BUG-037: honor the documented contract — drivers see only their OWN active
  // sessions here, operators only their assigned stations (ADMIN all). The old
  // handler returned every session with user_id/id_tag to any authenticated caller.
  r.get(
    '/stations/:id/sessions/active',
    authRequired,
    safe(async (req, res) => {
      const sid = String(req.params.id);
      const cpIds = new Set(
        [...store.cps.values()].filter((c) => String(c.station_id) === sid).map((c) => String(c.cp_id))
      );
      let list = [...store.sessions.values()].filter(
        (s) => cpIds.has(s.connector_ref.split(':')[0]) && ['PREPARING', 'CHARGING', 'SUSPENDED'].includes(s.state)
      );
      if (req.user.role === 'DRIVER') list = list.filter((s) => s.user_id === req.user.id);
      if (req.user.role === 'OPERATOR' && !(req.user.stationScope || []).includes(Number(sid)))
        return res.status(403).json({ error: { code: 'OUT_OF_SCOPE', message: 'station not assigned' } });
      res.json({ sessions: list });
    })
  );

  // operator state control: SUSPENDED <-> CHARGING (matrix-enforced, 409 otherwise)
  // Station scope: operators may only transition sessions on their assigned stations.
  // SEC-064: staff only. A DRIVER could previously move their own session to COMPLETED,
  // which freed the connector and allowed billing mid-charge (free energy). Drivers end
  // sessions through POST /sessions/:id/remote-stop, which is ownership-checked.
  r.patch(
    '/sessions/:id/state',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const s = store.sessions.get(Number(req.params.id));
      if (!s) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'session' } });
      if (req.user.role === 'DRIVER' && s.user_id !== req.user.id)
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'not your session' } });
      if (req.user.role === 'OPERATOR') {
        const cpId = Number(String(s.connector_ref).split(':')[0]);
        const stationId = store.cps.get(cpId)?.station_id;
        if (stationId && !(req.user.stationScope || []).includes(stationId))
          return res.status(403).json({ error: { code: 'OUT_OF_SCOPE', message: 'station not assigned' } });
      }
      try {
        res.json({ session: await store.transition(req.params.id, req.body.to, req.body.reason || 'OPERATOR') });
      } catch (e) {
        res.status(oraStatus(e)).json({ error: { code: e.code, message: e.message, ora: e.num || null } });
      }
    })
  );

  // vehicle default / rename (DRV-02)
  r.patch(
    '/me/vehicles/:id',
    authRequired,
    safe(async (req, res) => {
      const v = store.vehicles.get(Number(req.params.id));
      if (!v || v.user_id !== req.user.id)
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'vehicle' } });
      if (req.body.is_default)
        for (const x of store.vehicles.values()) if (x.user_id === req.user.id) x.is_default = 'N';
      Object.assign(v, {
        ...(req.body.nickname !== undefined ? { nickname: req.body.nickname } : {}),
        ...(req.body.is_default ? { is_default: 'Y' } : {}),
      });
      store.auditLog(req.user.id, 'VEHICLE', v.vehicle_id, 'UPDATE', null, { is_default: v.is_default });
      res.json({ vehicle: v });
    })
  );

  // notifications (NTF-01)
  r.get(
    '/me/notifications',
    authRequired,
    safe(async (req, res) => {
      const list = store.notifs
        .filter((n) => n.user_id === req.user.id)
        .sort((a, b) => b.notification_id - a.notification_id)
        .slice(0, 50);
      res.json({ notifications: list, unread: list.filter((n) => n.is_read === 'N').length });
    })
  );
  r.post(
    '/me/notifications/:id/read',
    authRequired,
    safe(async (req, res) => {
      const n = store.notifs.find((x) => x.notification_id === Number(req.params.id) && x.user_id === req.user.id);
      if (!n) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'notification' } });
      n.is_read = 'Y';
      res.json({ notification: n });
    })
  );

  // ---- admin hardware (A3) ----
  r.get(
    '/admin/stations',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      res.json({
        stations: [...store.stations.values()].map((s) => ({
          ...s,
          points: [...store.cps.values()].filter((c) => c.station_id === s.station_id).length,
          connectors: [...store.connectors.values()].filter((c) => store.cps.get(c.cp_id)?.station_id === s.station_id)
            .length,
        })),
      });
    })
  );
  r.post(
    '/admin/stations',
    authRequired,
    roles('ADMIN'),
    safe(async (req, res) => {
      try {
        // Await is REQUIRED: the Oracle mirror makes provisionStation promise-shaped
        // (BUG-047 — the same BUG-041 class; an un-awaited call publishes a promise).
        const { station, provisioned } = await store.provisionStation(req.user.id, req.body);
        // Return secrets once at provision time (operator configures the physical charger).
        res.status(201).json({ station, provisioned });
      } catch (e) {
        res.status(e.status || 500).json({ error: { code: e.code || 'PROVISION_FAILED', message: e.message } });
      }
    })
  );
  r.patch(
    '/admin/stations/:id',
    authRequired,
    roles('ADMIN'),
    safe(async (req, res) => {
      if (!store.stations.get(Number(req.params.id)))
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'station' } });
      // BUG-034: mirror Oracle's station.status CHECK (ACTIVE/INACTIVE) — the web
      // console flips ACTIVE<->INACTIVE, so an arbitrary string must not be writable
      // (the local store would otherwise accept values the schema rejects).
      if (req.body.status && !['ACTIVE', 'INACTIVE'].includes(req.body.status))
        return res
          .status(422)
          .json({ error: { code: 'INVALID_STATUS', message: 'station status must be ACTIVE or INACTIVE' } });
      // BUG-047: station metadata updates go through the store method so the Oracle
      // adapter mirrors them (PATCH on a provisioned/seed station must be durable).
      // Await required — the mirror wrapper is promise-shaped (BUG-041 class).
      const { station: s } = await store.updateStation(Number(req.params.id), {
        status: req.body.status,
        operator_id: req.body.operator_id,
        name: req.body.name,
      });
      store.auditLog(req.user.id, 'STATION', s.station_id, 'UPDATE', null, { status: s.status });
      res.json({ station: s });
    })
  );
  r.get(
    '/admin/charge-points',
    authRequired,
    roles('ADMIN'),
    safe(async (req, res) => {
      // Inventory for the day-2 command console. Never returns auth_secret:
      // credentials are shown once at provisioning, not on every poll.
      const rows = [...store.cps.values()]
        .map((c) => {
          const st = store.stations.get(Number(c.station_id));
          return {
            cp_id: c.cp_id,
            station_id: c.station_id,
            station_name: st?.name || null,
            ocpp_identity: c.ocpp_identity,
            vendor: c.vendor || null,
            model: c.model || null,
            firmware_version: c.firmware_version || null,
            status: c.status || 'OFFLINE',
            last_boot_at: c.last_boot_at || null,
            last_seen_at: c.last_seen_at || null,
            connectors: [...store.connectors.values()].filter((x) => Number(x.cp_id) === Number(c.cp_id)).length,
          };
        })
        .sort((a, b) => a.cp_id - b.cp_id);
      res.json({ charge_points: rows, online: rows.filter((c) => c.status === 'ONLINE').length });
    })
  );
  r.post(
    '/admin/charge-points',
    authRequired,
    roles('ADMIN'),
    safe(async (req, res) => {
      const b = req.body;
      if (!store.stations.get(Number(b.station_id)))
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'station' } });
      // BUG-033: validate admin-supplied hardware fields before any write — a bad
      // ocpp_identity would corrupt the gateway's URL routing (it is embedded in
      // /ocpp/:identity), and a weak auth_secret undermines OCPP Security Profile 1
      // basic auth. Generated values (random hex / defaults) always pass.
      if (b.ocpp_identity != null) {
        const id = String(b.ocpp_identity);
        if (!id || id.length > 64 || !/^[A-Za-z0-9._-]+$/.test(id))
          return res.status(422).json({
            error: { code: 'INVALID_OCPP_ID', message: 'ocpp_identity must be 1..64 chars of [A-Za-z0-9._-]' },
          });
      }
      if (b.auth_secret != null && (typeof b.auth_secret !== 'string' || b.auth_secret.length < 16))
        return res
          .status(422)
          .json({ error: { code: 'WEAK_SECRET', message: 'auth_secret must be a string of >= 16 chars' } });
      // BUG-047: standalone CP provisioning goes through the store method so the Oracle
      // adapter mirrors it (a provisioned CP's connectors must exist in the durable
      // engine or the first reservation on them 500s). Validation lives here; the store
      // method owns the mutation + GAP-002's one-TYPE2/22kW default connector.
      // Await required — the mirror wrapper is promise-shaped (BUG-041 class).
      const cp = await store.provisionChargePoint(Number(b.station_id), b);
      store.auditLog(req.user.id, 'CHARGE_POINT', cp.cp_id, 'PROVISION', null, { ocpp_identity: cp.ocpp_identity });
      res.status(201).json({ charge_point: { ...cp }, ws_url: `/ocpp/${cp.ocpp_identity}` });
    })
  );

  // ---- AI advisory surface (ADR-0008) ----
  // Guardrails, enforced HERE (never inside the sidecar): OPERATOR/ADMIN only,
  // operator station-scope checked before any AI call, and the AI is strictly
  // advisory — no endpoint here can mutate charging, billing or connector state.
  // The sidecar is internal-only; this proxy attaches the shared x-internal token
  // and degrades to 503 AI_UNAVAILABLE (never a 500, never blocking the money path).
  const AI = {
    // Read per call (not at mount) so tests can point AI_URL at a stub, then at a
    // dead port, within one process.
    get url() {
      return process.env.AI_URL || 'http://127.0.0.1:8100';
    },
    get token() {
      // Production never dials with the published demo literal. The sidecar already
      // refuses to boot without a >=24-byte AI_TOKEN (`apps/ai/service.py:_resolve_token`);
      // sending 'dev-internal' anyway would either be refused or, if that gate were ever
      // lowered, turn a well-known string into a live credential on an internal endpoint.
      // An unconfigured proxy is an outage we can name, so fail closed here.
      const t = process.env.AI_TOKEN;
      if (
        process.env.NODE_ENV === 'production' &&
        (!t || t.length < 24 || t === 'dev-internal' || /^replace_with_/.test(t))
      ) {
        const e = new Error('AI_TOKEN is unset or a published dev value — refusing to call the sidecar');
        e.code = 'AI_MISCONFIGURED';
        throw e;
      }
      return t || 'dev-internal';
    },
    get timeoutMs() {
      return Number(process.env.AI_TIMEOUT_MS || 3000);
    },
  };
  // Mirror of apps/ai/contract.py: HORIZON = 24 leads, MIN_HISTORY_H = 168 h.
  // `apps/api/test/ai.js` pins the clamp, so a contract bump that forgets this
  // file fails a test instead of quietly asking the sidecar for 48 leads.
  const AI_HORIZON = 24;
  const HISTORY_HOURS = 240;
  async function aiCall(path, init) {
    const res = await fetch(`${AI.url}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-internal': AI.token, ...(init?.headers || {}) },
      signal: AbortSignal.timeout(AI.timeoutMs),
    });
    if (!res.ok) {
      let detail = null;
      try {
        detail = (await res.json())?.detail;
      } catch {}
      const e = new Error(detail || `ai ${path} ${res.status}`);
      // A 422 is the sidecar refusing an input the proxy itself should have refused;
      // surface it as 422, not as an outage. Everything else is an upstream failure.
      e.code = res.status === 422 ? 'AI_INVALID_INPUT' : 'AI_UPSTREAM';
      e.status = res.status === 422 ? 422 : 502;
      throw e;
    }
    return res.json();
  }
  async function aiPost(path, body) {
    return aiCall(path, { method: 'POST', body: JSON.stringify(body) });
  }
  async function aiGet(path) {
    return aiCall(path, { method: 'GET' });
  }
  function aiScope(req, res, sid) {
    if (req.user.role === 'OPERATOR' && !(req.user.stationScope || []).includes(Number(sid))) {
      res.status(403).json({ error: { code: 'OUT_OF_SCOPE', message: 'station not assigned' } });
      return false;
    }
    return true;
  }
  function aiDown(res, e, path) {
    if (e && e.code === 'AI_INVALID_INPUT') {
      return res.status(422).json({ error: { code: 'AI_INVALID_INPUT', message: e.message } });
    }
    if (e && e.code === 'AI_UPSTREAM') {
      return res.status(502).json({ error: { code: 'AI_UNAVAILABLE', message: `AI sidecar answered ${e.message}` } });
    }
    // Not wired is not the same as unreachable: name the actual condition so the
    // operator fixes the secret instead of restarting a healthy container.
    if (e && e.code === 'AI_MISCONFIGURED') {
      return res.status(503).json({ error: { code: 'AI_UNAVAILABLE', message: e.message } });
    }
    return res.status(503).json({ error: { code: 'AI_UNAVAILABLE', message: `AI sidecar unreachable (${path})` } });
  }

  r.get(
    '/ai/forecast',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const sid = Number(req.query.stationId);
      if (!store.stations.has(sid)) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'unknown station' } });
      }
      if (!aiScope(req, res, sid)) return;
      // The sidecar trains on hourly kWh with real timestamps (contract v3); this
      // route used to send hourly session COUNTS keyed by whatever order the map
      // happened to iterate in, so the model was fed a different quantity than it
      // was fitted for and the calendar features were meaningless.
      const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), AI_HORIZON);
      const hist = store.hourlyStationKwh(sid, HISTORY_HOURS);
      try {
        const j = await aiPost('/v1/forecast', {
          station_ids: [sid],
          hours,
          // Keyed by station id, and timestamped: hour-of-day/day-of-week come from
          // the clock, not from the array length.
          history: { [String(sid)]: hist },
        });
        store.auditLog(req.user.id, 'STATION', sid, 'AI_FORECAST', null, { hours, history_hours: hist.kwh.length });
        res.json({ ...j, station_id: sid, history_hours: hist.kwh.length });
      } catch (e) {
        aiDown(res, e, '/v1/forecast');
      }
    })
  );

  r.get(
    '/ai/anomalies',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const sid = Number(req.query.stationId);
      if (!store.stations.has(sid)) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'unknown station' } });
      }
      if (!aiScope(req, res, sid)) return;
      const cpIds = new Set([...store.cps.values()].filter((c) => c.station_id === sid).map((c) => c.cp_id));
      const sessIds = new Set(
        [...store.sessions.values()]
          .filter((s) => cpIds.has(Number(s.connector_ref.split(':')[0])))
          .map((s) => s.session_id)
      );
      const ticks = store.readings
        .filter((r2) => sessIds.has(r2.session_id))
        .slice(-2000)
        .map((r2) => ({ session_id: r2.session_id, ts: r2.taken_at, meter_kwh: r2.meter_kwh, power_kw: r2.power_kw }));
      if (!ticks.length) {
        return res.json({ advisory: true, checked: 0, flagged: [], method: 'median/MAD robust z-score' });
      }
      try {
        const j = await aiPost('/v1/anomalies', { ticks });
        store.auditLog(req.user.id, 'STATION', sid, 'AI_ANOMALY_SCAN', null, { checked: ticks.length });
        res.json({ ...j, station_id: sid });
      } catch (e) {
        aiDown(res, e, '/v1/anomalies');
      }
    })
  );

  r.post(
    '/ai/optimize',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const b = req.body || {};
      const sid = Number(b.stationId);
      if (!store.stations.has(sid)) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'unknown station' } });
      }
      if (!aiScope(req, res, sid)) return;
      const vehicles = Array.isArray(b.vehicles) ? b.vehicles : [];
      if (!vehicles.length) {
        return res.status(422).json({ error: { code: 'INVALID_VEHICLES', message: 'vehicles[] required' } });
      }
      // Hard electrical input: the station's installed connector capacity bounds the LP.
      const cap = [...store.connectors.values()]
        .filter((c) => {
          const cp = store.cps.get(c.cp_id);
          return cp && cp.station_id === sid;
        })
        .reduce((m, c) => m + Number(c.max_power_kw || 22), 0);
      try {
        const j = await aiPost('/v1/optimize', {
          station_id: sid,
          window_hours: Math.min(Math.max(Number(b.windowHours) || 24, 1), 72),
          station_power_cap_kw: cap,
          price_per_kwh: Array.isArray(b.pricePerKwh) && b.pricePerKwh.length ? b.pricePerKwh : [8.5],
          vehicles: vehicles.slice(0, 200).map((v) => ({
            id: String(v.id),
            arrive: Number(v.arriveHour) || 0,
            deadline: Number(v.deadlineHour) || 24,
            energy_kwh: Number(v.energyKwh),
            max_kw: Number(v.maxKw) || 22,
          })),
        });
        store.auditLog(req.user.id, 'STATION', sid, 'AI_OPTIMIZE', null, { vehicles: vehicles.length });
        res.json({ ...j, station_id: sid });
      } catch (e) {
        aiDown(res, e, '/v1/optimize');
      }
    })
  );

  // Governance: the model card is the receipt a reviewer reads before believing a
  // forecast. It is staff-only but not station-scoped — it contains no customer data.
  r.get(
    '/ai/model-card',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      try {
        res.json(await aiGet('/v1/model-card'));
      } catch (e) {
        aiDown(res, e, '/v1/model-card');
      }
    })
  );

  // Data-drift monitor: compare the previous baseline window with the most recent
  // window on the same contiguous hourly grid. This is a statistical warning, never
  // an automatic retrain and never an input to control.
  r.get(
    '/ai/drift',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const sid = Number(req.query.stationId);
      if (!store.stations.has(sid)) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'unknown station' } });
      }
      if (!aiScope(req, res, sid)) return;
      const recentDays = Math.min(Math.max(Number(req.query.recentDays) || 7, 3), 14);
      const baselineDays = Math.min(Math.max(Number(req.query.baselineDays) || 14, 7), 31 - recentDays);
      const hist = store.hourlyStationKwh(sid, (baselineDays + recentDays) * 24);
      const split = baselineDays * 24;
      try {
        const j = await aiPost('/v1/drift', {
          station_id: sid,
          baseline: { timestamps: hist.timestamps.slice(0, split), kwh: hist.kwh.slice(0, split) },
          recent: { timestamps: hist.timestamps.slice(split), kwh: hist.kwh.slice(split) },
        });
        store.auditLog(req.user.id, 'STATION', sid, 'AI_DRIFT', null, {
          verdict: j.verdict,
          baseline_days: baselineDays,
          recent_days: recentDays,
        });
        res.json({ ...j, station_id: sid, baseline_days: baselineDays, recent_days: recentDays });
      } catch (e) {
        aiDown(res, e, '/v1/drift');
      }
    })
  );

  // Explainability: why did the model forecast this shape? Feature-group occlusion
  // answers in kWh, in the same units an operator reads on the chart.
  r.post(
    '/ai/explain',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const b = req.body || {};
      const sid = Number(b.stationId);
      if (!store.stations.has(sid)) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'unknown station' } });
      }
      if (!aiScope(req, res, sid)) return;
      const hours = Math.min(Math.max(Number(b.hours) || AI_HORIZON, 1), AI_HORIZON);
      const hist = store.hourlyStationKwh(sid, HISTORY_HOURS);
      try {
        const j = await aiPost('/v1/explain', { station_id: sid, history: hist, hours });
        store.auditLog(req.user.id, 'STATION', sid, 'AI_EXPLAIN', null, {
          hours,
          top_driver: j.top_driver,
          history_hours: hist.kwh.length,
        });
        res.json({ ...j, station_id: sid, history_hours: hist.kwh.length });
      } catch (e) {
        aiDown(res, e, '/v1/explain');
      }
    })
  );

  return r;
};
