// OpenAPI drift check (§8.3): fails CI when spec.paths diverges from mounted routes.
// Run: node scripts/check-openapi.js (boots ephemeral API on 4107, no network needed).
'use strict';
process.env.RATE_LIMIT_OFF = '1';
async function main() {
  process.env.PORT = '4107';
  const { server } = require('../apps/api/src/server');
  await new Promise(r => server.listen(4107, r));
  try {
    const spec = await fetch('http://localhost:4107/api/v1/docs').then(r => r.json());
    const specPaths = new Set(Object.keys(spec.paths || {}));
    // Enumerate mounted paths from the Express stack.
    const { app } = require('../apps/api/src/server');
    const found = new Set();
    const walk = (stack, prefix = '') => {
      for (const l of stack || []) {
        if (l.route) {
          const p = (prefix + l.route.path).replace('/api/v1', '') || '/';
          found.add(p);
        } else if (l.name === 'router' && l.handle?.stack) {
          walk(l.handle.stack, prefix + (l.regexp?.toString().includes('api\\/v1') ? '/api/v1' : ''));
        }
      }
    };
    walk(app._router?.stack);
    // The hand-spec uses {id} params; normalize Express :id the same way for comparison.
    const norm = (p) => p.replace(/:(\w+)/g, '{$1}');
    const foundNorm = new Set([...found].map(norm));
    const missing = [...specPaths].filter(p => !foundNorm.has(p));
    // Extra routes without spec entries are warnings (internal/health/metrics exempt).
    const exempt = new Set(['/health/deep', '/metrics', '/internal/outbox', '/internal/outbox/ack', '/internal/expire']);
    const extra = [...foundNorm].filter(p => !specPaths.has(p) && !exempt.has(p) && !p.startsWith('/internal'));
    if (missing.length) {
      console.error(`OPENAPI DRIFT: spec lists ${missing.length} path(s) with no route: ${missing.join(', ')}`);
      process.exitCode = 1;
    } else console.log(`openapi drift: spec=${specPaths.size} routes~${foundNorm.size} — no missing paths — OK`);
    if (extra.length) console.log(`openapi note: ${extra.length} route(s) without spec entry: ${extra.join(', ')}`);
  } finally { server.close(); }
  process.exit(process.exitCode || 0);
}
main().catch(e => { console.error('DRIFT ERROR', e); process.exit(1); });
