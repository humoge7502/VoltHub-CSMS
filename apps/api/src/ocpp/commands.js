// OCPP 1.6J CSMS→CP management command suite (ADR-0018).
//
// ADR-0007 shipped exactly two calls (RemoteStop/RemoteStart) because actuation was
// fire-and-forget. This module completes the management surface a real CSMS needs:
// Reset, UnlockConnector, Change/GetConfiguration, TriggerMessage, ReserveNow,
// CancelReservation, ClearCache and DataTransfer. The important difference from the
// early RemoteStop implementation is that every command here is AWAITED: a charge
// point's `Rejected` is returned to the operator as a failure, not logged as success.
//
// Safety contract:
//   * allow-listed actions and fields only (no payload smuggling into the charger);
//   * bounded strings/ints (a 256 KB frame limit is still too much config to trust);
//   * one in-flight promise per call id, settled by CALLRESULT/CALLERROR or timeout;
//   * reserved/availability commands never mutate CSMS state here — the charge point
//     is the authority for its own connector hardware, while the CSMS remains the
//     authority for sessions and bookings (see ADR-0018 consequences).
'use strict';
const { call } = require('@volthub/ocpp-messages');
const { registerPendingCall, cancelPendingCall, ACK_TIMEOUT_MS } = require('./gateway');

let __callUid = 700000;
function nextCallId() {
  return `cmd-${Date.now().toString(36)}-${++__callUid}`;
}

const TRIGGER_MESSAGES = [
  'BootNotification',
  'DiagnosticStatusNotification',
  'FirmwareStatusNotification',
  'Heartbeat',
  'MeterValues',
  'StatusNotification',
];

const RESET_TYPES = ['Soft', 'Hard'];
const AVAILABILITY_TYPES = ['Operative', 'Inoperative'];

// Success statuses per OCPP 1.6. Any other status is a protocol-level refusal.
const ACCEPTED = {
  Reset: ['Accepted'],
  UnlockConnector: ['Unlocked'],
  ChangeAvailability: ['Accepted', 'Scheduled'],
  GetConfiguration: null, // no status field in the response
  ChangeConfiguration: ['Accepted', 'RebootRequired'],
  TriggerMessage: ['Accepted'],
  ReserveNow: ['Accepted'],
  CancelReservation: ['Accepted'],
  ClearCache: ['Accepted'],
  DataTransfer: ['Accepted'],
};

function bad(message, field) {
  const e = new Error(message);
  e.code = 'VALIDATION';
  e.status = 400;
  if (field) e.field = field;
  return e;
}

