# ADR-0006: Connector linkage becomes FK-native; connector_ref becomes a display handle

Date: 2026-09 (post Audit Round 2, D-01) · Status: proposed (apply before DA1 viva)

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
