// Shared Oracle→HTTP error mapping (single truth; routes.js + extended.js import this).
// Bands: -20501→422, -2050x/-2060x/-2070x(money conflicts)→409, -20705→402.
'use strict';
function oraStatus(e) {
  if (!e) return 500;
  if (e.num === -20501) return 422;
  // B2G-013: -20505 RESERVATION_MISMATCH -> 409 (ownership/connector mismatch at session start).
  if ([-20502, -20503, -20504, -20505, -20601, -20602, -20603, -20702, -20703, -20704].includes(e.num)) return 409;
  if (e.num === -20705) return 402;
  // V007/ADR-0010: grid-control band — a rejected cap change is a conflict with
  // the current electrical state (409), a malformed asset/hierarchy is client error (422).
  if (e.num === -20901) return 422; // GRID_ASSET_INVALID
  if (e.num === -20902) return 409; // GRID_CAP_MONOTONIC
  if (e.num === -20903) return 409; // ENVELOPE_REJECTED (gateway safety envelope)
  return e.status || 500;
}

// Canonical store-error names by PL/SQL number — mirror of db/store.js's ORA table
// (single source of truth: the RAISE_APPLICATION_ERROR numbers in V003; both JS
// copies must stay in sync with it). BUG-043: fromDriver now restores the canonical
// code so package-raised errors carry the SAME e.code the local store throws —
// callers and tests key on 'OVERLAP'/'TICK_REJECTED'/…, never on 'ORA_20503'.
const ORA_CODE_BY_NUM = {
  20501: 'INVALID_WINDOW',
  20502: 'NOT_BOOKABLE',
  20503: 'OVERLAP',
  20504: 'CANCEL_CONFLICT',
  20505: 'RESERVATION_MISMATCH',
  20601: 'ILLEGAL_TRANSITION',
  20602: 'METER_REGRESSION',
  20603: 'TICK_REJECTED',
  20701: 'NO_TARIFF_BAND',
  20702: 'BILL_CONFLICT',
  20703: 'BILLING_CONFLICT',
  20704: 'PAY_CONFLICT',
  20705: 'INSUFFICIENT_FUNDS',
  20801: 'CONNECTOR_GUARD',
  // V007/ADR-0010: grid-control band (single truth with db/oracle/V007 + store.js ORA table).
  20901: 'GRID_ASSET_INVALID',
  20902: 'GRID_CAP_MONOTONIC',
  20903: 'ENVELOPE_REJECTED',
};
function oraError(num, code, message) {
  const e = new Error(message || code);
  e.num = num;
  e.code = code;
  e.status = oraStatus({ num });
  return e;
}
// Normalize node-oracledb driver errors (ORA-20503 in message) to {num, code, status}.
function fromDriver(e) {
  if (e && typeof e.num === 'number') {
    e.status = e.status || oraStatus(e);
    return e;
  }
  const m = /ORA-(\d{5})/.exec(String((e && e.message) || e || ''));
  if (m) {
    const num = -Number(m[1]);
    e.num = num;
    // BUG-043: restore the canonical store code (the package message already
    // carries the same name — the packages mirror the JS contract on purpose).
    e.code = ORA_CODE_BY_NUM[m[1]] || e.code || `ORA_${m[1]}`;
    e.status = e.status || oraStatus(e);
  }
  return e;
}
module.exports = { oraStatus, oraError, fromDriver };
