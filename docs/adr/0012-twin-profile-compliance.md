# ADR-0012: Digital-twin compliance mode — chargers that honor (or honestly ignore) profiles

Date: 2026-09 · Status: accepted

## Context

The scripted simulator replays fixed OCPP flows with instant-obedience metering:
commanded power equals delivered power by construction. That makes closed-loop
control experiments meaningless — a controller "validated" against obedient
chargers proves nothing (blueprint M.1 "Imperfection"). Phase 2's completion
criterion explicitly requires: "twin CP applies a pushed profile and honors it;
envelope rejects cap-violating pushes (tests pinned)."

## Decision

The simulator charge loop gains profile compliance as a first-class behavior:

- Inbound `SetChargingProfile` CALLs are answered with `Accepted` and the CP
  stores the schedule's currently-active period limit; `ClearChargingProfile`
  clears it. The compliant CP meters `min(natural draw, profile limit)` —
  commanded profiles produce observable, protocol-faithful acceptance.
- `--impair noncompliant` answers `Rejected` and ignores the profile entirely,
  manufacturing the honest adversarial case: the FC-HCC verifier must see the
  deviation (enforcement ticks), erode the certificate, and replan — or fail its
  own E3 metrics.
- No charger-state mutation happens outside OCPP: the twin remains
  indistinguishable from a real charge point at the gateway (the property that
  makes closed-loop experiments trustworthy).

## Consequences

- `node apps/simulator/src/index.js --scenario normal` now demonstrates
  profile honoring end-to-end (push → acceptance → throttled metering).
- Bench E1/E3 can compare compliant vs non-compliant fleets; the deviation
  between scheduled and metered kW is the compliance metric, not an assumption.
- Full generative physics (battery CC-CV curves, calibrated ACN-Data arrivals)
  remains future work (blueprint Phase 6); this change deliberately adds only the
  compliance behavior Phase 2 requires — no half-built physics engine.

## Rejected alternatives

- Simulating compliance inside the gateway for "test mode": that would validate
  the gateway against itself. Compliance must live behind the WebSocket, in a
  peer process, exactly like real hardware.
- Rejecting SetChargingProfile in non-compliant mode silently: the CALLERROR/
  Rejected answer is observable and testable; silence would be indistinguishable
  from message loss.
