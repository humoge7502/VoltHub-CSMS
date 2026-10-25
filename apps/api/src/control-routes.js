// Control-plane REST surface (blueprint Q.1 / ADR-0010). RBAC: ADMIN writes grid
// assets + control mode; OPERATOR+ reads decisions/certificates. The default site
// mode is OFF — actuation is opt-in per site until receipts exist.
'use strict';
const express = require('express');
const { authRequired, roles } = require('./middleware/auth');
const { makeLimiter, routerBarrier } = require('./middleware/security');
const { oraStatus } = require('./errors');
const control = require('./control/controller');
const smartCharging = require('./ocpp/smart-charging');
const ocppCommands = require('./ocpp/commands');

module.exports = function controlRoutes(store, registry, log) {
  const r = express.Router();
  const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  // Tiered control-plane limiters: 30/min per user — the one tier STRICTER than the
  // global per-role throttle, because these routes flip grid caps and push charging
  // profiles at real hardware — plus a per-IP tier as defense in depth for probing of
  // the surface. Buckets are keyed by the verified `sub` (SEC-006), so an operator
  // cannot escape the tier by minting extra tokens.
  // Plan/certify bodies pass through model.clampHorizon/clampDtMin downstream,
  // so untrusted horizon/cadence values can never size an allocation.
  const controlLimiter = routerBarrier({ key: 'ctl', limit: 30, message: 'slow down: 30 req/min' });
  const ipLimiter = makeLimiter({ key: 'ctl-ip', limit: 30 });
  // Router-wide control-plane barrier: every route on this surface authorizes,
  // and several actuate hardware or expose enforcement telemetry, so the whole
  // router sits behind an explicit limiter. Reads and writes share the tier —
  // the control plane is small, human-facing, and hardware-backed.
  r.use(ipLimiter, controlLimiter);
  const adminWrite = [authRequired, roles('ADMIN')];

  // BUG-059 (review 2026-10-24): the control plane had NO operator station-scope
  // checks — an operator assigned to station A could run plan cycles that push
  // charging profiles at station B's real chargers. Every sibling surface (analytics,
  // remote-start, AI) already enforced the same contract; these routes now do too.
  // ADMIN bypasses (mirrors middleware/auth.js scopeCheck/requireOwned).
  const outOfScope = (req, stationId) =>
    req.user.role === 'OPERATOR' && stationId != null && !(req.user.stationScope || []).includes(Number(stationId));
  const stationOfSession = (sess) =>
    sess ? (store.cps.get(Number(String(sess.connector_ref).split(':')[0]))?.station_id ?? null) : null;
  const stationOfCp = (cpId) => store.cps.get(Number(cpId))?.station_id ?? null;
  const scopeDeny = (res) => res.status(403).json({ error: { code: 'OUT_OF_SCOPE', message: 'station not assigned' } });

  // ---- grid assets (electrical hierarchy) — ADMIN ----
  r.post(
    '/stations/:id/grid-assets',
    ...adminWrite,
    safe(async (req, res) => {
      try {
        const asset = store.upsertGridAsset(Number(req.params.id), req.body, req.user.id);
        res.status(201).json({ asset });
      } catch (e) {
        res.status(oraStatus(e)).json({ error: { code: e.code, message: e.message, ora: e.num || null } });
      }
    })
  );
  r.get(
    '/stations/:id/grid-assets',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const sid = Number(req.params.id);
      if (!store.stations.get(sid)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'station' } });
      if (outOfScope(req, sid)) return scopeDeny(res);
      res.json({
        assets: [...store.gridAssets.values()].filter((a) => a.station_id === sid),
        site_cap_kw: store.siteCapKw(sid),
        control_mode: store.getControlMode(sid),
      });
    })
  );
  // Second-person approval of a PENDING cap reduction (four-eyes rule, N.1).
  r.post(
    '/grid-assets/:id/approve',
    ...adminWrite,
    safe(async (req, res) => {
      try {
        const asset = store.approveGridAsset(Number(req.params.id), req.user.id);
        res.json({ asset });
      } catch (e) {
        res.status(oraStatus(e)).json({ error: { code: e.code, message: e.message, ora: e.num || null } });
      }
    })
  );

  // ---- control mode — ADMIN (default OFF until receipts exist) ----
  r.post(
    '/control/mode',
    ...adminWrite,
    safe(async (req, res) => {
      try {
        const out = store.setControlMode(
          Number(req.body.siteId),
          String(req.body.mode || '').toUpperCase(),
          req.user.id
        );
        res.json(out);
      } catch (e) {
        res.status(oraStatus(e)).json({ error: { code: e.code, message: e.message, ora: e.num || null } });
      }
    })
  );

  // ---- one plan cycle: optimize + certify + (ENFORCED) actuate ----
  r.post(
    '/control/plan/:siteId',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const siteId = Number(req.params.siteId);
      if (!store.stations.get(siteId))
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'station' } });
      // BUG-059: planning (and in ENFORCED mode, actuation) is a station mutation.
      if (outOfScope(req, siteId)) return scopeDeny(res);
      try {
        const plan = control.planSite(store, siteId, req.body || {});
        const { mode, decision, solved, pushes, certifications, carbon } = plan;
        const actuated = [];
        if (mode === 'ENFORCED') {
          for (const p of pushes) {
            try {
              const sent = await smartCharging.setChargingProfile(store, registry, log, {
                cpId: p.cpId,
                profile: p.profile,
                decisionId: decision.decision_id,
                payloadSha256: p.payloadSha256,
                clamped: p.clamped,
              });
              actuated.push({ cp_id: p.cpId, push_id: sent.push_id, uid: sent.uid });
            } catch (e) {
              actuated.push({ cp_id: p.cpId, error: e.code || 'PUSH_FAILED', message: e.message });
            }
          }
        }
        res.json({
          mode,
          decision: { ...decision, payload_json: undefined },
          metrics: solved.metrics,
          certifications,
          compiled: pushes.map((p) => ({ cp_id: p.cpId, clamped: p.clamped, sha256: p.payloadSha256 })),
          actuated,
          ...(carbon ? { carbon } : {}),
        });
      } catch (e) {
        res.status(oraStatus(e)).json({ error: { code: e.code, message: e.message, ora: e.num || null } });
      }
    })
  );

  // ---- certify one session on demand (plug-in admission; blueprint H.2.4) ----
  r.post(
    '/control/sessions/:id/certify',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      // BUG-059: certify changes admission for a session — station mutation.
      const sess = store.sessions.get(Number(req.params.id));
      if (!sess) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'session' } });
      if (outOfScope(req, stationOfSession(sess))) return scopeDeny(res);
      try {
        res.json(control.certifySession(store, req.params.id, req.body || {}));
      } catch (e) {
        res.status(oraStatus(e)).json({ error: { code: e.code, message: e.message, ora: e.num || null } });
      }
    })
  );

  // ---- enforcement telemetry: scheduled vs actual kW (the verifier's evidence) ----
  r.get(
    '/control/enforcement',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const limit = Math.min(Number(req.query.limit) || 50, 500);
      // BUG-059: enforcement telemetry is scoped — an explicit foreign siteId is a 403,
      // and without one an operator sees only their assigned stations' ticks.
      if (req.query.siteId && outOfScope(req, Number(req.query.siteId))) return scopeDeny(res);
      let rows = [...store.enforcementTicks];
      if (req.query.siteId) {
        const sid = Number(req.query.siteId);
        const cpIds = new Set([...store.cps.values()].filter((c) => c.station_id === sid).map((c) => Number(c.cp_id)));
        rows = rows.filter((t) => cpIds.has(Number(t.cp_id)));
      } else if (req.user.role === 'OPERATOR') {
        const scope = new Set((req.user.stationScope || []).map(Number));
        const cpIds = new Set(
          [...store.cps.values()].filter((c) => scope.has(Number(c.station_id))).map((c) => Number(c.cp_id))
        );
        rows = rows.filter((t) => cpIds.has(Number(t.cp_id)));
      }
      res.json({ ticks: rows.slice(-limit).reverse() });
    })
  );

  // ---- decision + certificate history with provenance ----
  r.get(
    '/control/decisions',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const siteId = req.query.siteId ? Number(req.query.siteId) : null;
      // BUG-059: decision history follows the operator's scope (explicit site or all-own).
      if (siteId && outOfScope(req, siteId)) return scopeDeny(res);
      let rows = [...store.controlDecisions.values()].sort((a, b) => b.decision_id - a.decision_id);
      if (siteId) rows = rows.filter((d) => d.site_id === siteId);
      else if (req.user.role === 'OPERATOR')
        rows = rows.filter((d) => (req.user.stationScope || []).includes(Number(d.site_id)));
      res.json({ decisions: rows.slice(0, 50) });
    })
  );
  r.get(
    '/control/decisions/:id',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const d = store.controlDecisions.get(Number(req.params.id));
      if (!d) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'decision' } });
      if (outOfScope(req, d.site_id)) return scopeDeny(res);
      res.json({ decision: d, payload: JSON.parse(d.payload_json || '{}') });
    })
  );
  r.get(
    '/control/certificates',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      // BUG-059: certificate history follows the operator's scope (explicit site or all-own).
      if (req.query.siteId && outOfScope(req, Number(req.query.siteId))) return scopeDeny(res);
      let rows = [...store.certificates.values()].sort((a, b) => b.cert_id - a.cert_id);
      if (req.query.siteId) rows = rows.filter((c) => c.station_id === Number(req.query.siteId));
      else if (req.user.role === 'OPERATOR')
        rows = rows.filter((c) => (req.user.stationScope || []).includes(Number(c.station_id)));
      res.json({ certificates: rows.slice(0, 100) });
    })
  );
  r.get(
    '/control/certificates/:id',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const c = store.certificates.get(Number(req.params.id));
      if (!c) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'certificate' } });
      if (outOfScope(req, c.station_id)) return scopeDeny(res);
      res.json({ certificate: c });
    })
  );

  // ---- dead-letter triage — ADMIN (blueprint O.2) ----
  r.get(
    '/ops/dead-letters',
    authRequired,
    roles('ADMIN'),
    safe(async (req, res) => {
      res.json({ letters: store.listDeadLetters(req.query.status || 'OPEN') });
    })
  );
  r.post(
    '/ops/dead-letters/:id/resolve',
    ...adminWrite,
    safe(async (req, res) => {
      try {
        const d = store.resolveDeadLetter(
          Number(req.params.id),
          String(req.body.action || '').toUpperCase(),
          req.user.id
        );
        res.json({ letter: d });
      } catch (e) {
        res.status(oraStatus(e)).json({ error: { code: e.code, message: e.message, ora: e.num || null } });
      }
    })
  );

  // ---- OCPP 1.6 management command suite (ADR-0018) ----
  // The catalog is readable by operators (so the console can render the right form),
  // but every actuation is admin-only: Reset/ChangeConfiguration/DataTransfer are
  // firmware-adjacent and must not be reachable from a compromised operator token.
  r.get(
    '/control/commands',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => res.json(ocppCommands.catalog()))
  );
  r.post(
    '/control/cp/:cpId/commands/:action',
    ...adminWrite,
    safe(async (req, res) => {
      const cp = store.cps.get(Number(req.params.cpId));
      if (!cp) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'charge point' } });
      let built;
      try {
        built = ocppCommands.buildCommand(req.params.action, req.body || {});
      } catch (e) {
        return res.status(e.status || 400).json({
          error: { code: e.code || 'VALIDATION', message: e.message, field: e.field || null },
        });
      }
      try {
        const result = await ocppCommands.send(store, registry, log, { cpId: cp.cp_id, ...built });
        store.auditLog(req.user.id, 'OCPP_COMMAND', cp.cp_id, built.action, null, {
          uid: result.uid,
          status: result.status,
          accepted: result.accepted,
        });
        res.json({ command: result });
      } catch (e) {
        store.auditLog(req.user.id, 'OCPP_COMMAND', cp.cp_id, built.action, null, {
          status: 'FAILED',
          code: e.code || 'COMMAND_FAILED',
        });
        res.status(e.status || 502).json({
          error: {
            code: e.code || 'COMMAND_FAILED',
            message: e.message,
            cp_id: cp.cp_id,
            action: built.action,
            ocpp: e.ocpp || null,
          },
        });
      }
    })
  );

  // ---- direct profile ops (diagnostics; envelope still governs SetChargingProfile) ----
  r.post(
    '/control/cp/:cpId/clear-profile',
    ...adminWrite,
    safe(async (req, res) => {
      const cp = store.cps.get(Number(req.params.cpId));
      if (!cp) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'charge point' } });
      try {
        res.json(await smartCharging.clearChargingProfile(registry, cp.ocpp_identity, req.body || {}));
      } catch (e) {
        res.status(e.status || 500).json({ error: { code: e.code || 'CLEAR_FAILED', message: e.message } });
      }
    })
  );
  r.get(
    '/control/cp/:cpId/composite-schedule',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const cp = store.cps.get(Number(req.params.cpId));
      if (!cp) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'charge point' } });
      // BUG-059: reading a charger's composite schedule reveals another station's
      // constraint envelope — same scope contract as the write paths.
      if (outOfScope(req, stationOfCp(cp.cp_id))) return scopeDeny(res);
      try {
        res.json(await smartCharging.getCompositeSchedule(registry, cp.ocpp_identity, req.query));
      } catch (e) {
        res.status(e.status || 500).json({ error: { code: e.code || 'GCS_FAILED', message: e.message } });
      }
    })
  );

  return r;
};
