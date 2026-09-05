# ADR-0006: Connector linkage becomes FK-native; connector_ref becomes a display handle

Date: 2026-09 (post Audit Round 2, D-01) · Status: implemented in V006 (applied post Round 3)

## Context

`reservation` / `charging_session` carry `connector_ref VARCHAR2(72)` ('cpId:connectorNo')
with no native FK. V005 retrofitted real composite FK columns `(cp_id, connector_no)` plus
sync triggers — an honest evolution, but the packages still write only the string, and the
shadow columns are populated by triggers. An examiner will (correctly) ask why integrity is
enforced by a trigger instead of the INSERT itself.

## Decision

Packages (`reservation_pkg.create_reservation`, `charge_session_pkg.start_session`) insert
`(cp_id, connector_no)` natively; `connector_ref` stays as a **generated display handle**
(`VIRTUAL` column or package-computed). The V005 sync triggers are retired once the packages
write the pair directly. Views/MV switch their joins to the sargable pair (D-03 fix ships
together: `resolve_band_price` gains its `ORDER BY` specificity rule).

## Consequences

- Referential integrity no longer depends on trigger timing; a garbage `connector_ref`
  becomes impossible rather than tolerated.
- One migration (V006) retires two triggers and rewrites two INSERT statements.
- DA1 viva answer upgrades from "we retrofitted integrity in V005" to "the handle is derived,
  the FK is native, and the migration that got us there is numbered" — evolution as evidence.

## Implementation (V006)

- `db/oracle/V006__fk_native.sql`: replaces both package bodies with native-pair INSERTs,
  drops `trg_res_cp_sync`/`trg_sess_cp_sync` (tolerating absence), attempts `NOT NULL` on
  the pair (warns, never fails, on legacy NULLs), and lands D-02 `start_minute`/`end_minute`
  VIRTUAL columns + `uq_band_slot_minute`.
- `V003__packages.sql` canonical source updated with the same two INSERTs so fresh clones
  and migrated DBs converge; `migrate.sh` picks up `V00*.sql` in order, no script change.
- Invariant 11 (`invariants.sql`) gates the pair continuously: no NULL pair, no dangling pair.
