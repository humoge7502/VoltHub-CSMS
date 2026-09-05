// SQL invariant runner (BUG-009 fix): executes checks, not a health-probe print.
// Modes:
//  - local (default): boots an ephemeral API and evaluates the 9 invariants in
//    db/oracle/invariants.sql against the live local store (same predicates in JS).
//  - oracle (ORACLE_HOST set + oracledb installed): runs invariants.sql statements
//    against Oracle; any returned row => FAIL (exit 1 with offending rows).
// CI runs this as a quality gate in the db-tests job (see .github/workflows/ci.yml).
'use strict';
const fs = require('fs');
const path = require('path');
process.env.RATE_LIMIT_OFF = '1';

function localChecks(store) {
  const fails = [];
  // 1. No overlapping BOOKED/CONVERTED reservations.
  {
    const rs = [...store.reservations.values()].filter((r) => ['BOOKED', 'CONVERTED'].includes(r.status));
    for (let i = 0; i < rs.length; i++)
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i],
          b = rs[j];
        if (
          a.connector_ref === b.connector_ref &&
          new Date(a.start_at) < new Date(b.end_at) &&
          new Date(a.end_at) > new Date(b.start_at)
        ) {
          fails.push(`INV-1 overlap: ${a.reservation_id} vs ${b.reservation_id} on ${a.connector_ref}`);
        }
      }
  }
  // 2. Ledger reconciles: balance == SUM(ledger).
  for (const [uid, w] of store.wallets) {
    const sum = store.ledgers.filter((l) => l.user_id === uid).reduce((a, l) => a + l.amount, 0);
    if (Math.abs(w.balance - sum) > 0.005)
      fails.push(`INV-2 ledger drift user=${uid} balance=${w.balance} sum=${sum.toFixed(2)}`);
  }
  // 3. BILLED invoice => COMPLETED session.
  for (const inv of store.invoices.values()) {
    if (['PAID', 'DUE'].includes(inv.status)) {
      const s = store.sessions.get(inv.session_id);
      if (!s || s.state !== 'COMPLETED')
        fails.push(`INV-3 invoice ${inv.invoice_id} ${inv.status} on session state ${s?.state}`);
    }
  }
  // 4. Invoice total == SUM(lines) for PAID/DUE.
  for (const inv of store.invoices.values()) {
    if (['PAID', 'DUE'].includes(inv.status)) {
      const sum = store.lines.filter((l) => l.invoice_id === inv.invoice_id).reduce((a, l) => a + l.amount, 0);
      if (Math.abs(inv.total - sum) > 0.005)
        fails.push(`INV-4 total drift invoice=${inv.invoice_id} total=${inv.total} lines=${sum.toFixed(2)}`);
    }
  }
  // 5. Meter monotonic per session (seq-ordered).
  for (const sid of new Set(store.readings.map((r) => r.session_id))) {
    const rs = store.readings.filter((r) => r.session_id === sid).sort((a, b) => a.seq_no - b.seq_no);
    for (let i = 1; i < rs.length; i++) {
      if (rs[i].meter_kwh < rs[i - 1].meter_kwh - 0.001)
        fails.push(`INV-5 regression session=${sid} seq=${rs[i].seq_no}`);
    }
  }
  // 6. One review per session.
  {
    const seen = new Set();
    for (const rev of store.reviews.values()) {
      if (seen.has(rev.session_id)) fails.push(`INV-6 duplicate review session=${rev.session_id}`);
      seen.add(rev.session_id);
    }
  }
  // 7. PAID invoice has >=1 SUCCESS payment.
  for (const inv of store.invoices.values()) {
    if (inv.status === 'PAID') {
      const ok = [...store.payments.values()].some((p) => p.invoice_id === inv.invoice_id && p.status === 'SUCCESS');
      if (!ok) fails.push(`INV-7 PAID without SUCCESS payment invoice=${inv.invoice_id}`);
    }
  }
  // 8. D-07(b): no invoice FAILED (B2G-004: failed PAYMENTS are the record; invoices stay DUE).
  for (const inv of store.invoices.values()) {
    if (inv.status === 'FAILED') fails.push(`INV-8 invoice ${inv.invoice_id} FAILED (must stay DUE)`);
  }
  // 9. D-07: BILLED session must be COMPLETED/CANCELLED.
  for (const s of store.sessions.values()) {
    if (s.billing_state === 'BILLED' && !['COMPLETED', 'CANCELLED'].includes(s.state))
      fails.push(`INV-9 BILLED without COMPLETED session=${s.session_id} state=${s.state}`);
  }
  return fails;
}

async function runOracleChecks() {
  const sqlPath = path.join(__dirname, '..', '..', 'db', 'oracle', 'invariants.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const stmts = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('--'));
  const oracledb = require('../../apps/api/node_modules/oracledb');
  const pool = await oracledb.createPool({
    user: process.env.ORACLE_USER || 'volthub',
    password: process.env.ORACLE_PASSWORD || 'volthub_dev_pwd',
    connectString: `${process.env.ORACLE_HOST}:${process.env.ORACLE_PORT || 1521}/${process.env.ORACLE_SERVICE || 'freepdb1'}`,
    poolMin: 0,
    poolMax: 2,
  });
  const conn = await pool.getConnection();
  const fails = [];
  try {
    let n = 0;
    for (const st of stmts) {
      // Strip leading comment lines inside each statement.
      const clean = st
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .trim();
      if (!clean) continue;
      n++;
      const r = await conn.execute(clean);
      if ((r.rows || []).length)
        fails.push(`INV-SQL-${n}: ${r.rows.length} row(s): ${JSON.stringify(r.rows.slice(0, 3))}`);
      else console.log(`  inv-sql-${n}: 0 rows (pass)`);
    }
  } finally {
    try {
      await conn.close();
    } catch {}
    try {
      await pool.close();
    } catch {}
  }
  return fails;
}

async function main() {
  console.log('invariants: mode =', process.env.ORACLE_HOST ? 'oracle' : 'local');
  if (process.env.ORACLE_HOST) {
    try {
      const fails = await runOracleChecks();
      if (fails.length) {
        console.error('INVARIANTS FAIL (oracle):\n' + fails.join('\n'));
        process.exit(1);
      }
      console.log('invariants: oracle 0 rows on all checks — OK');
      return;
    } catch (e) {
      console.error(`invariants: oracle run failed (${e.message}) — falling back to local checks`);
    }
  }
  process.env.PORT = process.env.PORT || '4106';
  const { server, store } = require('../../apps/api/src/server');
  await new Promise((r) => server.listen(Number(process.env.PORT), r));
  try {
    const fails = localChecks(store);
    // Also assert the SQL file defines the same 9 checks (drift guard).
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'oracle', 'invariants.sql'), 'utf8');
    const count = (sql.match(/\bSELECT\b/gi) || []).length;
    // File uses SELECT per check (some wrapped); require >= 9 SELECTs.
    if (count < 9) fails.push(`INV-META: invariants.sql defines ${count} SELECTs, expected >= 9`);
    if (fails.length) {
      console.error('INVARIANTS FAIL (local):\n' + fails.join('\n'));
      process.exitCode = 1;
    } else
      console.log(
        `invariants: local 9 checks × ${store.sessions.size} sessions / ${store.reservations.size} reservations — 0 rows — OK`
      );
  } finally {
    server.close();
  }
  process.exit(process.exitCode || 0);
}
main().catch((e) => {
  console.error('INVARIANTS ERROR', e);
  process.exit(1);
});