function int(value, field, min = 0, max = 65535) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${field} must be an integer ${min}..${max}`, field);
  return n;
}

function str(value, field, { min = 1, max = 512, optional = false } = {}) {
  if (value == null || value === '') {
    if (optional) return undefined;
    throw bad(`${field} is required`, field);
  }
  if (typeof value !== 'string') throw bad(`${field} must be a string`, field);
  const s = value.trim();
  if (s.length < min || s.length > max) throw bad(`${field} must be ${min}..${max} characters`, field);
  return s;
}

function iso(value, field) {
  const s = str(value, field, { max: 64 });
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw bad(`${field} must be an ISO-8601 timestamp`, field);
  return new Date(t).toISOString();
}

function enumValue(value, field, allowed, fallback) {
  if (value == null && fallback !== undefined) return fallback;
  if (!allowed.includes(value)) throw bad(`${field} must be one of ${allowed.join(', ')}`, field);
  return value;
}

function pick(body, allowed) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  for (const k of Object.keys(src)) if (!allowed.includes(k)) throw bad(`unknown field: ${k}`, k);
  return src;
}

// Build a validated OCPP payload from an untrusted REST body. Returns
// { action, payload, expectsStatus, acceptedStatuses } or throws a 400.
function buildCommand(rawAction, body) {
  const action = String(rawAction || '')
    .trim()
    .toLowerCase();
  switch (action) {
    case 'reset': {
      const b = pick(body, ['type']);
      return {
        action: 'Reset',
        payload: { type: enumValue(b.type, 'type', RESET_TYPES, 'Soft') },
        expectsStatus: true,
        acceptedStatuses: ACCEPTED.Reset,
      };
    }
    case 'unlockconnector': {
      const b = pick(body, ['connectorId']);
      return {
        action: 'UnlockConnector',
        payload: { connectorId: int(b.connectorId, 'connectorId', 1) },
        expectsStatus: true,
        acceptedStatuses: ACCEPTED.UnlockConnector,
      };
    }
    case 'changeavailability': {
      const b = pick(body, ['connectorId', 'type']);
      return {
        action: 'ChangeAvailability',
        payload: {
          connectorId: int(b.connectorId, 'connectorId', 0),
          type: enumValue(b.type, 'type', AVAILABILITY_TYPES),
        },
        expectsStatus: true,
        acceptedStatuses: ACCEPTED.ChangeAvailability,
      };
    }
    case 'getconfiguration': {
      const b = pick(body, ['key']);
      let key;
      if (b.key !== undefined) {
        if (!Array.isArray(b.key) || b.key.length > 50) throw bad('key must be an array of ≤50 strings', 'key');
        key = b.key.map((k, i) => str(k, `key[${i}]`, { max: 50 }));
      }
      return {
        action: 'GetConfiguration',
        payload: key ? { key } : {},
        expectsStatus: false,
        acceptedStatuses: null,
      };
    }
    case 'changeconfiguration': {
      const b = pick(body, ['key', 'value']);
      return {
        action: 'ChangeConfiguration',
        payload: {
          key: str(b.key, 'key', { max: 50 }),
          value: str(b.value, 'value', { max: 500 }),
        },
        expectsStatus: true,
        acceptedStatuses: ACCEPTED.ChangeConfiguration,
      };
    }
    case 'triggermessage': {
      const b = pick(body, ['requestedMessage', 'connectorId']);
      const payload = { requestedMessage: enumValue(b.requestedMessage, 'requestedMessage', TRIGGER_MESSAGES) };
      if (b.connectorId !== undefined) payload.connectorId = int(b.connectorId, 'connectorId', 0);
      return {
        action: 'TriggerMessage',
        payload,
        expectsStatus: true,
        acceptedStatuses: ACCEPTED.TriggerMessage,
      };
    }
    case 'reservenow': {
      const b = pick(body, ['connectorId', 'expiryDate', 'idTag', 'parentIdTag', 'reservationId']);
      const payload = {
        connectorId: int(b.connectorId, 'connectorId', 0),
        expiryDate: iso(b.expiryDate, 'expiryDate'),
        idTag: str(b.idTag, 'idTag', { max: 20 }),
        reservationId: int(b.reservationId, 'reservationId', 1, 2147483647),
      };
      const parent = str(b.parentIdTag, 'parentIdTag', { max: 20, optional: true });
      if (parent) payload.parentIdTag = parent;
      return {
        action: 'ReserveNow',
        payload,
        expectsStatus: true,
        acceptedStatuses: ACCEPTED.ReserveNow,
      };
    }
    case 'cancelreservation': {
      const b = pick(body, ['reservationId']);
      return {
        action: 'CancelReservation',
        payload: { reservationId: int(b.reservationId, 'reservationId', 1, 2147483647) },
        expectsStatus: true,
        acceptedStatuses: ACCEPTED.CancelReservation,
      };
    }
    case 'clearcache': {
      pick(body, []);
      return { action: 'ClearCache', payload: {}, expectsStatus: true, acceptedStatuses: ACCEPTED.ClearCache };
    }
    case 'datatransfer': {
      const b = pick(body, ['vendorId', 'messageId', 'data']);
      const payload = { vendorId: str(b.vendorId, 'vendorId', { max: 255 }) };
      const messageId = str(b.messageId, 'messageId', { max: 50, optional: true });
      const data = str(b.data, 'data', { max: 4096, optional: true });
      if (messageId) payload.messageId = messageId;
      if (data) payload.data = data;
      return {
        action: 'DataTransfer',
        payload,
        expectsStatus: true,
        acceptedStatuses: ACCEPTED.DataTransfer,
      };
    }
    default:
      throw bad(`unknown OCPP command: ${rawAction}`, 'action');
  }
}

function catalog() {
  return {
    commands: Object.keys(ACCEPTED).map((action) => ({
      action,
      accepted_statuses: ACCEPTED[action],
      // Advisory, not enforcement: the route validates the same shape below.
      payload:
        action === 'Reset'
          ? { type: 'Soft|Hard' }
          : action === 'UnlockConnector'
            ? { connectorId: 'integer ≥1' }
            : action === 'ChangeAvailability'
              ? { connectorId: 'integer ≥0', type: 'Operative|Inoperative' }
              : action === 'GetConfiguration'
                ? { key: 'optional string[]' }
                : action === 'ChangeConfiguration'
                  ? { key: 'string', value: 'string' }
                  : action === 'TriggerMessage'
                    ? { requestedMessage: TRIGGER_MESSAGES.join('|'), connectorId: 'optional integer ≥0' }
                    : action === 'ReserveNow'
                      ? {
                          connectorId: 'integer ≥0',
                          expiryDate: 'ISO-8601',
                          idTag: 'string ≤20',
                          parentIdTag: 'optional string ≤20',
                          reservationId: 'positive integer',
                        }
                      : action === 'CancelReservation'
                        ? { reservationId: 'positive integer' }
                        : action === 'DataTransfer'
                          ? { vendorId: 'string', messageId: 'optional string', data: 'optional string' }
                          : {},
    })),
  };
}

function commandError(code, message, status) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

// Send one command and await the charge point's answer. The pending-call entry is
// registered BEFORE the frame is written so an extremely fast CALLRESULT cannot race
// the registration (the old RemoteStop path registered after ws.send).
function send(store, registry, log, { cpId, action, payload, timeoutMs, expectsStatus = true }) {
  const cp = store.cps.get(Number(cpId));
  if (!cp) return Promise.reject(commandError('NOT_FOUND', 'charge point', 404));
  const identity = cp.ocpp_identity;
  const ws = registry?.get?.(identity);
  if (!ws || ws.readyState !== 1) {
    return Promise.reject(commandError('CP_OFFLINE', `${identity} is not connected`, 409));
  }
  const uid = nextCallId();
  const waitMs = Math.max(50, Number(timeoutMs) || ACK_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    // The gateway sweeper also settles pending calls. This timer covers the window
    // between sweeps and guarantees the HTTP request cannot hang past its budget.
    timer = setTimeout(() => {
      if (settled) return;
      cancelPendingCall(uid);
      finish(reject, commandError('CP_TIMEOUT', `no CALLRESULT within ${waitMs} ms`, 504));
    }, waitMs + 25);
    if (typeof timer.unref === 'function') timer.unref();
    registerPendingCall(uid, {
      action,
      cpId: Number(cpId),
      identity,
      expectsStatus,
      deadline: Date.now() + waitMs,
      resolve: (response) => finish(resolve, response),
      reject: (err) => finish(reject, err),
    });
    try {
      ws.send(call(uid, action, payload || {}));
    } catch (e) {
      cancelPendingCall(uid);
      finish(reject, commandError('CP_SEND_FAILED', e.message || 'websocket send failed', 502));
      return;
    }
    if (log && typeof log.info === 'function')
      log.info({ identity, cpId: Number(cpId), action, uid }, 'ocpp management command sent');
  }).then((response) => {
    const accepted = response.status == null ? true : (ACCEPTED[action] || []).includes(response.status);
    if (!accepted) {
      const e = commandError('OCPP_REJECTED', `${action} answered ${response.status}`, 409);
      e.ocpp = response;
      e.status = 409;
      throw e;
    }
    return {
      uid: response.uid,
      action,
      cp_id: Number(cpId),
      identity,
      status: response.status,
      accepted: true,
      ack: response.ack,
      payload: response.payload,
    };
  });
}

module.exports = {
  buildCommand,
  catalog,
  send,
  ACCEPTED,
  TRIGGER_MESSAGES,
};
