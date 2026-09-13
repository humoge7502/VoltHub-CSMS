# ADR-0014: Closing the control loop — certify before scheduling, correlate acks, grade against physics

Date: 2026-09 · Status: accepted

## Context

ADR-0010..0013 landed the FC-HCC pipeline and its benchmark methodology. A forensic pass
over the resulting code found that the **documented** loop and the **executed** loop were
not the same thing. Each gap below was verified by running the code, not by reading it:

1. **Certification never ran in production.** `model.certifyVehicle` was dead code and
   `store.issueCertificate` was called only from tests. No route issued certificates, so
   the "feasibility certificate" — the mechanism the whole research story rests on — was
   exercised only by unit tests.
2. **Deadlines and energy requirements never bound a plan.** `planSite` had no caller for
   `deadlineFor`, so every `deadlineAt` was `null`, and `remainingKwh` was the hard-coded
   constant `40 − delivered`. The scheduler was a headroom allocator wearing the vocabulary
   of a deadline-feasible planner.
3. **The verify stage was blind.** `recordEnforcementTick` had no production caller and
   `setPushAck` was only invoked by tests, because the gateway dropped every CALLRESULT
   (`if (msg.kind !== 'CALL') return`). Actuation was fire-and-forget: a charger could
   answer `Rejected` and the CSMS would never know.
4. **The shipped solver was not the benchmarked one.** `bench/e1-cost.js` implemented its
   own price-sorted solver, while `solveSchedule` computed a price `rank` and then `void`ed
   it, allocating chronologically. The E1 receipt therefore measured code that did not ship.
5. **`hysteresisMin: 0` meant 5 minutes** (`hysteresisMin || 5`), so an explicitly immediate
   replan was impossible — and the property test asserting it was unreachable.
6. **The pipeline was red.** `bench/results/e1-cost.json` failed `prettier --check .`, which
   the `lint` job runs, and every other CI job `needs: lint`.

## Decision

Close the loop inside the existing seams (store port ADR-0005, gateway, outbox ADR-0003);
introduce no new infrastructure.

1. **Certify before schedule.** `planSite` resolves admission facts from the store —
   requirement from the connected vehicle's battery + target SoC (`vehicleStateFor`),
   deadline from the reservation that owns the connector, floors from ACTIVE certificate
   rows — then issues or reuses exactly one certificate per active session through
   `certifySite`. `POST /control/sessions/{id}/certify` shares that code path so a promise
   cannot depend on who asked for it.
2. **Contention is overlap-bounded.** A candidate's competing floors are those of vehicles
   whose charging windows _overlap_ its own. Summing every previously admitted floor
   refused 94% of candidates for no physical reason (measured: 6,799 refusals vs 400
   admissions before the fix).
3. **Certificates model acceptance, not just capacity.** `model.acceptanceFactor` (CC-CV
   knee at 80% SoC) enters the worst-case simulation, and the flat floor promise is the
   rate still guaranteed at the END of the simulated window — conservative by construction.
   The twin **imports the same function**, so the promise and the experiment that audits it
   cannot disagree about physics.
4. **Correlate every CSMS→CP call.** The gateway keeps a bounded pending-call registry:
   CALLRESULT sets the ack on the push audit row, CALLERROR is dead-lettered, and silence
   is swept to an explicit `ACK_TIMEOUT` rather than assumed success. `RemoteStart`/
   `RemoteStop` share the plumbing.
5. **Verify against physics.** `MeterValues` records scheduled-vs-actual kW whenever a
   profile is _in force_, and "in force" requires dispatch (`markPushSent`) with no
   rejection. No profile in force ⇒ no comparison, never a fabricated zero.
6. **One solver, in the open.** `solveSchedule` is now floors → EDF feasibility fill →
   cost-shift restricted to each vehicle's own `[arrival, deadline)` window, deterministic
   on sessionId ties. `arrivalAt` is a hard lower bound, which is what makes future-arrival
   experiments valid; `bench/e1b-cost.js` imports this function instead of re-implementing it.
7. **Fix the coercion, gate the claims.** `hysteresisMin` uses `== null` (0 is a value).
   `control.js`, `ai.js`, `twin.test.js` and the OpenAPI snapshot check all run in CI;
   generated receipts are excluded from formatting by policy.

## Consequences

- **The thesis is now measurable, and it is partly falsified.** E1b (200 paired seeds,
  compliant fleet) shows the controller beating static-cap by **46.69 cost units, 95% CI
  [−48.32, −45.04]**, with peak 36.0 vs 40.0 kW and **zero calibration shortfall across
  1,687 admitted vehicles**. Under 25% non-compliant chargers the advantage disappears
  (paired delta +10.31, CI [−1.44, +22.30]) and the physical site peak reaches **86.4 kW
  against a 40 kW cap** — the envelope bounds what the CSMS _commands_, not what a rogue
  charger _does_.
