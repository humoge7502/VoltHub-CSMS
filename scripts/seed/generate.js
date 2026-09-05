// Deterministic seed runner: drives the same store packages the API uses
// (coherent by construction), prints volumes. Full volume via SEED_PROFILE=full.
'use strict';
const fs = require('fs');
const path = require('path');
const { createStore } = require('../../apps/api/src/db/store');
const { seedStore } = require('../../apps/api/src/db/seed');

const profile = process.env.SEED_PROFILE || 'demo';
const s = createStore();
const stats = seedStore(s, profile);

// Coherence self-check: seed must satisfy the same invariants CI enforces
// (db/oracle/invariants.sql). Deterministic RNG + package-mirroring logic
// should make violations impossible — fail loudly if that ever changes.
const violations = [];
const overlap = [...s.reservations.values()].filter((a) =>
  [...s.reservations.values()].some(
    (b) =>
      b.reservation_id > a.reservation_id &&
      b.connector_ref === a.connector_ref &&
      ['BOOKED', 'CONVERTED'].includes(b.status) &&
      ['BOOKED', 'CONVERTED'].includes(a.status) &&
      new Date(b.start_at) < new Date(a.end_at) &&
      new Date(b.end_at) > new Date(a.start_at)
  )
);
if (overlap.length) violations.push(`overlap x${overlap.length}`);
for (const [uid, w] of s.wallets) {
  const sum = s.ledgers.filter((l) => l.user_id === uid).reduce((t, l) => t + l.amount, 0);
  if (Math.abs(sum - w.balance) > 0.005) violations.push(`ledger drift user ${uid}`);
}
for (const inv of s.invoices.values()) {
  if (['PAID', 'DUE'].includes(inv.status) && s.sessions.get(inv.session_id)?.state !== 'COMPLETED')
    violations.push(`invoice ${inv.invoice_id} w/o COMPLETED`);
  if (inv.status === 'PAID') {
    const lines = s.lines.filter((l) => l.invoice_id === inv.invoice_id).reduce((t, l) => t + l.amount, 0);
    if (Math.abs(lines - inv.total) > 0.005) violations.push(`invoice ${inv.invoice_id} total != lines`);
  }
}
const bySess = new Map();
for (const t of s.readings) {
  if (!bySess.has(t.session_id)) bySess.set(t.session_id, []);
  bySess.get(t.session_id).push(t);
}
for (const [sid, arr] of bySess) {
  arr.sort((a, b) => a.seq_no - b.seq_no);
  for (let i = 1; i < arr.length; i++)
    if (arr[i].meter_kwh < arr[i - 1].meter_kwh - 0.001) violations.push(`meter regression session ${sid}`);
}
if (violations.length) {
  console.error('SEED INVARIANTS FAILED:', violations.slice(0, 10));
  process.exit(1);
}
console.log(
  `seed invariants: 0 violations (${s.reservations.size} res, ${s.sessions.size} sess, ${s.invoices.size} inv)`
);
const out = path.join(__dirname, '..', '..', 'data', `seed-${profile}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
const dump = {
  users: [...s.users.values()].map((u) => ({ ...u, password_hash: 'REDACTED' })),
  stations: [...s.stations.values()],
  connectors: [...s.connectors.values()],
  plans: [...s.plans.values()],
  bands: s.bands,
  sessions: [...s.sessions.values()],
  invoices: [...s.invoices.values()],
};
fs.writeFileSync(out, JSON.stringify(dump, null, 1));
console.log(`seed(${profile}):`, stats, '->', out);
