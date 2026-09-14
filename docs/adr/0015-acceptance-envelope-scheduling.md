# ADR-0015: Acceptance-envelope scheduling — one physics model, three consumers

Date: 2026-09 · Status: accepted · Supersedes the E3 taper diagnosis in ADR-0014 (E3 itself is
left untouched as the committed pre-fix record)

## Context

ADR-0014 closed the control loop but left one measured failure standing, and said so:
on the **taper-binding family** (target 95% SoC, where the CC-CV knee at 80% binds), the E3
receipt published a **42.6% certificate shortfall** (ρ = 0.9) and **40.7%** (ρ = 1.2), with
the controller's deadline advantage over the industry default _vanishing_ at ρ = 0.9. The
receipt named the fix as a _new pre-registered experiment (E6)_ — a scheduler that models
acceptance end-to-end — rather than an edit to results that already exist (ADR-0013).

The root cause was a disagreement between two consumers of the same physics:

- `certifyVehicle` simulated acceptance (`acceptanceFactor`, the 80%-knee taper) and made a
  conservative flat-floor promise on the strength of it.
- `solveSchedule` — the allocator that actually produced the plan — reasoned about **power
  and capacity only**. It would happily back-load energy into the cheapest late intervals,
  which is exactly where a battery past the knee can no longer accept it.

So the plan claimed energy the vehicle cannot take, the promise broke, and **every planned
metric still looked healthy**, because none of them modelled absorption. The E3 receipt
could not see the defect it was publishing; only the twin, replaying real actuator physics,
could.

This is a class of bug worth an ADR, not a patch: _the planner, the promise and the
experiment each had their own idea of physics._

## Decision

Make the allocator consume **the same acceptance curve** the certifier and the twin already
share (`model.acceptanceFactor`), so that plan-time feasibility and realised feasibility
cannot disagree. Call it **acceptance-envelope scheduling (AES)**.

1. **One physics model, three consumers.** `acceptanceFactor` is defined once in
   `apps/api/src/control/model.js`; the certifier calls it, the allocator calls it, and
   `apps/simulator/src/twin.js` **imports** it. A promise, a plan and an experiment cannot
   describe different batteries (the property ADR-0012 established for two consumers, now
   extended to three).

2. **The allocator carries per-vehicle acceptance state.** `solveSchedule` replays each
   vehicle's SoC forward from its declared/arrival reference (`startSoc` from the twin,
   `socRef` from the controller's conservative estimate) and computes the energy the
   vehicle can _actually_ accept in slot `t`, given what is already committed to it:

   ```js
   acceptanceKwh(v, t) = min(v.maxKw·dtH, v.maxKw · acceptanceFactor(socBefore(v, t)) · dtH)
   ```

   `socBefore` is recomputed per lookup (O(horizon), horizon = 24) so pass 1 and pass 2 each
   see the true state at their own `t` rather than a pointer only one pass can own;
   determinism is preserved because it is a pure function of the current plan row.

3. **All three passes become acceptance-aware — and only the third changes meaningfully.**
   - _Pass 1 (certified floors)_ is **front-loaded**: acceptance is non-increasing in SoC,
     so the earliest slots carry the most deliverability and a flat floor is honoured from
     the front. A promise decays less when it is served first.
   - _Pass 2 (EDF feasibility fill)_ caps every `give()` by `acceptanceKwh`, so it stops
     planning energy the battery will reject.
   - _Pass 3 (cost shift)_ gains a **second truth**: energy may only move into a cheaper
     slot up to that slot's _acceptance_ headroom, not merely its capacity headroom. Moving
     a load later into a cheap late-night band is precisely how a price pass silently
     breaks a taper-bound promise — this is the line that fixes the published failure.

4. **Below the knee the allocator is bit-identical to the old one.** When
   `acceptanceFactor == 1` throughout, `acceptanceKwh` reduces to `maxKw·dtH`, the cost-shift
   `acceptanceRoom` reduces to the pre-AES bound, and the schedule and metrics are
   **unit-identical**. A fix that cannot regress the compliant case is a prerequisite for
   shipping it, so this is a pinned property, not a hope (A1/A1b in
   `apps/api/test/control-aes.js`, H0 in E6).

5. **The plan now states its own deliverability.** AES metrics carry
   `absorbable_kwh` — what a compliant charger will actually absorb under the acceptance
   curve — beside `delivered_kwh`. A caller can now tell a plan that _looks_ feasible from
   one that **is** feasible without re-simulating the physics. The field is emitted **only**
   when `acceptanceAware` is on, so legacy receipts still regenerate byte-for-byte from
   their own scripts (ADR-0013).

6. **Opt-in and attributable.** `acceptanceAware` defaults to **false** in `solveSchedule`
   (so E1b/E3 regenerate unchanged) and to **on** in the production controller
   (`FCHCC_ACCEPTANCE_AWARE`). Every decision row records which allocator produced it
   (`solver: 'aes' | 'power'`), so the live system can be audited for what it was thinking.

## Evidence — E6 (pre-registered, `bench/e6-taper.js`, `bench/results/e6-taper.json`)

100 paired seeds × 2 SoC families × 3 load levels; same population, same actuator physics
for every strategy (`offline.js`). **E6 is the repair; E3 is not edited.**

Hypotheses, declared before running:

