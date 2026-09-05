// Data-store seam (ADR-0005): one port, two adapters.
// ORACLE_HOST set => Oracle write-through adapter (db/oracle.js) over a hydrated local
// read-cache; otherwise the documented local test double (db/store.js).
// Usage: const { store, mode } = await getStore();  mode: 'oracle' | 'local'
// B2G-007: server.js sources pool/hydrate/wrap through upgradeStore() here — single truth,
// no duplicated boot path.
'use strict';
const { createStore } = require('./store');
const { seedStore } = require('./seed');

// B2G-007: shared background-upgrade path used by server.js (no duplicated seam).
async function upgradeStore(local, log) {
  const { createPool, ping, hydrate, wrapWithOracle } = require('./oracle');
  const pool = await createPool();
  await ping(pool);
  const stats = await hydrate(local, pool);
  wrapWithOracle(local, pool);
  local._pool = pool;
  local._mode = 'oracle';
  (log || console).info?.({ stats }, 'oracle adapter online (write-through)');
  return { pool, stats };
}

async function getStore(log) {
  const local = createStore();
  if (!process.env.ORACLE_HOST) {
    seedStore(local, process.env.SEED_PROFILE || 'demo');
    return { store: local, mode: 'local' };
  }
  try {
    const { createPool, hydrate, wrapWithOracle } = require('./oracle');
    const pool = await createPool();
    const { ping } = require('./oracle');
    await ping(pool);
    const stats = await hydrate(local, pool);
    (log || console).info?.({ stats }, 'oracle hydrate ok');
    // Seed only when the DB is empty (fresh container) — never overwrite real rows.
    if (!local.users.size) seedStore(local, process.env.SEED_PROFILE || 'demo');
    wrapWithOracle(local, pool);
    local._pool = pool;
    return { store: local, mode: 'oracle' };
  } catch (e) {
    (log || console).warn?.({ err: e.message }, 'oracle unavailable — falling back to local store');
    if (!local.users.size) seedStore(local, process.env.SEED_PROFILE || 'demo');
    local._oracleError = e.message;
    return { store: local, mode: 'local-fallback' };
  }
}

module.exports = { getStore, upgradeStore };
