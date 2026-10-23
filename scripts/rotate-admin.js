#!/usr/bin/env node
// Rotate the admin credential (SEC-050).
//
//   node scripts/rotate-admin.js --password 'NewStrongPassword!42'
//   ADMIN_BOOTSTRAP_PASSWORD='NewStrongPassword!42' node scripts/rotate-admin.js
//
// It generates an Argon2id PHC hash (same parameters as the seed), updates the
// live Oracle row when reachable, and prints the two places that must stay in
// sync: the .env line and the db/oracle/seed/seed.sql hash.
'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');

const apiRequire = createRequire(path.join(__dirname, '..', 'apps', 'api', 'package.json'));

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const password = arg('password') || process.env.ADMIN_BOOTSTRAP_PASSWORD;
if (!password || password.length < 12) {
  console.error('Refusing: provide --password (>=12 chars) or ADMIN_BOOTSTRAP_PASSWORD.');
  process.exit(1);
}

(async () => {
  const { hash } = apiRequire('@node-rs/argon2');
  const passwordHash = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 });

  let updated = false;
  try {
    const oracledb = apiRequire('oracledb');
    const conn = await oracledb.getConnection({
      user: process.env.ORACLE_USER || 'volthub',
      password: process.env.ORACLE_PASSWORD || 'volthub_dev_pwd',
      connectString: `${process.env.ORACLE_HOST || 'localhost'}:${process.env.ORACLE_PORT || 1521}/${process.env.ORACLE_SERVICE || 'freepdb1'}`,
    });
    const r = await conn.execute("UPDATE app_user SET password_hash = :h WHERE email = 'admin@volthub.in'", {
      h: passwordHash,
    });
    await conn.commit();
    await conn.close();
    updated = r.rowsAffected > 0;
  } catch (e) {
    console.warn(`Oracle update skipped (${e.message.split('\n')[0]}).`);
  }

  console.log(`\nadmin hash (${passwordHash.length} chars):\n${passwordHash}\n`);
  console.log(`Oracle row updated: ${updated ? 'yes' : 'no (apply the SQL manually)'}`);
  console.log('\nKeep these in sync:');
  console.log(`  1) .env            ADMIN_BOOTSTRAP_PASSWORD=${password}`);
  console.log(`  2) db/oracle/seed/seed.sql  -> admin@volthub.in password_hash`);
  console.log('\nThen recreate the API so the seed re-reads the env:');
  console.log('  docker compose --env-file .env -f infra/docker-compose.yml up -d --build api');
})();
