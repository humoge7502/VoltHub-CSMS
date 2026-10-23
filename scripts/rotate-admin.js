#!/usr/bin/env node
// Provision or rotate the admin credential (SEC-050).
//
//   node scripts/rotate-admin.js --password 'NewStrongPassword!42'
//   ADMIN_BOOTSTRAP_PASSWORD='NewStrongPassword!42' node scripts/rotate-admin.js
//   node scripts/rotate-admin.js --if-unprovisioned   # used by scripts/migrate.sh
//
// The committed seed creates admin@volthub.in with the sentinel hash
// '!unprovisioned', which can never verify — a fresh database therefore has no
// working admin password until this runs. It generates an Argon2id PHC hash
// (same parameters as the seed) and writes it to the live Oracle row.
//
// --if-unprovisioned only touches a row that is still on the sentinel, so a
// restart never clobbers a rotated credential.
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

const password = arg('password') || process.env.ADMIN_BOOTSTRAP_PASSWORD;
if (!password || password.length < 12) {
  console.error('Refusing: provide --password (>=12 chars) or ADMIN_BOOTSTRAP_PASSWORD.');
  process.exit(1);
}

(async () => {
  const { hash } = apiRequire('@node-rs/argon2');
  const passwordHash = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 });

  let rows = -1;
  let error;
  try {
    const oracledb = apiRequire('oracledb');
    const conn = await oracledb.getConnection({
      user: process.env.ORACLE_USER || 'volthub',
      password: process.env.ORACLE_PASSWORD || 'volthub_dev_pwd',
      connectString: `${process.env.ORACLE_HOST || 'localhost'}:${process.env.ORACLE_PORT || 1521}/${process.env.ORACLE_SERVICE || 'freepdb1'}`,
    });
    const sql = ifUnprovisioned
      ? 'UPDATE app_user SET password_hash = :h WHERE email = :e AND password_hash = :s'
      : 'UPDATE app_user SET password_hash = :h WHERE email = :e';
    const binds = ifUnprovisioned
      ? { h: passwordHash, e: 'admin@volthub.in', s: SENTINEL }
      : { h: passwordHash, e: 'admin@volthub.in' };
    const r = await conn.execute(sql, binds);
    await conn.commit();
    await conn.close();
    rows = r.rowsAffected;
  } catch (e) {
    error = e.message.split('\n')[0];
  }

  if (error) {
    console.warn(`Oracle update skipped (${error}).`);
    if (ifUnprovisioned) return; // seeding without a reachable DB is not an error
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
