// OCPP 1.6J WebSocket gateway: 1 socket per charge point, 10 msg/s/CP.
// Handles Boot/Heartbeat/Status/Authorize/Start/Meter/Stop; mirrors connector
// state into the store (CLIENT_IDENTIFIER='ocpp-gw' equivalent) exactly like
// the Oracle trigger expects in prod.
// SEC-003: OCPP 1.6 Security Profile 1 — HTTP Basic on upgrade (username=ocpp_identity,
// password=charge_point.auth_secret). Enforced when the CP has a secret or OCPP_AUTH=require.
'use strict';
const crypto = require('crypto');
const { parse, result, call, callError } = require('@volthub/ocpp-messages');

let __callUid = 0;
function nextCallId() {
  return `csms-${Date.now().toString(36)}-${++__callUid}`;
}

// B2G-009: CSMS→CP remote commands (half-duplex fix). Fire-and-forget CALL over the
// stored socket; the CP answers with CALLRESULT (handled in the RESULT branch below).
// Currently used by POST /sessions/:id/remote-stop; RemoteStart shares the plumbing.
function stopTransaction(registry, identity, sessionId, log) {
  const ws = registry?.get?.(identity);
  if (!ws || ws.readyState !== 1) {
    const e = new Error(`CP_OFFLINE: ${identity} not connected`);
    e.code = 'CP_OFFLINE';
    e.status = 409;
    return Promise.reject(e);
  }
  const uid = nextCallId();
  try {
    ws.send(call(uid, 'RemoteStopTransaction', { transactionId: Number(sessionId) }));
  } catch (e) {
    return Promise.reject(e);
  }
  // B3G-001: method-call form preserves pino `this` (detached log.info throws msgPrefix TypeError).
  if (log && typeof log.info === 'function') log.info({ identity, sessionId }, 'ocpp RemoteStopTransaction sent');
  return Promise.resolve({ uid, identity, transactionId: Number(sessionId) });
}
function startTransaction(registry, identity, idTag, connectorId, log) {
  const ws = registry?.get?.(identity);
  if (!ws || ws.readyState !== 1) {
    const e = new Error(`CP_OFFLINE: ${identity} not connected`);
    e.code = 'CP_OFFLINE';
    e.status = 409;
    return Promise.reject(e);
  }
  const uid = nextCallId();
  try {
    ws.send(call(uid, 'RemoteStartTransaction', { idTag, connectorId: Number(connectorId) }));
  } catch (e) {
    return Promise.reject(e);
  }
  if (log && typeof log.info === 'function') log.info({ identity, idTag }, 'ocpp RemoteStartTransaction sent');
  return Promise.resolve({ uid, identity });
}

