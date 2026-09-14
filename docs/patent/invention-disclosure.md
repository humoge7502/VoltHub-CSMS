# Invention Disclosure — Acceptance-Envelope Scheduling with Plan-Honesty Verification

**Status:** internal technical disclosure for prior-art search and professional patent-counsel
review. **Not** a patent application. **No patentability is claimed, asserted, or implied.**
Prepared 2026-09-14.

> **Read this first.** Nothing in this document is legal advice, and nothing here establishes
> that the described subject matter is novel, non-obvious, or eligible for patent protection.
> Formal patentability requires a professional prior-art search and review by qualified patent
> counsel in the relevant jurisdiction(s). The purpose of this document is to _describe the
> technical mechanism precisely enough_ that counsel can assess it, and to _honestly record_
> which parts are conventional and therefore should **not** be presented as the invention.

---

## 1. The technical problem

In an electric-vehicle charging management system (CSMS), charging is planned in two stages
that are commonly implemented as separate components:

1. an **admission / certification** stage that decides whether a charging commitment can be
   honoured, and
2. an **allocation / scheduling** stage that decides which vehicle receives which power in
   which time interval.

A battery cannot absorb nameplate power at high state of charge (SoC): acceptance falls
sharply past the CC-CV taper knee. A certifier that is built to reason about the worst case a
battery can present naturally models this acceptance curve. An allocator that reasons about
site capacity, connector capacity, arrival/deadline windows and electricity tariffs does not.

**The failure:** the allocator places energy in intervals — typically _later_, cheaper ones
chosen by a cost-optimisation pass — where the battery can no longer accept it. The resulting
plan is power-feasible but physically undeliverable. The commitment made by the certifier
(which was computed under a _different_, more pessimistic simulation) is broken, and the
violation is not visible in the plan's own metrics: planned cost, planned peak, fairness and
even the certifier's calibration metric are all computed without modelling absorption.

Measured in the applicant's own system (deterministic simulator, 100 site-days, 90% site
utilisation): plans claimed **1,280.27 kWh** the vehicles could not absorb; **42.62%** of
certificates shortfell; the system's deadline advantage over the industry-default equal-share
strategy became statistically indistinguishable from zero.

## 2. Core inventive concept (candidate)

> **Candidate inventive concept.** A charging-allocation mechanism in which a _single_
> battery-acceptance model is (a) used to forward-simulate, from the plan under construction,
> the state of charge each vehicle will actually reach, (b) converted into a per-vehicle,
> per-interval **acceptance envelope** that bounds _every_ allocation decision including a
> subsequent **economic re-allocation** pass, such that the energy the plan claims equals the
> energy a compliant charger delivers — and in which that agreement is computed and published
> as a **plan-honesty metric**.

Two elements are mechanically specific and are the strongest candidates for the "inventive
core" framing:

- **E1 — acceptance-bounded economic re-allocation.** In a cost-shifting pass, energy is moved
  from an expensive interval to a cheaper interval only up to the _destination interval's
  acceptance headroom_ (the energy the battery accepts in that interval given the plan's own
  forward-simulated SoC), and not merely up to its _capacity_ headroom. This is the specific
  step that prevents an economic optimiser from silently re-introducing infeasible energy that
  the feasibility passes had removed.
- **E2 — plan-honesty as a computed output.** Emitting `claimed energy − compliant-deliverable
energy` for the plan as a runtime quantity, such that the agreement between plan and plant is
  observable without re-simulating the physics at the point of measurement.

A third element is a _system invariant_ rather than an algorithm:

- **E3 — single-physics sharing across certifier, allocator and auditor.** The certifier, the
  allocator, and the independent experiment/verification harness consume one and the same
  acceptance function, so that a promise, a plan and an audit cannot describe different
  batteries.

## 3. System embodiment

A system comprising:

- a **store** holding active charging sessions, each with a connector maximum, a battery
  capacity, an SoC reference, an arrival time and a deadline, and a persisted certificate
  record carrying a floor power commitment;
- a **certifier** that simulates a worst-case charging window under the shared acceptance
  function and issues the certificate;
