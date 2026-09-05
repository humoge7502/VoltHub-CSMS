// Shared Oracle→HTTP error mapping (single truth; routes.js + extended.js import this).
// Bands: -20501→422, -2050x/-2060x/-2070x(money conflicts)→409, -20705→402.
'use strict';
function oraStatus(e) {
  if (!e) return 500;
  if (e.num === -20501) return 422;
  // B2G-013: -20505 RESERVATION_MISMATCH -> 409 (ownership/connector mismatch at session start).
  if ([-20502, -20503, -20504, -20505, -20601, -20602, -20603, -20702, -20703, -20704].includes(e.num)) return 409;
  if (e.num === -20705) return 402;
  return e.status || 500;
}
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
    e.code = e.code || `ORA_${m[1]}`;
    e.status = e.status || oraStatus(e);
  }
  return e;
}
module.exports = { oraStatus, oraError, fromDriver };