function checkBasic(req, identity, cp) {
  const secret = cp?.auth_secret;
  const mode = process.env.OCPP_AUTH || 'per-cp'; // per-cp | require | off
  if (mode === 'off') return true;
  if (!secret && mode !== 'require') return true; // legacy CPs without secret (dev/seeds migrating)
  const h = String(req.headers?.authorization || '');
  const m = /^Basic (.+)$/.exec(h);
  if (!m) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  const user = decoded.slice(0, idx),
    pass = decoded.slice(idx + 1);
  if (user !== identity) return false;
  const a = Buffer.from(pass),
    b = Buffer.from(String(secret || ''));
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function mountOcpp(wss, store, log) {
  const registry = new Map(); // ocpp_identity -> ws
  const lastMsg = new Map();
  const seqByTx = new Map(); // BUG-006: monotonic per-session seq (OCPP has no seq; gateway owns it)

  wss.on('connection', (ws, req) => {
    const m = String(req.url || '').match(/\/ocpp\/([^/?]+)/);
    const identity = m ? decodeURIComponent(m[1]) : null;
    if (!identity || !store.cpsByOcpp.has(identity)) {
      ws.close(4404, 'unknown charge point identity');
      return;
    }
    const cpId = store.cpsByOcpp.get(identity);
    const cp = store.cps.get(cpId);
    if (!checkBasic(req, identity, cp)) {
      try {
        ws.close(4401, 'ocpp basic auth required (Security Profile 1)');
      } catch {}
      // Method-call form: a detached `(log.warn || log.info)(...)` loses pino `this`
      // and throws under pino 9/10 (B3G-001) — always call as a method.
      log.warn({ identity }, 'ocpp rejected: bad basic auth');
      return;
    }
    cp.status = 'ONLINE';
    cp.last_seen_at = new Date().toISOString();
    // Duplicate connection: close the stale socket so one identity == one socket (OCPP 1.6J §4).
    const prev = registry.get(identity);
    if (prev && prev !== ws) {
      try {
        prev.close(4400, 'duplicate charge point identity');
      } catch {}
    }
    registry.set(identity, ws);
    log.info({ identity }, 'ocpp connected');

    ws.on('message', async (raw) => {
      // rate limit 10/s per CP
      const now = Date.now();
      const arr = (lastMsg.get(identity) || []).filter((t) => now - t < 1000);
      arr.push(now);
      lastMsg.set(identity, arr);
      if (arr.length > 10) {
        ws.send(callError('0', 'FormationViolation', 'rate limit 10 msg/s per charge point'));
        return;
      }
      let msg;
      try {
        msg = parse(raw);
      } catch {
        ws.send(callError('0', 'FormationViolation'));
        return;
      }
      // B2G-009: CSMS-initiated CALLs get CALLRESULT/CALLERROR answers — log and drop.
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
              const map = {
                Available: 'AVAILABLE',
                Occupied: 'OCCUPIED',
                Reserved: 'RESERVED',
                Faulted: 'FAULTED',
                Unavailable: 'UNAVAILABLE',
              };
              const to = map[p.status] || 'UNAVAILABLE';
              const from = c.status;
              c.status = to;
              c.last_state_change_at = new Date().toISOString();
              if (p.errorCode && p.errorCode !== 'NoError') {
                const fid = ++store.seq.fault;
                store.faults.set(fid, {
                  fault_id: fid,
                  connector_ref: `${cpId}:${p.connectorId}`,
                  cp_id: cpId,
                  error_code: p.errorCode,
                  severity: 'WARN',
                  source: 'OCPP',
                  description: p.info || null,
                  reported_by: null,
                  reported_at: new Date().toISOString(),
                  cleared_at: null,
                });
              }
              store.emitOutbox('CONNECTOR_STATE', `ocpp:${cpId}:${p.connectorId}:${Date.now()}`, {
                connector_ref: `${cpId}:${p.connectorId}`,
                from,
                to,
                cause: 'OCPP',
              });
              store.stateEvents.push({
                ts: new Date().toISOString(),
                connector_ref: `${cpId}:${p.connectorId}`,
                from_state: from,
                to_state: to,
                cause: 'OCPP',
                session_id: null,
              });
            }
            ws.send(result(msg.uid, {}));
            break;
          }
          case 'Authorize': {
            // BUG-002 fix: allow-list only. TAG-<user_id> of an existing user => Accepted, else Invalid.
            const m2 = /^TAG-(\d+)$/.exec(String(p.idTag || ''));
            const ok = !!(m2 && store.users.has(Number(m2[1])));
            ws.send(result(msg.uid, { idTagInfo: { status: ok ? 'Accepted' : 'Invalid' } }));
            break;
          }
          case 'StartTransaction': {
            const tagUid = /^TAG-(\d+)$/.exec(p.idTag || '');
            // BUG-002 follow-on: reject unknown tags instead of silently billing user 1.
            if (!tagUid || !store.users.has(Number(tagUid[1]))) {
              ws.send(result(msg.uid, { transactionId: 0, idTagInfo: { status: 'Invalid' } }));
              break;
            }
            const uid = Number(tagUid[1]);
            const sess = await store.startSession({
              uid,
              vehicleId: null,
              cpId,
              connNo: p.connectorId,
              planId: store.defaultPlanId ? store.defaultPlanId() : 2,
              reservationId: null,
              idTag: p.idTag,
            });
            seqByTx.set(sess.session_id, 0);
            ws.send(result(msg.uid, { transactionId: sess.session_id, idTagInfo: { status: 'Accepted' } }));
            break;
          }
          case 'MeterValues': {
            const tx = p.transactionId;
            const vals = [...(p.meterValue || [])].flatMap((mv) => mv.sampledValue || []);
            const e = vals.find((v) => v.measurand === 'Energy.Active.Import.Register');
            const pr = vals.find((v) => v.measurand === 'Power.Active.Import');
            // BUG-006 fix: monotonic per-session counter, never Date.now() (collides + breaks (session_id,seq_no) PK).
            if (tx && e) {
              const next = (seqByTx.get(Number(tx)) || 0) + 1;
              seqByTx.set(Number(tx), next);
              await store.recordTick(
                tx,
                next,
                new Date().toISOString(),
                Number(e.value) / 1000,
                pr ? Number(pr.value) / 1000 : null,
                null,
                null
              );
            }
            ws.send(result(msg.uid, {}));
            break;
          }
          case 'StopTransaction': {
            if (p.transactionId) {
              const sess = store.sessions.get(Number(p.transactionId));
              if (sess) {
                // BUG-020 fix: 0 Wh is valid — only fall back when meterStop is absent/NaN.
                const stopKwh = Number(p.meterStop);
                sess.end_meter_kwh = Number.isFinite(stopKwh) ? stopKwh / 1000 : sess.end_meter_kwh;
                seqByTx.delete(Number(p.transactionId));
                await store.transition(p.transactionId, 'COMPLETED', 'OCPP_STOP');
              }
            }
            ws.send(result(msg.uid, { idTagInfo: { status: 'Accepted' } }));
            break;
          }
          default:
            ws.send(callError(msg.uid, 'NotSupported', msg.action));
        }
      } catch (e) {
        ws.send(callError(msg.uid, 'InternalError', e.message));
      }
    });
    ws.on('close', () => {
      // BUG-021: only the socket that OWNS the registry slot may deregister it.
      // When a CP reconnects, the gateway closes the stale predecessor (above) —
      // that predecessor's close event must NOT delete the successor's registration
      // or flip the live CP to OFFLINE (remote commands resolve via registry.get).
      if (registry.get(identity) === ws) {
        registry.delete(identity);
        cp.status = 'OFFLINE';
      }
      log.info({ identity }, 'ocpp disconnected');
    });
  });
  return registry;
}

module.exports = { mountOcpp, checkBasic, stopTransaction, startTransaction };