- **E3 measures the failure honestly.** With target SoC below the taper knee, promises hold
  at every load level and admission tracks load (refusal 66.2% → 76.7% → 77.2%). With
  target SoC _above_ the knee, **42.6% of promises break (max shortfall 2.52 kWh)** and at
  ρ = 0.9 the controller's deadline advantage over the industry default **vanishes**
  (+0.017, 95% CI [−0.014, +0.047] — indistinguishable, not certified worse).
- **The receipts were not reproducible when this ADR was written.** They were anchored to
  `Date.now()`, so the horizon slid across ToU bands and commute peaks between runs, and
  `getHours()` made them depend on the runner's timezone — while the protocol claimed each
  number was "reproducible from its seed". Scenarios are now generated at a fixed UTC
  epoch, the anchor is recorded in every receipt (`args.scenario_epoch`), and the twin's
  tests pin both properties. Two consecutive runs now produce identical receipts, and the
  headline numbers in this ADR moved when the anchor was applied — see `docs/perf.md`,
  which carries the regenerated figures and the softer E3 ρ = 0.9 claim above.
- **Diagnosis, not rescue:** the certificate reasons about acceptance but the _scheduler_
  still reasons only about capacity, so the plan back-loads energy into expensive intervals
  where the battery can no longer take it. The fix is a scheduler that models acceptance
  end-to-end — a **new pre-registered experiment (E6)**, not an edit to E1b/E3 results.
- **Process-local limitation, stated:** "in force" (`sent_at`) lives in the process/read-cache.
  A restart re-establishes it on the next dispatch; enforcement sampling pauses until then
  rather than pretending a profile is active. Persisting it needs a `V008` column and is
  deferred with this ADR as the pointer.

## Follow-up: the durable path was assumed, never exercised

Closing the loop in the local store said nothing about the _durable_ engine. A control-plane
integration suite (`test/e2e/control-plane.js`, `npm run test:e2e:control`) now drives
certify → plan → actuate → typed outcome → audit through HTTP against the compose stack
(Oracle attached, `mode: oracle`), and it immediately failed four ways:

7. **Control-plane audit rows never reached Oracle.** `GRID_ASSET` / `CONTROL_MODE` writes
   were audited in the read-cache only, and the control-mode mirror targeted
   `control_audit_note` — a table that exists in no migration — inside a `.catch()` that
   swallowed the error. Actuation could be enabled on a site with no durable record of who
   did it. Both now write `audit_log` (the table the PL/SQL packages use) in the same
   transaction as the state change.
8. **The audit endpoint served a process-local buffer.** `/admin/audit-logs` reads the
   in-memory array, which was never hydrated — so every row written before a restart
   disappeared from the endpoint that the audit claim rests on. `hydrate()` now restores
   the newest 200 rows, timestamps emitted with an explicit `Z` because the durability test
   compares them against process boot time.
9. **"No audit trail" was itself unauditable.** `/health` now publishes
   `process_started_at`, which is what lets the suite prove the endpoint serves evidence
   that _predates_ the running process (a row the process wrote cannot satisfy it). It also
   lets monitoring distinguish "just restarted" from "degraded for an hour".

10. **A reservation could be handed out with an id Oracle had never issued.** Oracle's
    identity sequence caches values, so a container restart hands out ids above the local
    counter (hydrated from `MAX(id)`). `createReservation` mirrored the row and then
    returned the **local** id; `startSession` already remapped, reservations did not. The
    API therefore answered 201 with a booking that could not be started — the very next
    call failed with `-20505 RESERVATION_MISMATCH` — and a cancel would have targeted the
    wrong row. This only appears _after a restart_, which is why it survived until the
    durable suite was re-run rather than run once. The path now remaps local ids, audit
    rows, notifications and the outbox payload, and the fallback branch caches the durable
    row instead of returning one the read-cache cannot resolve.

The suite also surfaced two behaviours that are **correct but worth stating**, because a
test that trips over them looks like a product bug:

- A `CONVERTED` reservation keeps blocking its window (the money path holds the booking
  until it expires), so the first `AVAILABLE` connector is often the one a previous run
  used. The suite now walks a ladder of future offsets to find a free slot instead of
  assuming the first candidate is free — and reports a saturated database as exactly that.
- Certification admission is **site-relative**: on an over-subscribed site the newcomer is
  refused with a stated reason. The suite asserts the real invariant — _an admission
  commits power, a refusal states why, and neither is silent_ — and both branches were
  observed live (ACTIVE floors of 22 kW and 54 kW; FAILED refusals with 0 kW and a reason).

## Rejected alternatives

- **Editing E1/E3 to reuse the new solver.** ADR-0013: results exist, so a new experiment id
  is the only honest way to re-measure. `e1-cost.js` stays committed as history.
- **Reporting the favorable family only.** The taper-binding family was added _because_ it
  could falsify the claim; dropping it after it failed would be p-hacking with extra steps.
- **Making the envelope "verify" rogue chargers.** A protocol-level command path cannot
  police a non-compliant device; per-connector breaker protection is physical. Claiming
  otherwise would be the exact dishonesty ADR-0008 and ADR-0013 exist to prevent.
