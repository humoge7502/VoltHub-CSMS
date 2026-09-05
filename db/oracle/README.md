# db/oracle — 25 relations, BCNF proofs in `docs/masterplan/06-normalization-bcnf.md`

![ER](../..//diagrams/er-model.mmd) — sources: `diagrams/*.mmd` (GitHub renders `.mmd` natively).

## Migrate

```bash
bash scripts/migrate.sh            # V001..V005 in order (single truth, numbered)
SEED_DB=1 bash scripts/migrate.sh  # + package-driven seed (seed/seed.sql)
sql volthub/<pwd>@localhost/freepdb1 @V001__core_schema.sql  # manual alternative
```

## Files

| File | Contents |
|---|---|
| `V001__core_schema.sql` | 25 relations, identity PKs, CHECKs, 12 indexes (each serves a §17 query) |
| `V002__views_mviews.sql` | `v_connector_live`, `v_station_summary`, `mv_station_daily` (COMPLETE refresh q15m) |
| `V003__packages.sql` | 7 packages: RESERVATION / CHARGE_SESSION / BILLING / TARIFF / MAINTENANCE / AUDIT / SEED |
| `V004__triggers_grants.sql` | `trg_session_audit` + allow-list `trg_connector_guard` + least-privilege role (no DELETE anywhere) |
| `V005__audit_hardening.sql` | audit fixes: midnight-band clamp, `charge_point.auth_secret`, sargable `(cp_id, connector_no)` FK columns + sync triggers |
| `invariants.sql` | 7 CI-gated checks (any row = FAIL) — runner: `node test/sql/run-invariants.js` |
| `queries.sql` | Q1–Q26 portfolio (binds, `FETCH FIRST`, CTE+window, `NOT EXISTS`, HAVING) |
| `seed/seed.sql` | package-driven story seed (stations, tariffs v1→v2, faulted ECR connector, thin wallet) |

## Design notes (audit §6)

- State machines as data (`connector_state`, `session_state`, `reservation_state` FKs).
- `connector_ref 'cpId:connectorNo'` is the display handle; V005 adds real `(cp_id, connector_no)`
  FK columns + `ix_res_cp`/`ix_sess_cp` so station aggregates are sargable.
- Tariff bands are half-open `[start, end)`; midnight closes at `23:59:59` (`TIMESTAMP` cannot
  hold `24:00` — see BUG-008). `TARIFF_PKG.resolve_band_price` matches the JS resolver.
- Money-path mutations only via packages; API role has `EXECUTE`, never direct balance/ledger writes.