- an **allocator** comprising:
  - an **acceptance-envelope generator** that replays the plan under construction to compute,
    per vehicle and per interval, the energy the battery accepts in that interval (`A_{i,t}`),
  - a **floor pass** that allocates each certified floor front-loaded within the vehicle's
    window,
  - a **feasibility pass** that fills remaining requirement in deadline order, each allocation
    bounded by `A_{i,t}`,
  - an **economic re-allocation pass** that moves energy from higher-priced to lower-priced
    intervals within the vehicle's window, bounded by the site/connector capacity headroom
    _and_ the destination interval's acceptance headroom;
- a **metric emitter** that computes and stores the plan-honesty gap for each plan;
- an **OCPP (or equivalent) actuation path** that converts the plan into charging profiles
  dispatched to charge points.

## 4. Method embodiment

1. Receive, for each active session, the connector maximum `P_i`, battery capacity `B_i`, SoC
   reference `s_i⁰`, arrival slot `a_i`, deadline slot `d_i`, remaining requirement `R_i`, and
   any certified floor `floor_i`.
2. Compute an acceptance factor `φ(s)` for the SoC `s` of each vehicle.
3. Certify: forward-simulate the window under `φ` for the residual capacity (already-certified
   overlapping floors served first); if the requested energy plus margin is achievable, issue a
   certificate whose floor is the rate still guaranteed at the end of the window.
4. Allocate:
   a. For each certified floor, allocate front-loaded energy `min(floor_i, P_i)·dt` across the
   window until the requirement is met.
   b. In deadline order, fill remaining requirement, each per-interval allocation bounded by
   `min(P_i·dt, P_i·φ(socBefore(i,t))·dt)`.
   c. For each interval in descending price order, move its allocated energy into cheaper
   in-window intervals, each move bounded by
   `min(movable, capacityHeadroom(t_c), acceptanceHeadroom(i, t_c))`.
5. Compute and persist the plan-honesty gap `K(x) − D(x)` for the plan.
6. Compile the plan into charging profiles and dispatch them (e.g. OCPP `SetChargingProfile`).

Steps 4c's third bound and step 5 are the elements not found in the conventional power-based
allocation method.

## 5. Novelty boundary — what is conventional and what is _candidate_ novel

This section exists specifically so that conventional material is **not** presented as the
invention. Counsel should treat the left column as prior art / conventional practice.

| Conventional (do NOT present as the invention)                                               | Candidate novel contribution                                                                                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Charging past the CC-CV knee reduces acceptance; taper-aware admission/feasibility checks    | —                                                                                                                               |
| Capacity-constrained scheduling of EV charging (site cap, connector cap, windows)            | —                                                                                                                               |
| Price/tariff-aware (time-of-use) load shifting of EV charging                                | —                                                                                                                               |
| MILP/LP/MPC/RL charging optimisers, some of which include battery acceptance as a constraint | —                                                                                                                               |
| A feasibility certificate / admission control as such                                        | —                                                                                                                               |
| Front-loading energy to maximise deliverability (a consequence of monotone acceptance)       | (this is arguably obvious given ordinary skill; do not lead with it)                                                            |
| Code reuse / a shared library (DRY) between two components                                   | **E3 only as a _system invariant_ with the auditor as the third consumer — weak; likely unpatentable as such**                  |
| Moving energy to cheaper intervals to reduce cost                                            | **E1: bounding that move by the DESTINATION interval's acceptance headroom computed from the plan's own forward-simulated SoC** |
| Measuring delivered vs promised energy after the fact (post-hoc calibration)                 | **E2: computing and publishing plan-claimed-vs-deliverable agreement at plan time as a runtime output of the allocator**        |

**Honest assessment:** the broad claim "schedule EV charging with a battery acceptance model"
is almost certainly not novel. The narrow, mechanically specific, and therefore more defensible
elements are **E1** (the acceptance-headroom bound on the economic re-allocation pass) and
**E2** (plan-honesty as a computed allocator output), preferably claimed in combination with
the full `certify → envelope → allocate → re-allocate → emit` sequence. E3 is likely to be
characterised as ordinary software engineering and should be treated as context, not as the
invention.

## 6. Alternative embodiments

- **Optimiser-agnostic.** The envelope bound can be applied to a heuristic allocator (as
  reduced to practice here), to an LP/MILP as an additional constraint
  `x_{i,t} ≤ P_i·φ(s_{i,t−1})·dt`, to an MPC rolling horizon, or as a projection/safety layer
  over the output of a learned policy. The mechanism claims to be about _the constraint_, not
  about the solver.
