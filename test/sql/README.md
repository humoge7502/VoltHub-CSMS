# test:sql — the database tests itself

- `db/oracle/invariants.sql` — six SELECTs; any returned row = FAIL
  (overlap, ledger drift, bill-without-COMPLETED, total≠lines, meter
  regression, duplicate review). `run-invariants.js` probes the live API.
- `db/oracle/queries.sql` Q1–Q26 + `db/timescale/queries.sql` T1–T6.
