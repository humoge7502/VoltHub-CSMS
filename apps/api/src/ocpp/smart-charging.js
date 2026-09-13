// OCPP 1.6 Smart Charging module (blueprint Phase 2 / ADR-0010): CSMS->CP
// SetChargingProfile / ClearChargingProfile / GetCompositeSchedule dispatch with
// the optimizer-INDEPENDENT safety envelope (I.5-H3) and idempotent profile-push
// audit (V007 charging_profile_push). The envelope consults nothing above it:
// even a compromised optimizer cannot push a profile past the certified caps.
'use strict';
const crypto = require('crypto');
const { call } = require('@volthub/ocpp-messages');
const { envelopeCheck } = require('../control/controller');

let __callUid = 900000;
function nextCallId() {
  return `sc-${Date.now().toString(36)}-${++__callUid}`;
}

function socketFor(registry, identity) {
  const ws = registry?.get?.(identity);
  return ws && ws.readyState === 1 ? ws : null;
}

// Push a compiled charging profile to one charge point. Order of operations is
// the security story (N.2): envelope check -> audit row (idempotent per
// (cp,decision)) -> wire send -> ack correlation. A rejected push is dead-lettered.
function setChargingProfile(store, registry, log, { cpId, identity, profile, decisionId, payloadSha256, clamped }) {
  const ident = identity || store.cps.get(Number(cpId))?.ocpp_identity;
  const ws = socketFor(registry, ident);
  if (!ws) {
    const e = new Error(`CP_OFFLINE: ${ident} not connected`);
    e.code = 'CP_OFFLINE';
    e.status = 409;
    return Promise.reject(e);
  }
  // 1) Envelope: hard caps derived from certified grid assets (never the optimizer).
  const env = envelopeCheck(store, cpId, profile);
  if (!env.ok) {
    store.deadLetter({
      eventRef: `push:${Number(cpId)}:${Number(decisionId)}`,
      kind: 'PROFILE_PUSH',
      reasonCode: 'ENVELOPE_REJECTED',
      detail: env.error.message,
      payload: profile,
    });
    store.auditLog(null, 'CHARGING_PROFILE', Number(cpId), 'ENVELOPE_REJECT', null, env.error.message);
    const err = new Error(env.error.message);
    err.num = env.error.num;
    err.code = env.error.code;
    err.status = env.error.status;
    return Promise.reject(err);
  }
  // 2) Idempotent audit row (uq_push_cp_decision parity) — retries are safe.
  const { row } = store.recordProfilePush({
    decisionId,
    cpId: Number(cpId),
    profilePayload: JSON.stringify(profile),
    payloadSha256: payloadSha256 || crypto.createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
    clamped,
  });
  // 3) Wire. Profile-change rate governance: max 6 pushes/min per CP (N.1) —
  // a compromised control plane cannot hammer hardware with profile churn.
  const now = Date.now();
  ws.__pushTimes = (ws.__pushTimes || []).filter((t) => now - t < 60000);
  ws.__pushTimes.push(now);
  if (ws.__pushTimes.length > 6) {
    store.deadLetter({
      eventRef: `push-rate:${Number(cpId)}:${now}`,
      kind: 'PROFILE_PUSH',
      reasonCode: 'RATE_LIMITED',
      detail: 'profile push rate limit 6/min per charge point',
      payload: { cpId: Number(cpId) },
    });
    const err = new Error('PROFILE_RATE_LIMITED: max 6 profile pushes/min per charge point');
    err.code = 'PROFILE_RATE_LIMITED';
    err.status = 429;
    return Promise.reject(err);
  }
  const uid = nextCallId();
  try {
    ws.send(call(uid, 'SetChargingProfile', { connectorId: 0, csChargingProfiles: profile }));
  } catch (e) {
    return Promise.reject(e);
  }
  if (log && typeof log.info === 'function')
    log.info({ identity: ident, cpId, decisionId }, 'ocpp SetChargingProfile sent');
  return Promise.resolve({ uid, push_id: row.push_id, identity: ident });
}

function clearChargingProfile(registry, identity, { profileId, connectorId } = {}) {
  const ws = socketFor(registry, identity);
  if (!ws) {
    const e = new Error(`CP_OFFLINE: ${identity} not connected`);
    e.code = 'CP_OFFLINE';
    e.status = 409;
    return Promise.reject(e);
  }
  const uid = nextCallId();
  const payload = {};
  if (profileId != null) payload.id = Number(profileId);
  if (connectorId != null) payload.connectorId = Number(connectorId);
  ws.send(call(uid, 'ClearChargingProfile', payload));
  return Promise.resolve({ uid, identity });
}

function getCompositeSchedule(registry, identity, { connectorId = 0, duration = 3600 } = {}) {
  const ws = socketFor(registry, identity);
  if (!ws) {
    const e = new Error(`CP_OFFLINE: ${identity} not connected`);
    e.code = 'CP_OFFLINE';
    e.status = 409;
    return Promise.reject(e);
  }
  const uid = nextCallId();
  ws.send(
    call(uid, 'GetCompositeSchedule', { connectorId: Number(connectorId), duration: Number(duration), unit: 'W' })
  );
  return Promise.resolve({ uid, identity });
}

module.exports = { setChargingProfile, clearChargingProfile, getCompositeSchedule };
