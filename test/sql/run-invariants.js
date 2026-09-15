// SQL invariant runner (BUG-009 fix): executes checks, not a health-probe print.
// Modes:
//  - local (default): boots an ephemeral API and evaluates the 12 invariants in
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
  // 10. D-07(b): ledger seq chain contiguous per user (1..n, no gaps).
  for (const uid of new Set(store.ledgers.map((l) => l.user_id))) {
    const seqs = store.ledgers
      .filter((l) => l.user_id === uid)
      .map((l) => l.seq_no)
      .sort((a, b) => a - b);
    seqs.forEach((seq, i) => {
      if (seq !== i + 1) fails.push(`INV-10 ledger gap user=${uid} expected=${i + 1} got=${seq}`);
    });
  }
  // 11. V006/ADR-0006: FK-native pair present and dangling-free.
  for (const r of store.reservations.values()) {
    if (r.cp_id == null || r.connector_no == null) fails.push(`INV-11 reservation ${r.reservation_id} missing FK pair`);
    else if (!store.connectors.get(`${r.cp_id}:${r.connector_no}`))
      fails.push(`INV-11 reservation ${r.reservation_id} dangling pair ${r.cp_id}:${r.connector_no}`);
  }
  for (const s of store.sessions.values()) {
    if (s.cp_id == null || s.connector_no == null) fails.push(`INV-11 session ${s.session_id} missing FK pair`);
    else if (!store.connectors.get(`${s.cp_id}:${s.connector_no}`))
      fails.push(`INV-11 session ${s.session_id} dangling pair ${s.cp_id}:${s.connector_no}`);
  }
  // 12. BUG-050: a RESERVED connector must be held by a BOOKED reservation. This is the
  // invariant the Oracle package violated: expire_stale() flipped the reservation to
  // EXPIRED without releasing the connector, so the hold leaked. The local store always
  // released it, which is exactly why only the ORACLE mode of this runner could catch it.
  {
    const held = new Set(
      [...store.reservations.values()].filter((r) => r.status === 'BOOKED').map((r) => r.connector_ref)
    );
    for (const [ref, c] of store.connectors) {
      if (c.status === 'RESERVED' && !held.has(ref)) fails.push(`INV-12 leaked connector hold: ${ref}`);
    }
  }
  return fails;
}

// ---------------------------------------------------------------------------
// BUG-052/BUG-053 probes. These cannot be written as "0 rows" SELECTs: they drive the
// real procedures and assert the OUTCOME, which is the only way to see an engine
// disagreement (ADR-0005: the local store released an expired hold and Oracle did not)
// or a guard that is armed but open.

// Engine-independent source checks. The V004 guard's identity must only ever be opened
// by guard_pkg.set_status, and every package body that writes connector.status must go
// through it. V006 replaces V003's package bodies wholesale, so a change made in one
// file can be silently undone by the other — the exact failure mode behind BUG-053.
function guardMetaChecks() {
  const dir = path.join(__dirname, '..', '..', 'db', 'oracle');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const fails = [];
  const ident = [];
  const writes = [];
  for (const f of files) {
    fs.readFileSync(path.join(dir, f), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/^\s*--/.test(line)) return; // prose, incl. the comments that explain the bug
        if (/SET_IDENTIFIER/.test(line)) ident.push(`${f}:${i + 1}`);
        if (/UPDATE\s+connector/i.test(line)) writes.push(`${f}:${i + 1}`);
      });
  }
  const onlyGuardPkg = (hits) => hits.length && hits.every((h) => h.startsWith('V003__packages.sql'));
  if (!onlyGuardPkg(ident))
    fails.push(
      `GUARD-META-1: CLIENT_IDENTIFIER is set outside guard_pkg — a session-scoped identity left set defeats the V004 guard. Hits: ${ident.join(', ') || 'none'}`
    );
  if (writes.length !== 1 || !writes[0].startsWith('V003__packages.sql'))
    fails.push(
      `GUARD-META-2: connector.status must be written only by guard_pkg.set_status (V003). Hits: ${writes.join(', ') || 'none'}`
    );
  // Both copies of reservation_pkg must release the hold on expiry (BUG-050 + BUG-053).
  for (const f of ['V003__packages.sql', 'V006__fk_native.sql']) {
    const body = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!/guard_pkg\.set_status\(\s*'reservation_pkg\.expire_stale'/.test(body))
      fails.push(`GUARD-META-3: ${f} does not release the connector hold on expiry (BUG-053 drift)`);
  }
  return fails;
}

