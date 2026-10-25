// CarbonPilot REST surface (ADR-0017).
//
// Read-only by design. Carbon never mutates charging state here: a plan that
// internalises a carbon price still goes through POST /control/plan, where the
// same certification, envelope and actuation rules apply. These routes answer
// four questions and nothing else:
//   * what is the grid doing right now / next 48 h for this region or station?
//   * what did this session actually emit, with a verifiable receipt?
//   * what did this site emit over a window?
//   * which regions does the model know?
//
// RBAC mirrors the rest of the API: forecasts and a station's carbon card are
// readable by any authenticated user (the grid mix is public data), a session
// receipt is owner-or-staff, and a site aggregate is OPERATOR+ inside scope.
'use strict';
const express = require('express');
const { authRequired, roles } = require('./middleware/auth');
const { routerBarrier } = require('./middleware/security');
const carbon = require('./carbon/intensity');

module.exports = function carbonRoutes(store) {
  const r = express.Router();
  const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  r.use(routerBarrier({ key: 'carbon', limit: 120 }));

  const outOfScope = (req, stationId) =>
    req.user.role === 'OPERATOR' && stationId != null && !(req.user.stationScope || []).includes(Number(stationId));
  const scopeDeny = (res) => res.status(403).json({ error: { code: 'OUT_OF_SCOPE', message: 'station not assigned' } });
  const notFound = (res, what) => res.status(404).json({ error: { code: 'NOT_FOUND', message: what } });
  const stationOfSession = (sess) => {
    if (!sess) return null;
    const cpId = Number(String(sess.connector_ref || '').split(':')[0]);
    return store.cps.get(cpId)?.station_id ?? null;
  };

  const stationPayload = (stationId, { hours = 48, stepMin = 60, days = 30 } = {}) => {
    const st = store.stations.get(Number(stationId));
    if (!st) return null;
    const region = carbon.regionForStation(st);
    const fc = carbon.forecast({ region, hours, stepMin });
    const to = new Date().toISOString();
    const from = new Date(Date.now() - Math.min(Math.max(Number(days) || 30, 1), 365) * 86400000).toISOString();
    const summary = carbon.summarize(store, { stationId: st.station_id, from, to });
    return {
      station_id: st.station_id,
      station_name: st.name,
      city: st.city,
      state: st.state,
      region,
      region_label: carbon.REGIONS[region].label,
      renewable_share: carbon.REGIONS[region].renewable_share,
      current: carbon.intensityAt(region, Date.now()),
      forecast: fc,
      summary,
      model: carbon.MODEL_VERSION,
      // The carbon signal is a model, not a meter. Say so on every response so a
      // client cannot render it as a measured value without lying.
      advisory: true,
      source: 'model',
    };
  };

  r.get('/carbon/regions', authRequired, (req, res) => {
    res.json({
      regions: carbon.regionList(),
      default_region: carbon.DEFAULT_REGION,
      social_cost_inr_per_tonne: carbon.SOCIAL_COST_INR_PER_TONNE,
      model: carbon.MODEL_VERSION,
      source: 'model',
    });
  });

  r.get(
    '/carbon/forecast',
    authRequired,
    safe(async (req, res) => {
      const stationId = req.query.stationId != null ? Number(req.query.stationId) : null;
      if (stationId != null) {
        if (!Number.isFinite(stationId) || !store.stations.get(stationId)) return notFound(res, 'station');
        if (outOfScope(req, stationId)) return scopeDeny(res);
        const payload = stationPayload(stationId, {
          hours: req.query.hours,
          stepMin: req.query.stepMin,
        });
        return res.json(payload);
      }
      const region = carbon.normalizeRegion(req.query.region);
      const fc = carbon.forecast({ region, hours: req.query.hours, stepMin: req.query.stepMin });
      res.json({ ...fc, advisory: true, source: 'model' });
    })
  );

  r.get(
    '/stations/:id/carbon',
    authRequired,
    safe(async (req, res) => {
      const stationId = Number(req.params.id);
      if (!store.stations.get(stationId)) return notFound(res, 'station');
      if (outOfScope(req, stationId)) return scopeDeny(res);
      const payload = stationPayload(stationId, {
        hours: req.query.hours,
        stepMin: req.query.stepMin,
        days: req.query.days,
      });
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json(payload);
    })
  );

  r.get(
    '/carbon/receipt/:sessionId',
    authRequired,
    safe(async (req, res) => {
      const sid = Number(req.params.sessionId);
      if (!Number.isFinite(sid)) return notFound(res, 'session');
      const sess = store.sessions.get(sid);
      if (!sess) return notFound(res, 'session');
      const isStaff = req.user.role === 'OPERATOR' || req.user.role === 'ADMIN';
      if (!isStaff && Number(sess.user_id) !== Number(req.user.id))
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'not your session' } });
      if (isStaff && req.user.role === 'OPERATOR' && outOfScope(req, stationOfSession(sess))) return scopeDeny(res);
      const receipt = carbon.receiptForSession(store, sid, { region: req.query.region });
      if (!receipt) return notFound(res, 'session');
      res.json({ advisory: true, receipt });
    })
  );

  r.get(
    '/carbon/summary',
    authRequired,
    roles('OPERATOR', 'ADMIN'),
    safe(async (req, res) => {
      const stationId =
        req.query.siteId != null
          ? Number(req.query.siteId)
          : req.query.stationId != null
            ? Number(req.query.stationId)
            : null;
      if (stationId != null && !store.stations.get(stationId)) return notFound(res, 'station');
      if (stationId != null && outOfScope(req, stationId)) return scopeDeny(res);
      const to = req.query.to || new Date().toISOString();
      const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString();
      if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(from) >= Date.parse(to))
        return res
          .status(400)
          .json({ error: { code: 'INVALID_WINDOW', message: 'from/to must be valid and from < to' } });
      const summary = carbon.summarize(store, {
        stationId,
        from,
        to,
        limit: req.query.limit,
      });
      res.json({ advisory: true, summary });
    })
  );

  return r;
};
