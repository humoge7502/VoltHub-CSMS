#!/usr/bin/env node
// Provision or rotate the admin credential (SEC-050).
//
//   node scripts/rotate-admin.js --password 'NewStrongPassword!42'
//   ADMIN_BOOTSTRAP_PASSWORD='NewStrongPassword!42' node scripts/rotate-admin.js
//   node scripts/rotate-admin.js --if-unprovisioned   # used by scripts/migrate.sh
//   node scripts/rotate-admin.js --ensure             # used by scripts/share-demo.sh
//
// The committed seed creates admin@volthub.in with the sentinel hash
// '!unprovisioned', which can never verify — a fresh database therefore has no
// working admin password until this runs. It generates an Argon2id PHC hash
// (same parameters as the seed) and writes it to the live Oracle row.
//
//   --if-unprovisioned  only touches a row still on the sentinel, so a restart
//                       never clobbers a rotated credential.
//   --ensure            checks the row against the password you supplied and only
//                       writes when it does not verify. A deploy that reseeds, or a
//                       row left holding a hash whose password nobody recorded, heals
//                       itself — without silently rotating a credential that works.
'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');

const apiRequire = createRequire(path.join(__dirname, '..', 'apps', 'api', 'package.json'));

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const SENTINEL = '!unprovisioned';
const ifUnprovisioned = process.argv.includes('--if-unprovisioned');
const ensure = process.argv.includes('--ensure');

const password = arg('password') || process.env.ADMIN_BOOTSTRAP_PASSWORD;
// --if-unprovisioned mirrors what the local seed accepts (seed.js falls back to
// its dev default), so it takes the same floor rather than the rotation floor —
// otherwise a 9-char dev/CI value would seed fine locally and refuse in Oracle.
const MIN_LEN = ifUnprovisioned || ensure ? 8 : 12;
if (!password || password.length < MIN_LEN) {
  console.error(`Refusing: provide --password (>=${MIN_LEN} chars) or ADMIN_BOOTSTRAP_PASSWORD.`);
  process.exit(1);
}

(async () => {
  const { hash, verify } = apiRequire('@node-rs/argon2');
  const passwordHash = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 });

  let rows = -1;
  let alreadyValid = false;
  let error;
  try {
    const oracledb = apiRequire('oracledb');
    const conn = await oracledb.getConnection({
      user: process.env.ORACLE_USER || 'volthub',
      password: process.env.ORACLE_PASSWORD || 'volthub_dev_pwd',
      connectString: `${process.env.ORACLE_HOST || 'localhost'}:${process.env.ORACLE_PORT || 1521}/${process.env.ORACLE_SERVICE || 'freepdb1'}`,
    });

    if (ensure) {
      const cur = await conn.execute('SELECT password_hash FROM app_user WHERE email = :e', { e: 'admin@volthub.in' });
      const stored = cur.rows.length ? String(cur.rows[0][0]) : '';
      // verify() throws on a malformed PHC string, which is exactly what the sentinel
      // is — treat any throw as "does not verify" rather than crashing the deploy.
      try {
        alreadyValid = Boolean(stored) && (await verify(stored, password));
      } catch {
        alreadyValid = false;
      }
    }

    if (!alreadyValid) {
      const sql = ifUnprovisioned
        ? 'UPDATE app_user SET password_hash = :h WHERE email = :e AND password_hash = :s'
        : 'UPDATE app_user SET password_hash = :h WHERE email = :e';
      const binds = ifUnprovisioned
        ? { h: passwordHash, e: 'admin@volthub.in', s: SENTINEL }
        : { h: passwordHash, e: 'admin@volthub.in' };
      const r = await conn.execute(sql, binds);
      await conn.commit();
      rows = r.rowsAffected;
    }
    await conn.close();
  } catch (e) {
    error = e.message.split('\n')[0];
  }

  if (error) {
    console.warn(`Oracle update skipped (${error}).`);
    if (ifUnprovisioned) return; // seeding without a reachable DB is not an error
  }

  if (ensure) {
    if (alreadyValid) console.log('admin credential already matches ADMIN_BOOTSTRAP_PASSWORD');
    else if (rows > 0) console.log('admin credential was out of sync — reprovisioned from ADMIN_BOOTSTRAP_PASSWORD');
    else console.log('admin credential NOT provisioned (no Oracle connection or no admin row)');
    return;
  }

  if (ifUnprovisioned) {
    console.log(
      rows > 0
        ? 'admin credential provisioned from ADMIN_BOOTSTRAP_PASSWORD'
        : rows === 0
          ? 'admin already provisioned — left untouched'
          : 'admin provisioning deferred (no Oracle connection)'
    );
    return;
  }

  console.log(`\nadmin hash (${passwordHash.length} chars):\n${passwordHash}\n`);
  console.log(`Oracle row updated: ${rows > 0 ? 'yes' : 'no (apply the SQL manually)'}`);
  console.log('\nKeep these in sync:');
  // Never echo the secret itself — this script's output ends up in shell history,
  // CI logs and chat transcripts (CodeQL js/clear-text-logging).
  console.log('  1) .env            ADMIN_BOOTSTRAP_PASSWORD=<the value you just supplied>');
  console.log(`  2) db/oracle/seed/seed.sql  -> admin@volthub.in stays '${SENTINEL}'`);
  console.log('\nThen recreate the API so the seed re-reads the env:');
  console.log('  docker compose --env-file .env -f infra/docker-compose.yml up -d --build api');
})();