- **Acceptance model variants.** `φ` may be a linear taper, a piecewise CC-CV model, a
  manufacturer charge curve, a table lookup, or an online-estimated acceptance from metered
  data. The mechanism is the _use_ of the curve as a per-interval envelope computed from the
  plan's own state, not the particular curve.
- **Interval length.** Any discretisation: sub-minute, 15-minute, hourly; the envelope is
  per-interval energy bounded by `P_i·φ(s)·dt`.
- **State source.** SoC may come from the vehicle (e.g. ISO 15118), be estimated from metered
  energy, be a declared/arrival reference, or be a conservative target. The mechanism uses
  whatever state is available and does not require a specific source.
- **Deployment locus.** Cloud CSMS, on-site edge gateway, or split (allocator in the cloud,
  envelope enforcement at the charger). A decentralised variant applies the same envelope
  bound per agent against its local plan.
- **Metric variants.** The plan-honesty gap may be an absolute energy, a ratio, a
  per-vehicle maximum, or an aggregated site figure; and may be computed against modelled or
  metered acceptance.
- **Proxy/promise semantics.** The floor promise may be flat (as here) or shaped; the envelope
  bound applies either way.

## 7. Prior-art collision risks (to be searched)

The following are the areas most likely to contain anticipating or obviousness-combining art.
Each **must** be searched professionally; this list is a starting point, not a conclusion.

| area                                                                                                   | risk     | why                                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| Constrained optimisation of EV charging with battery charge-acceptance models (academic + patents)     | **high** | Acceptance-limited charging of a single vehicle is standard; a claim to "model acceptance" alone is likely anticipated |
| Taper-aware / CC-CV-aware charge scheduling and power tapering commands to chargers                    | **high** | Charger-side current tapering at high SoC is a well-known practice                                                     |
| Smart-charging profile scheduling under time-of-use tariffs (OCPP smart charging, utility DR programs) | high     | The economic-shifting framework is heavily patented and published                                                      |
| Cost-shift / valley-filling algorithms bounded by capacity headroom                                    | high     | The _capacity_ bound is conventional; only the _acceptance_ bound is candidate novel                                   |
| Post-hoc settlement / reconciliation of scheduled vs metered energy                                    | medium   | May read on E2 if claimed too broadly; distinguish _plan-time allocator output_ from _post-hoc billing reconciliation_ |
| Digital-twin / simulator-based verification of charging plans                                          | medium   | The auditor-as-third-consumer invariant may be characterised as conventional testing                                   |
| Reservation/admission control with feasibility certificates                                            | medium   | Admission control is conventional; the specific coupling to the allocator's envelope is the question                   |

**Specific novelty/inventiveness risks to record:**

- **Element-combination obviousness.** A examiner may argue that combining (i) a taper-aware
  admission check with (ii) a capacity-constrained price-shifting scheduler is an obvious
  combination of known techniques, since both are individually well known in EV charging.
- **The "why wasn't this obvious" problem.** The mechanism looks simple in hindsight and its
  effect is large; simplicity is not a bar, but it _increases_ the burden of showing that the
  specific bound was non-obvious.
- **Subject-matter eligibility.** E2 (a computed metric) and E3 (sharing a function) risk being
  characterised as a mathematical/abstract concept or ordinary software practice under
  eligibility doctrines (e.g. 35 U.S.C. §101 / _Alice_ in the US; computer-program and
  mathematical-method exclusions in other jurisdictions). The **technical-effect** framing —
  _preventing the dispatch of energy that cannot be delivered, and thereby preventing the
  physical breach of a certified grid-power commitment_ — is likely to be the strongest
  eligibility argument, and should be developed with counsel.
- **Applicant's own prior publications.** The system publishes this mechanism openly
  (repository, ADRs, benchmark receipts). Public disclosure before filing can destroy novelty
  in absolute-novelty jurisdictions. **Counsel must be consulted before any further public
  disclosure**, and the date of first public disclosure must be established precisely.

## 8. What evidence would strengthen the invention

