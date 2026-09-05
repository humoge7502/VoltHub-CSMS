// Shared validation + types (mirrors packages/shared Zod schemas in TS prod;
// plain-JS runtime used by api/worker/simulator so `npm install` stays light).
'use strict';

const ROLES = ['DRIVER', 'OPERATOR', 'ADMIN'];
const STATES = {
  connector: ['AVAILABLE', 'OCCUPIED', 'RESERVED', 'FAULTED', 'OFFLINE', 'UNAVAILABLE'],
  session: ['RESERVED', 'PREPARING', 'CHARGING', 'SUSPENDED', 'COMPLETED', 'CANCELLED', 'FAILED'],
  reservation: ['BOOKED', 'CONVERTED', 'CANCELLED', 'EXPIRED'],
};

function assert(cond, code, message, status = 422) {
  if (!cond) { const e = new Error(message); e.code = code; e.status = status; throw e; }
}

function vEmail(s) { return typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s); }

function vRegister(b) {
  assert(vEmail(b.email), 'INVALID_EMAIL', 'valid email required');
  assert(typeof b.password === 'string' && b.password.length >= 8, 'WEAK_PASSWORD', 'password >= 8 chars');
  assert(typeof b.full_name === 'string' && b.full_name.length >= 2, 'INVALID_NAME', 'full_name required');
}
function vReservation(b) {
  assert(Number.isInteger(b.cpId) && Number.isInteger(b.connectorNo), 'INVALID_CONNECTOR', 'cpId + connectorNo required');
  const s = new Date(b.startAt), e = new Date(b.endAt);
  assert(!isNaN(s) && !isNaN(e) && e > s, 'INVALID_WINDOW', 'endAt must be after startAt');
  const mins = (e - s) / 60000;
  assert(mins >= 15 && mins <= 120, 'INVALID_WINDOW', 'window must be 15-120 min', 422);
  assert(s.getTime() > Date.now() - 60000, 'INVALID_WINDOW', 'startAt must be in the future', 422);
}
function vVehicle(b) {
  assert(typeof b.make === 'string' && b.make.length > 0, 'INVALID_VEHICLE', 'make required');
  assert(typeof b.model === 'string' && b.model.length > 0, 'INVALID_VEHICLE', 'model required');
  const kwh = Number(b.battery_kwh);
  assert(kwh >= 5 && kwh <= 250, 'INVALID_VEHICLE', 'battery_kwh 5..250');
}

const LEGAL = {
  RESERVED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['CHARGING', 'FAILED', 'CANCELLED'],
  CHARGING: ['SUSPENDED', 'COMPLETED', 'FAILED'],
  SUSPENDED: ['CHARGING', 'COMPLETED', 'FAILED'],
};
function legalTransition(from, to) { return (LEGAL[from] || []).includes(to); }

module.exports = { ROLES, STATES, assert, vEmail, vRegister, vReservation, vVehicle, legalTransition };
