// Typed OCPP 1.6J message helpers (JSON-WS: [MessageTypeId, UniqueId, Action|Payload]).
'use strict';
// MessageTypeId: 2=CALL, 3=CALLRESULT, 4=CALLERROR
function call(id, action, payload) { return JSON.stringify([2, id, action, payload || {}]); }
function result(id, payload) { return JSON.stringify([3, id, payload || {}]); }
function callError(id, code = 'InternalError', desc = '') {
  return JSON.stringify([4, id, code, desc, {}]);
}
function parse(raw) {
  const m = JSON.parse(String(raw));
  if (!Array.isArray(m) || m.length < 3) throw new Error('OCPP_MALFORMED');
  const [type, uid, a, b] = m;
  if (type === 2) return { kind: 'CALL', uid, action: a, payload: b || {} };
  if (type === 3) return { kind: 'RESULT', uid, payload: a || {} };
  if (type === 4) return { kind: 'ERROR', uid, code: a, desc: b };
  throw new Error('OCPP_BAD_TYPE');
}
const ACTIONS = ['BootNotification', 'Heartbeat', 'StatusNotification', 'Authorize',
  'StartTransaction', 'MeterValues', 'StopTransaction'];
module.exports = { call, result, callError, parse, ACTIONS };
