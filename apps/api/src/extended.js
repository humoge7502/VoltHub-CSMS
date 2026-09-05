// Extended modules: tariffs-public, reviews-read, notifications, vehicle-default,
// operator session control, admin station hardware CRUD. Mounted at /api/v1.
'use strict';
const express = require('express');
const spec = require('./docs');
const { authRequired, roles } = require('./middleware/auth');

function oraStatus(e) {
  if (e.num === -20501) return 422;
  if ([-20502, -20503, -20504, -20601, -20602, -20603, -20702, -20703, -20704].includes(e.num)) return 409;
  if (e.num === -20705) return 402;
  return e.status || 500;
}

module.exports = function extended(store) {
  const r = express.Router();
  const safe = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  r.get('/docs', (req, res) => res.json(spec));

  // public current-tariff preview (drivers see prices before reserving)
  r.get('/tariffs/active', safe(async (req, res) => {
    const byGroup = new Map();
    for (const p of store.plans.values()) {
      if (!byGroup.has(p.group_id) || byGroup.get(p.group_id).version_no < p.version_no) byGroup.set(p.group_id, p);
    }
    res.json({
      plans: [...byGroup.values()].map(p => ({
        ...p, bands: store.bands.filter(b => b.plan_id === p.plan_id),
      })),
    });
  }));

  // station reviews (read side of REV-01)
  r.get('/stations/:id/reviews', safe(async (req, res) => {
    const sid = String(req.params.id);
    const cpIds = new Set([...store.cps.values()].filter(c => String(c.station_id) === sid).map(c => String(c.cp_id)));
    const out = [...store.reviews.values()]
      .filter(r => { const s = store.sessions.get(r.session_id); return s && cpIds.has(s.connector_ref.split(':')[0]); })
      .sort((a, b) => b.review_id - a.review_id).slice(0, 50)
      .map(x => ({ ...x, driver: store.users.get(x.user_id)?.full_name?.split(' ')[0] + ' ' + (store.users.get(x.user_id)?.full_name?.split(' ')[1]?.[0] || '') + '.' }));
    res.json({ reviews: out });
  }));

  // active sessions per station (O1 active table)
  r.get('/stations/:id/sessions/active', safe(async (req, res) => {
    const sid = String(req.params.id);
    const cpIds = new Set([...store.cps.values()].filter(c => String(c.station_id) === sid).map(c => String(c.cp_id)));
    res.json({
      sessions: [...store.sessions.values()].filter(s =>
        cpIds.has(s.connector_ref.split(':')[0]) && ['PREPARING', 'CHARGING', 'SUSPENDED'].includes(s.state)),
    });
  }));

  // operator state control: SUSPENDED <-> CHARGING (matrix-enforced, 409 otherwise)
  r.patch('/sessions/:id/state', authRequired, safe(async (req, res) => {
    const s = store.sessions.get(Number(req.params.id));
    if (!s) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'session' } });
    if (req.user.role === 'DRIVER' && s.user_id !== req.user.id) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'not your session' } });
    try { res.json({ session: await store.transition(req.params.id, req.body.to, req.body.reason || 'OPERATOR') }); }
    catch (e) { res.status(oraStatus(e)).json({ error: { code: e.code, message: e.message, ora: e.num || null } }); }
  }));

  // vehicle default / rename (DRV-02)
  r.patch('/me/vehicles/:id', authRequired, safe(async (req, res) => {
    const v = store.vehicles.get(Number(req.params.id));
    if (!v || v.user_id !== req.user.id) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'vehicle' } });
    if (req.body.is_default) for (const x of store.vehicles.values()) if (x.user_id === req.user.id) x.is_default = 'N';
    Object.assign(v, {
      ...(req.body.nickname !== undefined ? { nickname: req.body.nickname } : {}),
      ...(req.body.is_default ? { is_default: 'Y' } : {}),
    });
    store.auditLog(req.user.id, 'VEHICLE', v.vehicle_id, 'UPDATE', null, { is_default: v.is_default });
    res.json({ vehicle: v });
  }));

  // notifications (NTF-01)
  r.get('/me/notifications', authRequired, safe(async (req, res) => {
    const list = store.notifs.filter(n => n.user_id === req.user.id).sort((a, b) => b.notification_id - a.notification_id).slice(0, 50);
    res.json({ notifications: list, unread: list.filter(n => n.is_read === 'N').length });
  }));
  r.post('/me/notifications/:id/read', authRequired, safe(async (req, res) => {
    const n = store.notifs.find(x => x.notification_id === Number(req.params.id) && x.user_id === req.user.id);
    if (!n) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'notification' } });
    n.is_read = 'Y';
    res.json({ notification: n });
  }));

  // ---- admin hardware (A3) ----
  r.get('/admin/stations', authRequired, roles('OPERATOR', 'ADMIN'), safe(async (req, res) => {
    res.json({
      stations: [...store.stations.values()].map(s => ({
        ...s,
        points: [...store.cps.values()].filter(c => c.station_id === s.station_id).length,
        connectors: [...store.connectors.values()].filter(c => store.cps.get(c.cp_id)?.station_id === s.station_id).length,
      })),
    });
  }));
  r.post('/admin/stations', authRequired, roles('ADMIN'), safe(async (req, res) => {
    const b = req.body;
    if (!(b.name && Number.isFinite(Number(b.latitude)) && Number.isFinite(Number(b.longitude)))) {
      return res.status(422).json({ error: { code: 'INVALID_STATION', message: 'name + latitude + longitude required' } });
    }
    const station_id = ++store.seq.station;
    const st = {
      station_id, name: b.name, latitude: Number(b.latitude), longitude: Number(b.longitude),
      address_line: b.address_line || '', city: b.city || 'Chennai', state: b.state || 'Tamil Nadu',
      pincode: b.pincode || null, status: 'ACTIVE', operator_id: b.operator_id || null,
      created_at: new Date().toISOString(),
    };
    store.stations.set(station_id, st);
    (b.amenities || []).forEach(a => store.amenities.push({ station_id, amenity: a }));
    // inline hardware provision: [{vendor, model, connectors:[{standard, max_power_kw}]}]
    const provisioned = [];
    for (const [i, p] of (b.charge_points || []).entries()) {
      const cp_id = ++store.seq.cp;
      const ocpp_identity = p.ocpp_identity || `VH-${station_id}-CP${i + 1}`;
      if (store.cpsByOcpp.has(ocpp_identity)) return res.status(409).json({ error: { code: 'DUPLICATE_OCPP_ID', message: ocpp_identity } });
      store.cps.set(cp_id, { cp_id, station_id, ocpp_identity, vendor: p.vendor || 'VoltHub', model: p.model || 'VH-AC22', firmware_version: '1.6.5', status: 'ONLINE', last_boot_at: null, last_seen_at: null });
      store.cpsByOcpp.set(ocpp_identity, cp_id);
      (p.connectors || [{ standard: 'TYPE2', max_power_kw: 22 }]).forEach((c, k) => {
        const stdRow = store.standards.find(t => t.code === c.standard) || store.standards[0];
        store.connectors.set(`${cp_id}:${k + 1}`, { cp_id, connector_no: k + 1, standard_id: stdRow.standard_id, max_power_kw: Number(c.max_power_kw || 22), status: 'AVAILABLE', last_state_change_at: new Date().toISOString() });
      });
      provisioned.push({ cp_id, ocpp_identity });
    }
    store.auditLog(req.user.id, 'STATION', station_id, 'CREATE', null, { name: st.name });
    res.status(201).json({ station: st, provisioned });
  }));
  r.patch('/admin/stations/:id', authRequired, roles('ADMIN'), safe(async (req, res) => {
    const s = store.stations.get(Number(req.params.id));
    if (!s) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'station' } });
    if (req.body.status) s.status = req.body.status;
    if (req.body.operator_id !== undefined) s.operator_id = req.body.operator_id;
    if (req.body.name) s.name = req.body.name;
    store.auditLog(req.user.id, 'STATION', s.station_id, 'UPDATE', null, { status: s.status });
    res.json({ station: s });
  }));
  r.post('/admin/charge-points', authRequired, roles('ADMIN'), safe(async (req, res) => {
    const b = req.body;
    if (!store.stations.get(Number(b.station_id))) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'station' } });
    const n = [...store.cps.values()].filter(c => c.station_id === Number(b.station_id)).length + 1;
    const ocpp_identity = b.ocpp_identity || `VH-${b.station_id}-CP${n}`;
    if (store.cpsByOcpp.has(ocpp_identity)) return res.status(409).json({ error: { code: 'DUPLICATE_OCPP_ID', message: ocpp_identity } });
    const cp_id = ++store.seq.cp;
    const cp = { cp_id, station_id: Number(b.station_id), ocpp_identity, vendor: b.vendor || 'VoltHub', model: b.model || 'VH-DC60', firmware_version: '1.6.5', status: 'ONLINE', last_boot_at: null, last_seen_at: null };
    store.cps.set(cp_id, cp); store.cpsByOcpp.set(ocpp_identity, cp_id);
    store.auditLog(req.user.id, 'CHARGE_POINT', cp_id, 'PROVISION', null, { ocpp_identity });
    res.status(201).json({ charge_point: cp, ws_url: `/ocpp/${ocpp_identity}` });
  }));

  return r;
};