- A **reduction to practice with measurements** — which exists: the mechanism is implemented
  and measured (shortfall 42.6% → 2.36%; plan-honesty gap 1,280 kWh → 0.011 kWh; identical
  behaviour where the taper does not bind). This is strong _technical_ evidence of utility and
  of a concrete technical effect, though it is **not** evidence of novelty.
- A **measured counterfactual ablation** showing that the acceptance-headroom bound on the
  _economic_ pass is causally necessary — i.e. that removing only E1 re-introduces the
  infeasible plan (recorded in §13 of the research paper).
- A **hardware-in-the-loop or field demonstration** on real chargers with metered acceptance,
  which would strengthen both technical effect and (potentially) commercial relevance.
- **A professional prior-art search report** with claim charts against the closest references.
- A **freedom-to-operate** opinion, given the density of EV-charging-scheduling patents.

## 9. Candidate claim directions (for counsel to evaluate — not drafted claims)

These are _directions to consider_, deliberately described at a high level and **not** written
as enforceable claims. No claim set is proposed here; claim drafting is counsel's work.

**Independent-claim directions:**

- **Method:** allocating and re-allocating charging energy across intervals for a set of
  vehicles, wherein a per-interval battery-acceptance envelope is derived by forward-simulating
  the plan under construction, applied to _both_ a feasibility allocation and a subsequent
  economic re-allocation whose moves are bounded by the destination interval's acceptance
  headroom; and wherein the agreement between plan-claimed and compliant-deliverable energy is
  computed and output.
- **System:** a controller comprising an acceptance-envelope generator, a floor allocator, a
  deadline-ordered feasibility allocator, an acceptance-bounded economic re-allocator, and a
  plan-honesty metric emitter, coupled to an actuation path that dispatches charging profiles.
- **Computer-readable medium / computer-implemented:** instructions that cause the above, with
  the technical effect framed as preventing dispatch of undeliverable energy and preventing
  breach of a certified power commitment.

**Dependent-claim directions:**

- the acceptance function is shared by a certifier, the allocator and a verification harness
  (the single-physics invariant);
- certified floors are allocated front-loaded within the window (monotone acceptance);
- the floor promise is the rate guaranteed at the end of the worst-case simulation window;
- the envelope uses `min(P_i·dt, P_i·φ(socBefore(i,t))·dt)` as the per-interval bound;
- the economic re-allocation is bounded by `min(capacityHeadroom, acceptanceHeadroom)`;
- the re-allocation is restricted to intervals within the vehicle's own arrival/deadline window;
- the honesty metric is emitted only for the acceptance-aware allocator and recorded per
  decision for audit;
- the mechanism is expressed as an additional constraint of an LP/MILP/MPC optimiser;
- the mechanism is applied as a safety projection over a learned scheduler;
- the mechanism runs in a cloud CSMS, at an edge gateway, or split across both;
- the acceptance state is derived from metered energy rather than a declared SoC;
- non-compliant-device detection is disclaimed (the mechanism bounds _commands_, not device
  behaviour) — i.e. a claim boundary that avoids over-claiming physical enforcement.

## 10. Engineering work vs legal work (division of labour)

| Stage                                          | Owner                                           | Output                                         |
| ---------------------------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| Literature + prior-art search                  | engineering (desk) then **professional search** | search report, claim charts                    |
| Novelty / inventiveness / eligibility analysis | **patent counsel**                              | legal opinion (none given here)                |
| Reduction to practice + evidence               | engineering                                     | implementation, receipts, ablations (done: §8) |
| Invention disclosure                           | engineering                                     | this document                                  |
| Claim drafting, filing strategy, jurisdiction  | **patent counsel**                              | application(s)                                 |
| Further embodiments / continuations            | engineering + counsel                           | additional disclosure material                 |

## 11. Explicit disclaimers

- No patentability, novelty, inventiveness, eligibility or freedom-to-operate conclusion is
  expressed or implied by this document.
- The measured results described are from a **synthetic, deterministic simulator**, not from
  physical hardware; they establish a technical effect in a model, not in a deployed fleet.
- Public disclosure of this mechanism (repository, documentation, benchmark receipts) may
  already have occurred and could affect novelty in absolute-novelty jurisdictions. Establish
  the first-disclosure date with counsel **before** any further disclosure.
- The conventional elements enumerated in §5 must not be presented as the invention.