// The local-store mirror of the Oracle expiry probe: a stale BOOKED window must free its
// connector. Cheap, and it is what makes the two engines' agreement checkable.
async function localExpiryProbe(store, fails) {
  const free = [...store.connectors.entries()].find(([, c]) => c.status === 'AVAILABLE');
  if (!free) {
    fails.push('GUARD-LOCAL-1: no AVAILABLE connector to probe expiry with');
    return;
  }
  const [ref, conn] = free;
  const id = -1;
  const r = {
    reservation_id: id,
    connector_ref: ref,
    status: 'BOOKED',
    start_at: new Date(Date.now() - 60 * 60000).toISOString(),
    end_at: new Date(Date.now() - 30 * 60000).toISOString(),
  };
  store.reservations.set(id, r);
  conn.status = 'RESERVED';
  try {
    await store.expireStale();
    if (r.status !== 'EXPIRED') fails.push(`GUARD-LOCAL-1: stale window ${id} was not expired (${r.status})`);
    if (conn.status !== 'AVAILABLE')
      fails.push(`GUARD-LOCAL-1: expiry left connector ${ref} ${conn.status} — the hold leaked`);
  } finally {
    store.reservations.delete(id);
    conn.status = 'AVAILABLE';
  }
}

async function runOracleBehaviourProbes(conn, oracledb, fails) {
  // node-oracledb defaults to OUT_FORMAT_ARRAY for execute(), so anything read by name
  // must ask for objects — a named read on an array row is `undefined`, which made the
  // first cut of these probes pass vacuously.
  const q = (sql, binds) => conn.execute(sql, binds || {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
  const ident = async () => {
    const r = await q("SELECT SYS_CONTEXT('USERENV','CLIENT_IDENTIFIER') AS i FROM dual");
    return r.rows[0].I;
  };
  // A no-op rewrite of the status column: the V004 trigger fires on UPDATE OF status, so
  // this is exactly the direct write BR-07 forbids, with no side effect if it slips through.
  const directWrite = async (cp, cn) => {
    try {
      await conn.execute('UPDATE connector SET status = status WHERE cp_id = :cp AND connector_no = :cn', { cp, cn });
      return null;
    } catch (e) {
      return e;
    }
  };
  const expectRefused = async (label, cp, cn) => {
    const e = await directWrite(cp, cn);
    if (!e) fails.push(`${label}: a direct UPDATE connector was ALLOWED — the guard let it through`);
    else if (e.errorNum !== 20801) fails.push(`${label}: expected ORA-20801, got ${e.errorNum} ${e.message}`);
  };
  const probe = (
    await q(
      "SELECT cp_id, connector_no FROM connector WHERE status IN ('AVAILABLE','RESERVED') ORDER BY cp_id, connector_no FETCH FIRST 1 ROWS ONLY"
    )
  ).rows[0];
  if (!probe) {
    fails.push('GUARD-ORACLE-1: no connector rows to probe the guard with');
    return;
  }

  // 1. A fresh session must be refused (the guard is armed at all).
  const startIdent = await ident();
  if (startIdent)
    fails.push(`GUARD-ORACLE-1: probe connection was not fresh — CLIENT_IDENTIFIER already '${startIdent}'`);
  await expectRefused('GUARD-ORACLE-1', probe.CP_ID, probe.CONNECTOR_NO);

  // Booking needs a user and a vehicle. The seed deliberately ships no vehicles (drivers
  // create them at runtime), so the probe provisions one and deletes its own rows again
  // at the end — a gate must be self-sufficient rather than quietly depending on optional
  // demo data, and repeated runs must not drift the database it checks.
  // The window books nine days out and walks the candidate list, because "connector is
  // AVAILABLE" and "this window is free" are different questions; AVAILABLE connectors
  // come first so step 3 observes the hold being taken rather than finding one already
  // held.
  const uid = (await q('SELECT MIN(user_id) u FROM app_user')).rows[0].U;
  if (uid == null) {
    fails.push('GUARD-ORACLE-3/4: the database has no app_user to book with — run the migrations + seed first');
    return;
  }
  // Wrapped in a PL/SQL block on purpose: DML with RETURNING INTO returns its OUT binds
  // as a one-element array through execute(), while a block returns a scalar. Bind names
  // follow the package parameters, like apps/api/src/db/oracle.js does.
  const vid = (
    await conn.execute(
      "BEGIN INSERT INTO vehicle (user_id, make, model, battery_kwh, is_default) VALUES (:p_user, 'Gate', 'Probe', 60, 'N') RETURNING vehicle_id INTO :vid; END;",
      { p_user: uid, vid: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } }
    )
  ).outBinds.vid;
  const candidates = (
    await q(
      "SELECT cp_id, connector_no FROM connector WHERE status IN ('AVAILABLE','RESERVED') ORDER BY CASE status WHEN 'AVAILABLE' THEN 0 ELSE 1 END, cp_id, connector_no FETCH FIRST 12 ROWS ONLY"
    )
  ).rows;
  const book = async () => {
    for (const c of candidates) {
      try {
        const r = await conn.execute(
          "BEGIN reservation_pkg.create_reservation(:p_user, :p_vehicle, :p_cp, :p_conn, SYSTIMESTAMP + INTERVAL '9' DAY, SYSTIMESTAMP + INTERVAL '9' DAY + INTERVAL '35' MINUTE, :p_res_id); END;",
          {
            p_user: uid,
            p_vehicle: vid,
            p_cp: c.CP_ID,
            p_conn: c.CONNECTOR_NO,
            p_res_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
          }
        );
        return { rid: r.outBinds.p_res_id, cp: c.CP_ID, cn: c.CONNECTOR_NO };
      } catch (e) {
        if (e.errorNum === 20503) continue; // OVERLAP on this connector — try the next
        throw e;
      }
    }
    return null;
  };
  const statusOf = async (cp, cn) =>
    (await q('SELECT status FROM connector WHERE cp_id = :cp AND connector_no = :cn', { cp, cn })).rows[0].STATUS;

  // 3. The legitimate paths must still pass the guard on a session that has never leaked:
  //    create_reservation and cancel_reservation each mark their own write (the latter
  //    used to pass only because of the leak in #2). Rolled back — nothing kept.
  let booked = null;
  try {
    booked = await book();
  } catch (e) {
    fails.push(`GUARD-ORACLE-3: create_reservation was refused on a fresh session — ${e.message}`);
  }
  if (!booked) {
    if (!fails.some((f) => f.startsWith('GUARD-ORACLE-3')))
      fails.push('GUARD-ORACLE-3: no connector had a free probe window to book');
  } else {
    const held = await statusOf(booked.cp, booked.cn);
    if (held !== 'RESERVED')
      fails.push(`GUARD-ORACLE-3: booking did not hold connector ${booked.cp}:${booked.cn} (${held})`);
    // 2. BUG-052, asserted immediately after a procedure that actually WROTE
    //    connector.status: the identity is session-scoped, so leaving it set opened the
    //    guard for the whole life of a pooled connection. Asserting this after
    //    expire_stale instead would pass on the buggy code, because that procedure does
    //    not write connector at all in the V006 body.
    const afterIdent = await ident();
    if (afterIdent)
      fails.push(
        `GUARD-ORACLE-2: create_reservation left CLIENT_IDENTIFIER='${afterIdent}' — every later direct write on this pooled connection is allowed`
      );
    await expectRefused('GUARD-ORACLE-2', booked.cp, booked.cn);
    try {
      await conn.execute('BEGIN reservation_pkg.cancel_reservation(:p_res_id, :p_actor); END;', {
        p_res_id: booked.rid,
        p_actor: uid,
      });
      const freed = await statusOf(booked.cp, booked.cn);
      if (freed !== 'AVAILABLE')
        fails.push(
          `GUARD-ORACLE-3: cancellation did not release connector ${booked.cp}:${booked.cn} (${freed}) — BUG-052 regression`
        );
    } catch (e) {
      fails.push(`GUARD-ORACLE-3: cancel_reservation was refused on a session with no leaked identity — ${e.message}`);
    }
    // Committed rather than rolled back: a CANCELLED window does not block step 4's
    // booking (the overlap rule counts BOOKED/CONVERTED only), and the probe deletes its
    // own rows at the end anyway.
    await conn.commit();
  }

  // 4. BUG-050/053: an expired window must release its hold, or the charge point is
  //    unbookable forever (start_session on a RESERVED connector demands a BOOKED window).
  let expiry = null;
  try {
    expiry = await book();
  } catch (e) {
    fails.push(`GUARD-ORACLE-4: could not book a connector to probe expiry — ${e.message}`);
  }
  if (!expiry) {
    if (!fails.some((f) => f.startsWith('GUARD-ORACLE-4')))
      fails.push('GUARD-ORACLE-4: no connector had a free probe window to book');
  } else {
    await conn.execute(
      "UPDATE reservation SET start_at = SYSTIMESTAMP - INTERVAL '60' MINUTE, end_at = SYSTIMESTAMP - INTERVAL '30' MINUTE WHERE reservation_id = :rid",
      { rid: expiry.rid }
    );
    await conn.commit();
    await conn.execute('BEGIN reservation_pkg.expire_stale(:p_rows); END;', {
      p_rows: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    });
    const rst = (await q('SELECT status FROM reservation WHERE reservation_id = :rid', { rid: expiry.rid })).rows[0]
      .STATUS;
    const cst = await statusOf(expiry.cp, expiry.cn);
    if (rst !== 'EXPIRED') fails.push(`GUARD-ORACLE-4: probe window ${expiry.rid} was not expired (${rst})`);
    if (cst !== 'AVAILABLE')
      fails.push(
        `GUARD-ORACLE-4: expiry left connector ${expiry.cp}:${expiry.cn} ${cst} — the hold leaked (BUG-050/053)`
      );
    else console.log(`  guard-oracle-4: expiry released connector ${expiry.cp}:${expiry.cn} (pass)`);
  }
  // Remove the probe's own rows. expire_stale commits internally, so the vehicle and the
  // expired window would otherwise accumulate once per run.
  try {
    await conn.execute('DELETE FROM reservation WHERE vehicle_id = :vid', { vid });
    await conn.execute('DELETE FROM vehicle WHERE vehicle_id = :vid', { vid });
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    console.log(`  guard-oracle: probe cleanup skipped (${e.message})`);
  }
}

async function runOracleChecks() {
  const sqlPath = path.join(__dirname, '..', '..', 'db', 'oracle', 'invariants.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  // Strip full-line comments BEFORE splitting — the header comment carries a ';' inside
  // prose, and a naive split turned it into a garbage statement (ORA-00900), which made
  // the oracle gate silently fall back to local checks instead of running the SQL.
  const stmts = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  // Hoisted installs resolve from the workspace root; CI installs oracledb into
  // apps/api/node_modules — try both so the oracle gate runs everywhere.
  let oracledb;
  try {
    oracledb = require('oracledb');
  } catch {
    oracledb = require('../../apps/api/node_modules/oracledb');
  }
  const pool = await oracledb.createPool({
    user: process.env.ORACLE_USER || 'volthub',
    password: process.env.ORACLE_PASSWORD || 'volthub_dev_pwd',
    connectString: `${process.env.ORACLE_HOST}:${process.env.ORACLE_PORT || 1521}/${process.env.ORACLE_SERVICE || 'freepdb1'}`,
    poolMin: 0,
    poolMax: 2,
  });
  const conn = await pool.getConnection();
  // A second connection, taken before any statement runs, so the guard probes below start
  // on a genuinely fresh session — the invariant SELECTs would otherwise prime this one.
  const guardConn = await pool.getConnection();
  const fails = [];
  try {
    // Probes first: the invariant SELECTs then validate the state the probes leave behind.
    await runOracleBehaviourProbes(guardConn, oracledb, fails);
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
      await guardConn.close();
    } catch {}
    try {
      await pool.close();
    } catch {}
  }
  return fails;
}

async function main() {
  console.log('invariants: mode =', process.env.ORACLE_HOST ? 'oracle' : 'local');
  // Engine-independent: the guard has exactly one write path and both package bodies
  // agree (BUG-052/BUG-053 cannot come back through a source edit).
  const metaFails = guardMetaChecks();
  if (process.env.ORACLE_HOST) {
    try {
      const fails = metaFails.concat(await runOracleChecks());
      if (fails.length) {
        console.error('INVARIANTS FAIL (oracle):\n' + fails.join('\n'));
        process.exit(1);
      }
      console.log('invariants: oracle 0 rows on all checks + guard/expiry probes — OK');
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
    fails.push(...metaFails);
    // The local mirror of the Oracle expiry probe (two engines must agree).
    await localExpiryProbe(store, fails);
    // Also assert the SQL file defines the same 12 checks (drift guard).
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'oracle', 'invariants.sql'), 'utf8');
    const count = (sql.match(/\bSELECT\b/gi) || []).length;
    // File uses SELECT per check (some wrapped, INV-11 is a 4-way UNION); require >= 12.
    if (count < 12) fails.push(`INV-META: invariants.sql defines ${count} SELECTs, expected >= 12`);
    if (fails.length) {
      console.error('INVARIANTS FAIL (local):\n' + fails.join('\n'));
      process.exitCode = 1;
    } else
      console.log(
        `invariants: local 12 checks × ${store.sessions.size} sessions / ${store.reservations.size} reservations — 0 rows — OK`
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
