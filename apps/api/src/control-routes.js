// Control-plane REST surface (blueprint Q.1 / ADR-0010). RBAC: ADMIN writes grid
// assets + control mode; OPERATOR+ reads decisions/certificates. The default site
// mode is OFF — actuation is opt-in per site until receipts exist.
'use strict';
const express = require('express');
const { authRequired, roles } = require('./middleware/auth');
const { oraStatus } = require('./errors');
const control = require('./control/controller');
const smartCharging = require('./ocpp/smart-charging');

module.exports = function controlRoutes(store, registry, log) {
  const r = express.Router();
  const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---- grid assets (electrical hierarchy) — ADMIN ----
  r.post(
    '/stations/:id/grid-assets',
    authRequired,
    roles('ADMIN'),
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
    authRequired,
    roles('ADMIN'),
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
    authRequired,
    roles('ADMIN'),
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
      try {
        const { mode, decision, solved, pushes } = control.planSite(store, siteId, req.body || {});
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
          compiled: pushes.map((p) => ({ cp_id: p.cpId, clamped: p.clamped, sha256: p.payloadSha256 })),
          actuated,
        });
      } catch (e) {
        res.status(oraStatus(e)).json({ error: { code: e.code, message: e.message, ora: e.num || null } });
      }
    })
  );

  // ---- decision + certificate history with provenance ----
  r.get(
    '/control/decisions',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const siteId = req.query.siteId ? Number(req.query.siteId) : null;
      let rows = [...store.controlDecisions.values()].sort((a, b) => b.decision_id - a.decision_id);
      if (siteId) rows = rows.filter((d) => d.site_id === siteId);
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
      res.json({ decision: d, payload: JSON.parse(d.payload_json || '{}') });
    })
  );
  r.get(
    '/control/certificates',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      let rows = [...store.certificates.values()].sort((a, b) => b.cert_id - a.cert_id);
      if (req.query.siteId) rows = rows.filter((c) => c.station_id === Number(req.query.siteId));
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
    authRequired,
    roles('ADMIN'),
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

  // ---- direct profile ops (diagnostics; envelope still governs SetChargingProfile) ----
  r.post(
    '/control/cp/:cpId/clear-profile',
    authRequired,
    roles('ADMIN'),
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
      try {
        res.json(await smartCharging.getCompositeSchedule(registry, cp.ocpp_identity, req.query));
      } catch (e) {
        res.status(e.status || 500).json({ error: { code: e.code || 'GCS_FAILED', message: e.message } });
      }
    })
  );

  return r;
};
