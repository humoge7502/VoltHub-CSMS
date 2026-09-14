# ADR-0010: FC-HCC control loop — actuation through the gateway with an optimizer-independent envelope

Date: 2026-09 · Status: accepted

## Context

The platform senses and bills but does not act: the smart-charging LP is advisory
JSON (ADR-0008), the gateway implements no Smart Charging messages, and no
electrical topology exists in the data model. A CSMS that cannot actuate cannot
honor deadlines, shave demand peaks, or prove any smart-charging claim.

Adding actuation creates the most security-sensitive surface in the system: a
command that changes physical power draw. Two failure modes are unacceptable:

1. No actuation: the optimizer stays a demo; every smart-charging claim is
   unfalsifiable marketing.
2. Unsafe actuation: a compromised/timed-out optimizer pushes profiles that
   violate electrical caps — grid violation, hardware stress.

## Decision

One pipeline, **FC-HCC** (Feasibility-Certified Hierarchical Charging Controller),
inserted through existing seams (store port ADR-0005, gateway, outbox ADR-0003):

- **Sense/estimate** (`apps/api/src/control/model.js`): per-active-vehicle state
  from sessions + readings — energy delivered, observed acceptance rate, remaining
  need, remaining time to deadline.
- **Optimize** (`model.solveSchedule`): deterministic merit-order LP surrogate over
  15-minute intervals with site/CP caps, deadlines, and certified-floor priority
  (blueprint K constraints 2/3/5/8). The HiGHS sidecar upgrade compiles the same
  vocabulary; determinism is inherited from ADR-0008.
- **Certify**: worst-case admission at plug-in/reservation — the maximum deliverable
  energy under certified commitments of others must clear the required energy plus a
  tunable margin. Certificates are rows (`feasibility_certificate`, V007) with a
  legal state machine ISSUED→ACTIVE→ERODED/FAILED/MET.
- **Compile + actuate** (`ocpp/smart-charging.js`): `SetChargingProfile` /
  `ClearChargingProfile` / `GetCompositeSchedule` dispatch. Every push is
  envelope-checked, audited (`charging_profile_push`, idempotent per (cp, decision)),
  rate-governed (6/min/CP), and ack-correlated.
- **Envelope** (`control.envelopeCheck`): optimizer-INDEPENDENT hard caps derived
  from `grid_asset` (V007) — never from the optimizer's output. A rejected push
  raises band **-20903 ENVELOPE_REJECTED**, is dead-lettered, and is tested like
  every other invariant. Failure semantics: no optimizer ⇒ chargers revert to
  envelope caps, never to uncontrolled.
- **Verify/replan**: `meter_tick_enforcement` (T003) compares scheduled vs actual kW;
  deviation beyond tolerance erodes certificates (PROFILE_COMPLIANCE outbox event)
  and margin-erosion triggers replanning with hysteresis — not fixed clocks.

Control writes flow through the store port exactly like the money path: local
reference implementation + Oracle write-through mirrors (`wrapControl`) to V007
with local-id authority. REST surface (`control-routes.js`): grid assets (ADMIN,
four-eyes on cap reductions), per-site control mode OFF/ADVISORY/ENFORCED (default
**OFF** until receipts exist), plan cycles, decision/certificate history,
dead-letter triage. OpenAPI drift gate covers the new paths.

## Consequences

- Electrical caps are violated never by construction (envelope); deadline misses
  surface as graded certificate erosion + driver notification, never silent truncation.
- The simulator honors SetChargingProfile (compliance mode) and can impair it
  (`--impair noncompliant`) so the verifier has an honest adversarial case.
- Bench E1/E2/E3 can now measure cost/peak/deadline deltas against uncontrolled
  and static-cap baselines with committed scripts.

## Rejected alternatives

- RL/MARL controller in the control path: non-deterministic control of electrical
  constraints fails the ADR-0008 auditability rule (ablation only, in the twin).
- Envelope inside the optimizer process: same-process enforcement is not independent;
  the property being bought is failure independence at the protocol boundary.
- Direct connector power writes from routes: connector status remains
  gateway/package-owned (trg_connector_guard); control writes go through the store.
