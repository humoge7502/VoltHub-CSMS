// Data-store seam (ADR-0005): one port, two adapters. server.js always starts on the
// local store (db/store.js) and, when ORACLE_HOST is set, upgrades it in the background
// to the Oracle write-through adapter (db/oracle.js) over a hydrated read-cache.
//
// B2G-007: the upgrade lives here so server.js has exactly one boot path to source —
// an earlier `getStore()` helper duplicated that path (and was never called), which is
// the kind of second truth that rots silently. Deleted rather than left as a decoy.
'use strict';

// B2G-007: shared background-upgrade path used by server.js (no duplicated seam).
async function upgradeStore(local, log) {
  const { createPool, ping, hydrate, wrapWithOracle, wrapControl } = require('./oracle');
  const pool = await createPool();
  await ping(pool);
  const stats = await hydrate(local, pool);
  wrapWithOracle(local, pool);
  // ADR-0010: V007 control mirrors (grid assets, decisions, certificates, pushes,
  // dead letters). Destructuring so a stale db (V007 not yet applied) degrades to
  // local-only control rows instead of failing boot.
  try {
    wrapControl(local, pool);
  } catch (e) {
    (log || console).warn?.({ err: e.message }, 'control mirrors unavailable (V007 missing?)');
  }
  local._pool = pool;
  local._mode = 'oracle';
  (log || console).info?.({ stats }, 'oracle adapter online (write-through)');
  return { pool, stats };
}

module.exports = { upgradeStore };
