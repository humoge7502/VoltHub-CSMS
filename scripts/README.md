# scripts

- `migrate.sh` — applies `db/oracle/V00*.sql` (sqlplus) + `db/timescale/T00*.sql`
  (psql); degrades to a clear pointer when clients are absent (API runs on the
  local store in that case).
- `seed/generate.js` — deterministic seed + invariant self-check.
- `demo.sh` — boots the API, runs the R1 race proof + a live OCPP session.
