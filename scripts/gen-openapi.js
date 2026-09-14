// Generate (or verify) docs/openapi.json from the live hand-maintained spec in
// apps/api/src/docs.js.
//
// Why this exists: docs/openapi.json claimed to be "a static snapshot of the live
// /api/v1/docs spec, drift-gated against routes in CI" — but nothing regenerated or
// checked it, so it had silently fallen 12 paths behind (52 vs 64, no control-plane
// paths at all). A snapshot nobody verifies is a document that lies. This script makes
// the claim true: `node scripts/gen-openapi.js` refreshes it, `--check` fails when the
// committed snapshot differs (CI gate), exactly like the route drift gate beside it.
'use strict';
const fs = require('fs');
const path = require('path');
const spec = require('../apps/api/src/docs.js');

const OUT = path.join(__dirname, '..', 'docs', 'openapi.json');
const rendered = JSON.stringify(spec, null, 2) + '\n';

if (process.argv.includes('--check')) {
  let current = null;
  try {
    current = fs.readFileSync(OUT, 'utf8');
  } catch {
    console.error('OPENAPI SNAPSHOT: docs/openapi.json is missing — run `npm run openapi:gen`');
    process.exit(1);
  }
  if (current !== rendered) {
    const paths = Object.keys(spec.paths || {}).length;
    console.error(
      `OPENAPI SNAPSHOT STALE: docs/openapi.json does not match src/docs.js (${paths} spec paths). ` +
        'Run `npm run openapi:gen` and commit the result.'
    );
    process.exit(1);
  }
  console.log(`openapi snapshot: docs/openapi.json in sync (${Object.keys(spec.paths || {}).length} paths) — OK`);
  process.exit(0);
}

fs.writeFileSync(OUT, rendered);
console.log(`openapi snapshot written: ${OUT} (${Object.keys(spec.paths || {}).length} paths)`);
