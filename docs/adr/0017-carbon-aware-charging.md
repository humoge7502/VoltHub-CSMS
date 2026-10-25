# ADR-0017: CarbonPilot — a reproducible carbon signal, not a green badge

Date: 2026-10 · Status: accepted · Extends ADR-0010 (control loop) and ADR-0015
(acceptance-envelope scheduling)

## Context

Operators are being asked to report emissions and to shift load into cleaner hours.
Most "green charging" features answer that with a logo and an unverifiable claim. Two
failure modes are common and both are dishonest:

1. **A number with no provenance.** "Your session emitted 4.2 kg" is meaningless unless
   the grid, the model version, the accounting boundary and the receipt hash are named.
2. **Scheduling against the wrong number.** Average intensity answers "how dirty was the
   energy I used". It does not answer "what does one more kWh at 03:00 displace" — that is
   marginal intensity. Optimising with the average produces a plan that looks green and
   moves no emissions.

We also refuse to make carbon a hard constraint. A carbon signal that can strand a
driver or block a paid session is a safety and revenue defect, not a feature.

## Decision

Add a **deterministic, versioned carbon model and an advisory accounting rail**:

- `apps/api/src/carbon/intensity.js` is a pure function of `(region, timestamp)` plus
  session/site aggregation. No network call is needed for a forecast, receipt or test.
- The model publishes **`model-v1`** on every response, with `advisory: true` and
  `source: 'model'`. It can never be rendered as a metered value.
- Two intensities are kept separate: **average** for accounting, **marginal** for
  scheduling. The scheduler ranks hours with a configurable carbon price; the receipt
  states the regional annual baseline it is "avoided versus".
- Unknown station maps to **GLOBAL**, never to a flattering low-carbon grid.
- A receipt is content-addressed: SHA-256 over the canonical session carbon payload, so
  the same session re-rendered later produces the same digest.
- Carbon enters the smart-charging objective at weight `CARBON_DEFAULT_WEIGHT=0` by
  default. Turning it on is an explicit operator decision; existing schedules and tests
  remain bit-identical until then.
- Carbon-aware plans still go through `POST /control/plan` and the ADR-0015 acceptance
  envelope. Carbon **ranks** hours; envelope, certification and actuation rules still
  **decide** whether a plan may run.

### REST surface

| Route                                 | Who                    | Answers                                              |
| ------------------------------------- | ---------------------- | ---------------------------------------------------- |
| `GET /api/v1/carbon/regions`          | any authenticated user | regions, model version, social cost                  |
| `GET /api/v1/carbon/forecast`         | any authenticated user | 48 h regional/station intensity + site summary       |
| `GET /api/v1/carbon/receipt/:session` | owner or staff         | per-session grams, baseline, avoided kg, receipt SHA |
| `GET /api/v1/carbon/summary`          | OPERATOR+ within scope | site totals over a bounded window                    |

The web dashboard is `apps/web/src/app/carbon/page.js`; operators see the same numbers the
API serves, including the model caveat.

## Consequences

- A reviewer can reproduce any gram value from `(region, timestamp, kWh)` and verify the
  receipt digest. No vendor account is required.
- "Avoided" has a stated denominator (annual regional average), not a chosen one.
- Scheduling is carbon-capable but off by default; carbon can never block a session or
  change a bill.
- The model is an estimate calibrated to public annual averages, not a metered grid feed.
  A live provider can replace `intensityAt()` without changing the receipt or API contract.
- Social cost of carbon is configurable (`CARBON_SOCIAL_COST_INR_PER_TONNE`, default
  ₹4,200/tCO2e) because the scheduler's job is to rank hours, not to declare a universal
  price of damage.

## Tests

`node apps/api/test/carbon.js` — 8 cases covering deterministic intensity, 48 h forecasts,
receipt determinism/tamper evidence, site aggregation, weight-0 schedule parity,
carbon-aware ranking, RBAC/scope, and validation. No network, no clock dependency beyond
the injected `now`.
