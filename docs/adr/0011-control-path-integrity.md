# ADR-0011: Control-path integrity — grid assets, signed provenance, and the dead-letter loop

Date: 2026-09 · Status: accepted

## Context

ADR-0010 adds the actuation path. That creates a new threat surface (blueprint
N.2): a compromised CSMS, operator account, or optimizer could push arbitrary
limits to hardware. The existing security posture (Argon2id, refresh-family
revocation, RBAC + station scope, OCPP per-CP basic auth, audit log) covers
identity, not control-integrity: today there is no electrical model to violate,
no rate governance on profile changes, and no triage path for rejected commands.

## Decision

Defense in depth with independent layers, each testable:

1. **Electrical model with enforced monotonicity** (`grid_asset`, V007): the
   hierarchy SITE→PANEL→FEEDER carries per-node caps; a child cap may never exceed
   its parent (trigger `trg_grid_cap_monotonic`, mirrored in the local store with
   band -20902). Compiled schedules are clamped to the SITE cap at compile AND
   re-checked at the gateway.
2. **Two-person rule on cap reductions** (blueprint N.1): a cap REDUCTION starts
   PENDING and needs a second, distinct ADMIN approval (`approved_by != proposed_by`,
   band -20901 on self-approval). Increases apply immediately (upward risk is
   bounded by the parent cap).
3. **Control-mode governance**: per-site OFF/ADVISORY/ENFORCED, default OFF;
   ENFORCED requires an ACTIVE SITE asset (an envelope without a certified cap is
   a hope). Mode changes are audited with old/new values.
4. **Profile-change rate governance**: max 6 pushes/min per charge point at the
   gateway (429 PROFILE_RATE_LIMITED) — a compromised control plane cannot hammer
   hardware with profile churn.
5. **Decision provenance**: every `control_decision` row stores solver identity,
   `bounds_hash` (SHA-256 of the forecast/quantile bounds consumed), state version,
   and runtime — enough to reconstruct and audit any actuation after the fact.
   Profile pushes bind decision_id to payload_sha256 (append-only).
6. **Dead-letter loop** (`dead_letter`, V007): envelope rejections and rate-limited
   pushes land in a dedupe-keyed triage table surfaced at `GET /ops/dead-letters`
   (ADMIN) with idempotent resolve (REPLAYED/DISMISSED). Poison events are
   observable, never swallowed.

## Consequences

- "If an attacker owns the optimizer process, what damage remains possible?"
  Envelope-bounded: cap-respecting waste and deadline pressure. No push can exceed
  the certified site cap because the check does not consult the optimizer.
- The dead-letter route makes the failure path a feature: rejected control traffic
  is queryable, auditable, and testable exactly like every other invariant.
- Signing artifacts (asymmetric) is deliberately deferred: within the current
  single-VM trust boundary the envelope + append-only audit achieves the same
  guarantee; signing enters with multi-node actuation (blueprint Phase 7).

## Rejected alternatives

- Row-level security for grid assets: single-tenant today (ADR-0009); RBAC +
  four-eyes covers the operator threat model until a paying tenant appears.
- Blocking ALL cap changes behind two-person approval: increases are bounded by
  parent monotonicity; friction there adds ops cost with no safety gain.
