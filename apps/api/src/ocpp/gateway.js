// OCPP 1.6J WebSocket gateway: 1 socket per charge point, 10 msg/s/CP.
// Handles Boot/Heartbeat/Status/Authorize/Start/Meter/Stop; mirrors connector
// state into the store (CLIENT_IDENTIFIER='ocpp-gw' equivalent) exactly like
// the Oracle trigger expects in prod.
'use strict';
const { parse, result, callError } = require('@volthub/ocpp-messages');

function mountOcpp(wss, store, log) {
  const registry = new Map(); // ocpp_identity -> ws
  const lastMsg = new Map();

  wss.on('connection', (ws, req) => {
    const m = String(req.url || '').match(/\/ocpp\/([^/?]+)/);
    const identity = m ? decodeURIComponent(m[1]) : null;
    if (!identity || !store.cpsByOcpp.has(identity)) {
      ws.close(4404, 'unknown charge point identity'); return;
    }
    const cpId = store.cpsByOcpp.get(identity);
    const cp = store.cps.get(cpId);
    cp.status = 'ONLINE'; cp.last_seen_at = new Date().toISOString();
    registry.set(identity, ws);
    log.info({ identity }, 'ocpp connected');

    ws.on('message', async (raw) => {
      // rate limit 10/s per CP
      const now = Date.now();
      const arr = (lastMsg.get(identity) || []).filter(t => now - t < 1000);
      arr.push(now); lastMsg.set(identity, arr);
      if (arr.length > 10) { ws.send(callError('0', 'RateLimitExceeded')); return; }
      let msg; try { msg = parse(raw); } catch { ws.send(callError('0', 'FormationViolation')); return; }
      if (msg.kind !== 'CALL') return;
      const p = msg.payload || {};
      try {
        switch (msg.action) {
          case 'BootNotification':
            cp.last_boot_at = new Date().toISOString();
            ws.send(result(msg.uid, { status: 'Accepted', currentTime: new Date().toISOString(), interval: 60 }));
            break;
          case 'Heartbeat':
            cp.last_seen_at = new Date().toISOString();
            ws.send(result(msg.uid, { currentTime: new Date().toISOString() }));
            break;
          case 'StatusNotification': {
            const c = store.connectors.get(`${cpId}:${p.connectorId}`);
            if (c) {
              const map = { Available: 'AVAILABLE', Occupied: 'OCCUPIED', Reserved: 'RESERVED', Faulted: 'FAULTED', Unavailable: 'UNAVAILABLE' };
              const to = map[p.status] || 'UNAVAILABLE';
              const from = c.status; c.status = to; c.last_state_change_at = new Date().toISOString();
              if (p.errorCode && p.errorCode !== 'NoError') {
                const fid = ++store.seq.fault;
                store.faults.set(fid, { fault_id: fid, connector_ref: `${cpId}:${p.connectorId}`, cp_id: cpId, error_code: p.errorCode, severity: 'WARN', source: 'OCPP', description: p.info || null, reported_by: null, reported_at: new Date().toISOString(), cleared_at: null });
              }
              store.emitOutbox('CONNECTOR_STATE', `ocpp:${cpId}:${p.connectorId}:${Date.now()}`, { connector_ref: `${cpId}:${p.connectorId}`, from, to, cause: 'OCPP' });
              store.stateEvents.push({ ts: new Date().toISOString(), connector_ref: `${cpId}:${p.connectorId}`, from_state: from, to_state: to, cause: 'OCPP', session_id: null });
            }
            ws.send(result(msg.uid, {}));
            break;
          }
          case 'Authorize': {
            const ok = [...store.users.values()].some(u => u.user_id === Number(p.idTag?.replace('TAG-', '')) || p.idTag);
            ws.send(result(msg.uid, { idTagInfo: { status: ok ? 'Accepted' : 'Invalid' } }));
            break;
          }
          case 'StartTransaction': {
            const tagUid = /^TAG-(\d+)$/.exec(p.idTag || '');
            const uid = tagUid ? Number(tagUid[1]) : 1;
            const sess = await store.startSession({ uid: store.users.has(uid) ? uid : 1, vehicleId: null, cpId, connNo: p.connectorId, planId: 2, reservationId: null, idTag: p.idTag });
            ws.send(result(msg.uid, { transactionId: sess.session_id, idTagInfo: { status: 'Accepted' } }));
            break;
          }
          case 'MeterValues': {
            const tx = p.transactionId;
            const vals = [...(p.meterValue || [])].flatMap(mv => mv.sampledValue || []);
            const e = vals.find(v => v.measurand === 'Energy.Active.Import.Register');
            const pr = vals.find(v => v.measurand === 'Power.Active.Import');
            if (tx && e) await store.recordTick(tx, Date.now() % 100000, new Date().toISOString(), Number(e.value) / 1000, pr ? Number(pr.value) / 1000 : null, null, null);
            ws.send(result(msg.uid, {}));
            break;
          }
          case 'StopTransaction': {
            if (p.transactionId) {
              const sess = store.sessions.get(Number(p.transactionId));
              if (sess) { sess.end_meter_kwh = Number(p.meterStop) / 1000 || sess.end_meter_kwh; await store.transition(p.transactionId, 'COMPLETED', 'OCPP_STOP'); }
            }
            ws.send(result(msg.uid, { idTagInfo: { status: 'Accepted' } }));
            break;
          }
          default:
            ws.send(callError(msg.uid, 'NotSupported', msg.action));
        }
      } catch (e) { ws.send(callError(msg.uid, 'InternalError', e.message)); }
    });
    ws.on('close', () => {
      registry.delete(identity);
      cp.status = 'OFFLINE';
      log.info({ identity }, 'ocpp disconnected');
    });
  });
  return registry;
}

module.exports = { mountOcpp };