| id  | statement                                                               | result             |
| --- | ----------------------------------------------------------------------- | ------------------ |
| H0  | below the knee, AES ≡ power-based (Δdelivered = 0, Δcost = 0)           | **PASS** ×3 (base) |
| H1  | taper-binding shortfall ≤ 5% (was 42.6% / 40.7%)                        | **PASS**           |
| H2  | AES keeps the deadline advantage over static-cap (paired CI excludes 0) | **PASS**           |
| H3  | AES cost/kWh delivered ≤ static-cap                                     | **PASS**           |
| H4  | the AES plan's own claim equals realised physics (`plan ≈ delivered`)   | **PASS**           |

**The published failure, repaired (target 95% SoC):**

| ρ   | shortfall (power-based → AES) | max shortfall kWh | deadline miss (power → AES) | static-cap miss | cost/kWh (AES vs static) |
| --- | ----------------------------- | ----------------- | --------------------------- | --------------- | ------------------------ |
| 0.9 | **42.62% → 2.36%**            | 2.516 → 2.427     | **56.6% → 15.7%**           | 55.2%           | 0.8982 vs 0.9573         |
| 1.2 | **40.67% → 1.66%**            | 2.516 → 2.168     | **52.9% → 13.6%**           | 65.8%           | 0.8564 vs 0.8962         |

Paired deltas (100 seeds): AES − power-based = **+12.19 kWh delivered** (95% CI 11.58–12.84)
and **+4.74 total cost units** (CI 4.47–5.01) at ρ = 0.9; AES − static-cap deadline-miss
rate = **−0.3988** (CI −0.4252 to −0.372). In words: AES delivers ~12 kWh more per site-day,
spends marginally more _absolute_ energy cost to do it, and **lowers cost per kWh delivered**
(0.8982 vs 0.9049) — feasibility is bought with energy that was previously planned and never
delivered, not with money.

**Plan honesty — the defect and the fix in one number (ρ = 0.9):**

| allocator   | plan claims   | physics delivers | gap              |
| ----------- | ------------- | ---------------- | ---------------- |
| power-based | 93,573.79 kWh | 92,293.53 kWh    | **1,280.27 kWh** |
| AES         | 93,512.75 kWh | 93,512.74 kWh    | **0.011 kWh**    |

At ρ = 1.2 the power-based gap is 781.90 kWh against an AES gap of −0.003 kWh. The legacy
planner was not "slightly optimistic"; it was **claiming ~1.3 MWh of energy per 100-seed run
that the vehicles physically could not absorb**, and no planned metric could see it.

**No regression, exactly (base family, target 80% SoC):** H0 PASS at all three loads —
Δdelivered 0, Δcost 0, identical schedules (also pinned by A1/A1b). Cost/kWh, peak, jain and
deadline-miss are unchanged to the last printed digit: the compliant fleet cannot tell AES
was shipped.

**Honest trade-offs stated, not hidden:** AES total cost is ~0.6% _higher_ in absolute terms
because it delivers 1.3% more energy; fairness (jain) is essentially unchanged (0.8676 vs
0.8682 at ρ = 0.9, 0.7549 vs 0.7557 at ρ = 1.2); and `uncontrolled` still keeps deadlines
better than any planner because it simply charges flat-out — the controller's claim remains
cost, peak and honesty, not deadline superiority over brute force.

## Consequences

- The published failure in `docs/perf.md` is now a **repair with a receipt**, not an open
  wound: E3 stays committed as the pre-fix record and E6 supersedes its _diagnosis_, so the
  history of a real bug survives in the repository.
- The certificate's flat-floor promise is now deliverable above the knee by construction
  (pinned by A4): a promise the allocator is allowed to break is not a promise.
- The production control path changes behaviour only where the taper binds (target > 80%
  SoC fleets); everywhere else the allocator is provably unchanged.
- A future allocator (LP/MILP/learned) inherits the acceptance envelope for free by calling
  `acceptanceKwh`, which is the point of putting the physics in one place.

## Rejected alternatives

- **Editing E3 to show the fix.** ADR-0013: results exist, so a new id is the only honest
  path. E6 is additive; the 42.6% failure stays in the record.
- **Capping the plan at `min(power, acceptance)` without changing the cost-shift pass.**
  This fixes the symptom (passes 1–2 stop over-planning) but leaves pass 3 free to move
  energy back into slots where the taper will reject it — it broke the promise again in
  testing. The `acceptanceRoom` bound in the cost shift is the load-bearing line.
- **Making AES the default in `solveSchedule`.** Would silently change E1b/E3 receipts and
  destroy their regenerability (ADR-0013). Opt-in at the solver, opt-out at the controller.
- **A full battery model (internal resistance, thermal derating).** More parameters than the
  available data can identify; `acceptanceFactor` is a labelled approximation whose only job
  is to make "22 kW is not deliverable at 95% SoC" true in one place. Claiming a real battery
  model would be the over-claiming ADR-0012 exists to prevent.
- **Rewriting the solver as an LP to "optimally" respect acceptance.** The benchmark's
  perfect-foresight LP remains the reference _upper bound_ (ADR-0013); the shipped solver is
  the one the benchmark measures. Replacing the heuristic with an LP is a separate, later
  decision with its own experiment — AES is about the allocator telling the truth, not about
  changing what it optimises.
