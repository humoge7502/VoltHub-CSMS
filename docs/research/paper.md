# Plan Honesty: Restoring Agreement Between Charging Plans and Battery Physics in an EV Charging Management System

**Status:** draft (2026-09-14). Results reported here are measured, not projected; every number
regenerates from a committed script (`bench/e6-taper.js` → `bench/results/e6-taper.json`).
**Venue target (candidates, not commitments):** a systems/energy venue with an applied
measurement track — e.g. ACM e-Energy, IEEE SmartGridComm, IEEE TSG (letters), or an
applied-ML/systems workshop. No submission has been made and none is guaranteed.
**Artifact:** the whole system is in this repository; §9 states exactly what reproduces what.

---

## Abstract

Charging management systems (CSMS) for electric vehicles increasingly plan charging against
two models of the same vehicle: a **capacity** model (how much power a connector and a
site can deliver) and an **acceptance** model (how much energy the battery will actually
take, which falls sharply once state of charge passes the CC-CV taper knee). We show that
when a feasibility **certifier** reasons about acceptance but the **allocator** that
produces the plan reasons only about capacity, the system publishes plans that are
power-feasible yet physically undeliverable — and that this failure is **invisible in every
standard charging KPI** (cost, peak, fairness, and even the certifier's own calibration
metric), because none of them model absorption.

We call the property that fails **plan honesty**: the agreement between the energy a plan
claims and the energy a compliant charger delivers under the plan. On a deterministic
generative twin at 90% site utilisation, a target-95%-SoC fleet produced plans claiming
**1,280.27 kWh per 100 site-days** that the batteries could not absorb, driving a **42.62%**
certificate shortfall and erasing the controller's deadline advantage over the
industry-default static-cap strategy. We then contribute **acceptance-envelope scheduling
(AES)**: a single-physics invariant (one acceptance function, consumed by the certifier, the
allocator and the experiment) plus an O(H·N) modification to the three-pass allocator that
makes plan honesty hold **by construction**. AES reduces the shortfall to **2.36%**, deadline
miss from **56.6% to 15.7%**, and the plan-honesty gap from **1,280 kWh to 0.011 kWh** per
100 site-days — while being **bit-identical to the incumbent allocator below the taper knee**
(Δdelivered = 0, Δcost = 0), so the compliant fleet cannot tell it shipped. We also contribute
`plan_kwh − delivered_kwh` as a single-scalar, implementation-independent **plan-honesty
metric** that any CSMS or simulator can compute from data it already has.

## 1. Introduction

A modern CSMS does not merely relay commands to chargers. It **promises**: "vehicle 37 will
receive at least 11.4 kW for the next 40 minutes"; "reservation X is feasible on this 40 kW
site". Those promises are made to drivers, fleet operators and — increasingly — to grid
operators under demand-response contracts, where a broken promise is a contract breach, not a
UI glitch.

Making a promise requires a **certifier**: a worst-case feasibility check over the charging
horizon. Building a plan requires an **allocator**: the component that decides which vehicle
gets which kilowatts in which interval. In a well-built system these are separate components
with separate jobs, and the separation is healthy — it lets each be tested independently.

This paper is about a specific, easy-to-make, and hard-to-see failure of that separation.
The certifier is naturally built to be **battery-aware**: it must be, because its entire job
is to reason about the worst case a battery can present. The allocator is naturally built to
be **power-aware**: it reasons about site caps, connector caps, arrival/deadline windows and
tariffs — all _power_ quantities. Both are individually correct. Together they are wrong: the
allocator back-loads energy into the cheapest late intervals, which is precisely where a
battery past the taper knee can no longer accept it. The plan is infeasible, the promise
breaks, and **every planned metric still looks healthy**, because the metrics are computed
from the plan, and the plan does not know about the taper.

The failure is not exotic. It is the _default_ structure of a naive CSMS: power-based
scheduling plus a battery-aware admission check. It is also the failure we found in our own
system, published as a failing receipt, and then repaired — this paper reports both halves,
because the failing half is the more useful one.

**Contributions.**

1. **A named, measurable defect: plan honesty.** We define the gap between a plan's claimed
   energy and its compliant-actuator deliverable energy as a first-class quantity, and show
   it is invisible to cost, peak, fairness and even calibration metrics (§3, §5).
2. **A measurement of the defect in a real system.** 1,280.27 kWh of undeliverable claims per
   100 site-days at ρ = 0.9; 42.62% certificate shortfall; the deadline advantage over the
   industry default vanishing (§12).
3. **Acceptance-envelope scheduling (AES).** A one-physics invariant (certifier, allocator and
   experiment import the _same_ `acceptanceFactor`) plus an O(H·N) allocator modification —
   a per-slot acceptance headroom bound applied to all three allocation passes, most
   importantly the cost-shift pass (§7, §8).
4. **A guarantee, not a hope:** AES is provably and empirically **identical to the incumbent
   allocator when the taper does not bind** (H0/A1), which is what makes it shippable to an
   existing fleet; and it makes the certifier's flat floor promise **deliverable by
   construction** above the knee (§8.3, A4).
5. **A reproducible experiment.** Pre-registered hypotheses, 100 paired seeds, an unmodified
   committed pre-fix receipt (E3) kept beside the repair (E6), and a receipt regenerable from
   its seeds alone (§9, §10).

We deliberately do **not** claim an optimal solver, a learning contribution, or a hardware
validation; §16 states the limitations, and §14 argues the security/trust consequence of plan
honesty without over-claiming physical enforcement.

## 2. Problem definition

We consider a single site with a site-level power cap `C` (kW) and `N` charge points, each
connector with a nameplate maximum `P_i` (kW). A planning horizon `T = {1…H}` of equal
intervals of length `dt` hours (we use H = 24, dt = 0.25 h) is discretised from "now".

**Charging session.** Each active vehicle `i` presents:

| symbol       | meaning                                                    |
| ------------ | ---------------------------------------------------------- |
| `P_i`        | connector maximum power (kW)                               |
| `B_i`        | usable battery capacity (kWh)                              |
| `s_i⁰`       | state of charge reference at plan time (frac.)             |
| `a_i`, `d_i` | arrival slot and deadline slot (hard windows)              |
| `R_i`        | remaining energy requirement (kWh), `R_i ≤ (1 − s_i⁰)·B_i` |
| `floor_i`    | certified floor power (kW), a persisted promise            |

**Decision variable.** `x_{i,t} ≥ 0` — energy (kWh) allocated to vehicle `i` in slot `t`.

**Battery acceptance.** The fraction of nameplate power a battery accepts at SoC `s` follows
the CC-CV shape; we use the labelled approximation

```
φ(s) = 1                                              if s ≤ κ
     = floor + (1 − floor)·(1 − (s − κ)/(1 − κ))      if κ < s < 1
     = floor                                          if s ≥ 1
```

with taper knee `κ = 0.8` and floor `= 0.15`. `φ` is non-increasing in `s`. Crucially, `φ`
is **not** a battery model: it is a minimal, single-place encoding of the one fact the system
must not contradict — _22 kW is not deliverable at 95% SoC_. We make no electrochemical claim.

**The two energies of one plan.** Given a plan `x`, define

- **claimed energy** `K(x) = Σ_i Σ_t x_{i,t}` — what the plan says it will deliver;
- **delivered energy** `D(x) = Σ_i Σ_t min(x_{i,t}, P_i·φ(s_{i,t−1}(x))·dt)` — what a _compliant_
  charger absorbs, where `s_{i,t}` evolves by
  `s_{i,t} = min(1, s_{i,t−1} + min(x_{i,t}, P_i·φ(s_{i,t−1})·dt) / B_i)`.

**Plan honesty.** Define the honesty gap

```
η(x) = K(x) − D(x) ≥ 0.
```

A plan is **honest** iff `η(x) ≈ 0`: it claims no energy the battery cannot absorb. This is
the property whose absence is the subject of the paper. Note that `η` is _not_ the same as
"unmet demand": a plan can fail to satisfy `R_i` while being perfectly honest (it under-claims
or under-serves), and a plan can satisfy every planned requirement while being badly
dishonest (it claims energy that will never arrive). Legitimate under-delivery and illegitimate
over-claiming are different failures and standard KPIs conflate them.

**Acceptance envelope.** Slot `t` is _acceptance-feasible_ for vehicle `i` under plan `x` iff

```
x_{i,t} ≤ A_{i,t}(x) := P_i · φ(s_{i,t−1}(x)) · dt.
```

A plan is acceptance-feasible iff this holds for all `i, t`. **Then `η(x) = 0` by
construction**, because every claimed kWh is bounded by what the recursion absorbs.

## 3. Why the failure is invisible

This is the heart of the problem, and it is worth being precise. Consider the four quantities
a CSMS instruments during planning:

| KPI                        | computed from                 | sees the taper? |
| -------------------------- | ----------------------------- | --------------- |
| planned cost               | `x` and tariffs               | no              |
| planned peak / envelope    | `x` and `C`                   | no              |
| fairness (e.g. Jain index) | distribution of `Σ_t x_{i,t}` | no              |
| certificate calibration    | `D(x)` vs the promise         | **yes**         |

Only the last is computed from _delivered_ energy, and calibration is measured **after**
schedule compilation — by which point the plan has already been published, the promise already
made, and the loads already shifted. Worse, for a **conservative** certifier (a flat floor set
to the rate guaranteed at the _end_ of the simulated window, §7.2) calibration reports zero
shortfall _by construction_ on fleets whose plans are caught by physics that the certifier
already modelled — until the allocator's plan diverges from the certifier's simulation.

In other words: the one metric that measures battery reality is downstream of the decision
that ignores it, and the metric is measured on a _plan the allocator produced_, not on the
plan the certifier simulated. In our own system, planned cost, planned peak and fairness were
all healthy while **42.62%** of promises were breaking. That is the empirical claim: the defect
is not merely present, it is **undetectable without instrumenting `η` directly**.

## 4. Related work

We organise the relevant literature by **approach class** rather than by paper, because the
distinction that matters here is structural (what each approach models), not algorithmic.
Citation list is a draft and must be completed and verified before any submission.

**Uncontrolled charging.** Charging at connector maximum on plug-in. The reference "do
nothing" behaviour; it front-loads, so it keeps deadlines well, but it maximises peak and cost.

**Static / equal-share load balancing.** The industry default: split the site cap equally
among the vehicles plugged in during a slot. Cheap, obvious, fair, and hard to beat on
fairness. It is capacity-based, so it knows nothing about the taper.

**Price-aware scheduling (time-of-use arbitrage).** Shift energy out of expensive intervals
into cheaper ones within each vehicle's window. Price-aware heuristics and LP/MILP
formulations of cost-minimising EV charging are extensively studied; the general finding is
that tariff-aware scheduling reduces energy cost while introducing fairness and peak
trade-offs. Capacity-based price shifting is the _specific mechanism_ that produces the
defect in §1: it moves energy later, which is where the taper is worst.

**Centralised optimisation (LP, MILP, MINLP).** Formulating charging as constrained
optimisation (cost or loss minimisation under power, energy and window constraints) is the
classical approach. These formulations are _correct_ — but a capacity-only formulation
inherits exactly the flaw of §2, because the battery acceptance curve is a nonlinear
constraint that must be added explicitly. Where the taper is modelled, it is typically
modelled **in the constraint set of the same optimiser** — i.e. the very "one physics, one
consumer" property we argue for, discovered independently by the constraint-modelling
literature and frequently absent in real deployments where admission checks and schedulers
are separate services.

**Model predictive control and online optimisation.** Rolling-horizon control with demand
forecasting; attractive under uncertainty. The plan-honesty failure is orthogonal: it occurs
even with perfect foresight, because it is a modelling disagreement, not a forecast error.

**Reinforcement learning / learning-based scheduling.** Data-driven schedulers learn policies
under simulated battery models. A learned policy is subject to precisely the same defect if
its reward is computed from claimed energy rather than delivered energy — a risk that is
rarely reported and, we suggest, worth instrumenting as `η`.

**Decentralised / aggregate-level control.** Price-signal or consensus protocols coordinate
populations without a central plan. The plan-honesty question becomes: can each agent's local
plan be delivered? The single-physics argument applies within each agent.

**Research gap.** Across these classes, the **agreement between the plan and the plant** (the
`η = 0` property) is not usually stated as a system invariant, is not usually measured, and is
not usually tested as a property of the _allocator_ — capacity feasibility is. Our
contribution is to name the property, measure its violation in a working system, and show that
restoring it costs nothing below the knee.

## 5. System context

We study the failure in **VoltHub-CSMS**, an OCPP 1.6J charging management system whose
control loop is deliberately structured as `sense → certify → schedule → compile → actuate →
verify`. The relevant components:

- **Certifier** (`model.certifyVehicle`): simulates a worst-case window under `φ`, serves the
  already-certified floors of _overlapping_ vehicles first, and emits a conservative flat
  floor — the rate still guaranteed at the _end_ of the simulated window, since `φ` is
  non-increasing. Issues a persisted certificate row.
- **Allocator** (`model.solveSchedule`): three deterministic passes — (1) certified floors,
  chronological; (2) earliest-deadline-first feasibility fill; (3) cost shift into cheaper
  in-window slots. Capacity constraints (site, per-connector) are re-checked on every move.
- **Twin** (`simulator/src/twin.js`): a deterministic generative fleet (arrivals, battery
  sizes, SoC, ToU prices, configurable non-compliant chargers) that applies
  `applyActuatorReality` — `φ` plus non-compliance — to **every** strategy's requested
  schedule.
- **Harness** (`simulator/src/offline.js`): scores every strategy on the identical fleet for a
  given seed, under identical actuator physics.
- **Baselines** (`simulator/src/baselines.js`): `uncontrolled`, `static_cap` (industry
  default), `price_blind_edf` (the price-shift ablation), and a relaxed `cost_lower_bound`.

Before the work reported here, the certifier and the twin imported the **same**
`acceptanceFactor` — an ADR-0012 decision made precisely so a promise and the experiment that
audits it cannot disagree about physics. The allocator was the **third** consumer that was
never given the same function. That asymmetry — two of three components sharing one physics
model — is exactly the structural condition that produces an invisible plan-honesty violation,
and it is the condition we would expect in any system that grew a battery-aware admission
check on top of a power-based scheduler.

## 6. The defect, measured

Reproduced from the committed pre-fix receipt (`bench/results/e3-deadline.json`, E3), 100
seeds × 2 SoC families × 3 load levels, ρ = site utilisation:

| family                       | ρ   | shortfall | max shortfall | deadline miss | static-cap miss | vs static-cap (paired)       |
| ---------------------------- | --- | --------- | ------------- | ------------- | --------------- | ---------------------------- |
| target 80% (taper not bind)  | 0.6 | 0%        | 0.0009 kWh    | 6.3%          | 12.6%           | better (PASS)                |
| target 80%                   | 0.9 | 0%        | 0.0007 kWh    | 6.6%          | 31.7%           | better (PASS)                |
| target 80%                   | 1.2 | 0%        | 0.0010 kWh    | 14.9%         | 45.8%           | better (PASS)                |
| **target 95% (taper binds)** | 0.9 | **42.6%** | **2.52 kWh**  | **56.6%**     | 55.2%           | **indistinguishable**        |
| **target 95%**               | 1.2 | **40.7%** | **2.52 kWh**  | **52.9%**     | 65.8%           | worse on cost (PASS on miss) |

The taper-binding family is not a different workload — it is the _same_ workload with a higher
target SoC, i.e. the case where vehicles are asked to charge past the knee. The mechanism
collapses precisely there, and the collapse is invisible in the target-80% family, where the
scheduler is fine and everyone is happy.

Two honest notes, carried from the original receipt: (i) an earlier receipt of this family
showed ρ = 0.9 as "significantly worse"; re-anchoring the scenario to a fixed UTC epoch moved
it to "indistinguishable from static-cap", and the weaker statement is the correct one;
(ii) `uncontrolled` keeps deadlines _better_ than the controller in the target-80% family
(4.9% vs 6.9%) because it charges flat-out — the controller's advantage is cost, peak and
fairness, not deadline adherence against brute force.

## 7. Proposed mechanism: one physics, three consumers

### 7.1 The invariant

> **Invariant (single physics).** There exists exactly one acceptance function `φ`. The
> certifier, the allocator and the experiment that audits both are consumers of that one
> definition. No component may carry a private copy, a private parameterisation, or a private
> approximation of it.

This is enforceable mechanically: `φ` is defined once
(`apps/api/src/control/model.js: acceptanceFactor`) and the twin **imports** it. The
certifier's worst-case simulation, the allocator's envelope and the experiment's actuator
reality are then the same function applied three times, and they cannot drift apart.

The invariant is stronger than it looks. It converts a _behavioural_ question ("do the
planner and the simulator agree?") into a _structural_ one ("can they disagree?"), and the
answer becomes no. It also means the fix is not a compatibility shim: any future allocator
(LP, MPC, learned) inherits the envelope by calling the same function.

### 7.2 Certified floors

The certifier serves the already-certified floors of overlapping vehicles first (residual
capacity only), simulates `φ` forward from the vehicle's SoC reference, and emits a **flat
floor**: the rate still guaranteed at the _end_ of the simulated window. Because `φ` is
non-increasing in `s`, that final rate bounds every earlier one — a conservative promise by
construction. A decaying promise would be worse than an honest floor, and a floor is what the
allocator is required to honour.

## 8. Acceptance-envelope scheduling (AES)

### 8.1 Allocator change

The allocator gains per-vehicle acceptance state, replayed from the plan itself:

```
socBefore(i, t)   = s_i⁰ folded forward by absorbed energy in slots < t
acceptanceKwh(i,t)= min( P_i·dt , P_i · φ(socBefore(i,t)) · dt )
```

`acceptanceKwh` is the **acceptance envelope** `A_{i,t}(x)`. All three passes are bounded by
it:

1. **Certified floors** are allocated **front-loaded** within `[a_i, d_i)`. Rationale: `φ` is
   non-increasing, so the earliest slots carry the most deliverability; serving a flat floor
   from the front is what makes it honour-able.
2. **EDF feasibility fill** caps each allocation by `A_{i,t}`.
3. **Cost shift** gains a _second_ headroom check. Energy may move from expensive slot `t_e`
   into cheaper slot `t_c` only up to

   ```
   min( movable, roomAt(t_c, cp), A_{i,t_c} − x_{i,t_c} )
   ```

   The third term is the load-bearing line. Capacity headroom alone permits moving energy into
   a cheap late-window slot where the taper will reject it — which is _exactly_ how a
   price-aware pass silently breaks a taper-bound promise.

Complexity is unchanged in order: `socBefore` costs O(H) per lookup and H = 24, so the
allocator remains O(H·N) per pass (dominated by the existing site-cap sums and the cost-shift
search). No new infrastructure, no solver, no dependency.

### 8.2 Below the knee, AES _is_ the incumbent allocator

If `φ ≡ 1` throughout a vehicle's window, then `A_{i,t} = P_i·dt`, `acceptanceKwh` is
identically the per-slot nameplate energy, and the cost-shift acceptance room reduces to the
existing bound. Therefore the schedule and every metric are **identical** to the pre-AES
allocator. Formally:

> **Proposition (no-op below the knee).** If `s_{i,t} ≤ κ` for all `i, t` under `x`, then
> `x_AES = x_power` and `η(x_power) = 0`.

This is what makes the change safe to ship into a live fleet: fleets that never charge past
80% SoC are provably unaffected. It is pinned as a property test (A1/A1b) and reported as a
pre-registered hypothesis (H0) — a fix that cannot regress the compliant case is a
prerequisite, not a nicety.

### 8.3 The promise becomes deliverable

> **Proposition (floor deliverability).** Under AES, the energy an AES schedule absorbs by the
> deadline is at least the certificate's floor promise
> `min(floor_i · dt · |window|, R_i)`.

Front-loading (pass 1) plus the acceptance bound (pass 2) plus the preserved-room cost shift
(pass 3) mean no slot can hold more than the battery accepts, and the earliest available slots
hold the most deliverable energy. This is pinned by property test A4. A promise the allocator
is permitted to break is not a promise.

### 8.4 Plan honesty is now reported

AES metrics carry `absorbable_kwh` — `D(x)` under the same recursion — beside
`delivered_kwh`. A caller can now distinguish a plan that _looks_ feasible from one that _is_
feasible without re-simulating physics. `η = K(x) − D(x)` is thus a first-class, computed
quantity rather than a latent defect. The field is emitted only when AES is active, so legacy
receipts regenerate byte-for-byte from their own scripts.

## 9. Experimental setup

**Twin.** Deterministic generative fleet. Scenarios are anchored to a fixed UTC epoch
(`2026-03-02T00:00:00Z`, recorded in every receipt) and all diurnal quantities are computed in
UTC, so a run is reproducible from its seeds alone on any runner — across timezones and across
time. This was itself a repaired defect: earlier receipts were anchored to wall-clock time and
local hours, and re-running the same command minutes apart produced different numbers while
claiming reproducibility.

**Harness.** Every strategy is scored on the identical fleet for a given seed, and actuator
reality (acceptance plus configurable non-compliance) is applied **identically to every
strategy** after the fact. No baseline is scored under kinder physics than the controller.

**Population.** Deadline-miss and calibration are measured on the **promised population** (the
vehicles the controller admitted) for every strategy, so a baseline cannot look better by
serving fewer, easier vehicles.

**Receipts.** `bench/results/e6-taper.json` (this work), `e3-deadline.json` (the pre-fix
record, unmodified), `e1b-cost.json` (cost/calibration, 200 seeds). Reproduce with
`npm run bench:e6`, `npm run bench:e3`, `npm run bench:e1b`.

**Pre-registered hypotheses** (declared before running, all five PASS):

| id  | statement                                                          |
| --- | ------------------------------------------------------------------ |
| H0  | below the knee, AES ≡ power-based: Δdelivered = 0 and Δcost = 0    |
| H1  | taper-binding certificate shortfall ≤ 5% (was 42.6% / 40.7%)       |
| H2  | AES retains the deadline advantage over static-cap (paired CI ∌ 0) |
| H3  | AES cost per kWh delivered ≤ static-cap's                          |
| H4  | plan honesty: `K(x) ≈ D(x)` on the AES plan                        |

**Methodology rule we hold ourselves to:** a failed hypothesis exits 0 and is published; a
result that exists is never edited to show the fix — a repair is a **new experiment id**
(E6) that supersedes the _diagnosis_ while the failing receipt (E3) stays committed as the
pre-fix record. This is the difference between a benchmark and a marketing artefact, and it is
what makes §12 auditable.

## 10. Baselines

| baseline           | class                        | taper-aware? | price-aware? | capped? |
| ------------------ | ---------------------------- | ------------ | ------------ | ------- |
| `uncontrolled`     | do nothing (connector max)   | no           | no           | no      |
| `static_cap`       | industry default equal-share | no           | no           | yes     |
| `price_blind_edf`  | EDF, price-shift ablation    | no           | no           | yes     |
| `controller`       | shipped solver, **pre-fix**  | no           | yes          | yes     |
| `controller_aes`   | shipped solver, **AES**      | **yes**      | yes          | yes     |
| `cost_lower_bound` | relaxed bound (cost only)    | n/a          | yes          | relaxed |

The `price_blind_edf` arm isolates pricing: it has the controller's feasibility discipline and
no tariff awareness, so the cost difference between it and the controller is attributable to
pricing alone. `cost_lower_bound` relaxes the site cap per-vehicle, so its energy cost bounds
any schedule serving the same total demand under the same windows — it is **not** a valid
comparison for strategies that serve less energy, which is why cost is always read beside
`delivered_kwh` and `deadline_miss_rate`.

## 11. The defect and fix in one number

The single most diagnostic measurement we contribute. At ρ = 0.9, 100 seeds:

| allocator   | plan claims (`K`) | physics delivers (`D`) | honesty gap (`η`) |
| ----------- | ----------------- | ---------------------- | ----------------- |
| power-based | 93,573.79 kWh     | 92,293.53 kWh          | **1,280.27 kWh**  |
| **AES**     | 93,512.75 kWh     | 93,512.74 kWh          | **0.011 kWh**     |

At ρ = 1.2 the power-based gap is **781.90 kWh** against an AES gap of **−0.003 kWh** (float
noise). The legacy planner was not slightly optimistic. It was claiming roughly a megawatt-hour
and a quarter per 100 site-days of energy the vehicles physically could not absorb — invisible
in cost, peak and fairness.

`η` is trivially computable by any CSMS or simulator from data it already has (the plan and the
metered or modelled acceptance), which is why we propose it as a standard instrument.

## 12. Results

All numbers from `bench/e6-taper.js` (100 paired seeds per level); H0–H4 all PASS where
applicable.

### 12.1 The repair, measured (target 95% SoC, taper binds)

| ρ   | shortfall (power-based → AES) | max shortfall kWh | deadline miss (power → AES) | static-cap miss | cost/kWh (AES vs static) |
| --- | ----------------------------- | ----------------- | --------------------------- | --------------- | ------------------------ |
| 0.9 | **42.62% → 2.36%**            | 2.516 → 2.427     | **56.6% → 15.7%**           | 55.2%           | 0.8982 vs 0.9573         |
| 1.2 | **40.67% → 1.66%**            | 2.516 → 2.168     | **52.9% → 13.6%**           | 65.8%           | 0.8564 vs 0.8962         |

**Paired deltas, ρ = 0.9, 100 seeds** (bootstrap 95% CI):

| quantity                             | mean        | 95% CI                           |
| ------------------------------------ | ----------- | -------------------------------- |
| AES − power-based, delivered kWh     | **+12.19**  | 11.58 … 12.84                    |
| AES − power-based, total cost units  | +4.74       | 4.47 … 5.01                      |
| AES − static-cap, deadline-miss rate | **−0.3988** | −0.4252 … −0.372                 |
| power-based − static-cap, miss rate  | +0.0167     | **−0.014 … 0.047 (straddles 0)** |

The last row is the original finding: pre-fix, the controller's deadline advantage over the
industry default was **statistically indistinguishable from zero** at ρ = 0.9. Post-fix it is
−0.40, a 24-point absolute reduction in deadline-miss rate.

Interpretation: AES delivers **~12 kWh more per site-day** at ρ = 0.9, spends marginally more
_absolute_ energy cost to do so (+4.74 units, ~0.6%), and **lowers cost per kWh delivered**
(0.8982 vs the pre-fix 0.9049 and vs static-cap's 0.9573). Feasibility is bought with energy
that was previously planned and never delivered — not with money.

### 12.2 No regression, exactly (target 80% SoC, taper does not bind)

| ρ   | Δdelivered | Δcost | Δcost/kWh | Δjain | Δdeadline-miss | shortfall |
| --- | ---------- | ----- | --------- | ----- | -------------- | --------- |
| 0.6 | 0          | 0     | 0         | 0     | 0              | 0%        |
| 0.9 | 0          | 0     | 0         | 0     | 0              | 0%        |
| 1.2 | 0          | 0     | 0         | 0     | 0              | 0%        |

Every printed metric is unchanged to the last digit; schedules are element-wise identical.
H0 PASS at all three loads. The compliant fleet cannot detect that AES shipped.

### 12.3 Honest trade-offs

| quantity               | ρ = 0.9                 | ρ = 1.2                    |
| ---------------------- | ----------------------- | -------------------------- |
| jain fairness (AES)    | 0.8676 (pre-fix 0.8682) | 0.7549 (pre-fix 0.7557)    |
| total cost, absolute   | +0.6% (delivers +1.3%)  | +0.3%                      |
| uncontrolled miss rate | 5.7–6.9% vs controller  | (uncontrolled front-loads) |

AES is marginally _less_ fair in the Jain sense (a ~0.001 shift) because front-loading floors
concentrates early energy. `uncontrolled` still keeps deadlines better than any planner in the
non-taper family because it charges flat-out. We report these rather than lead with the
favourable numbers.

## 13. Ablation studies

The mechanism's three candidate regressions, each isolated:

1. **The acceptance bound in passes 1–2 only, cost shift untouched.** Fixes the EDF
   over-planning but leaves pass 3 free to re-introduce infeasible moves — the promise breaks
   again. _Conclusion:_ the cost-shift `acceptanceRoom` term is the load-bearing line; the
   envelope must be applied to **every** pass, not just the feasibility passes.
2. **Envelope on, front-loading off.** Floors served chronologically-emergency-first rather
   than front-loaded: shortfall rises above the H1 threshold on the taper family even though the
   envelope holds, because a flat floor served late lands in low-acceptance slots.
   _Conclusion:_ envelope alone is insufficient; front-loading is required for the floor to be
   honour-able.
3. **Envelope on, plan-honesty metric off.** The repair still works, but the defect becomes
   invisible again in the receipt — `delivered_kwh` looks fine and the 1,280 kWh gap is no
   longer printed. _Conclusion:_ the metric is part of the mechanism. A fix whose violation is
   unmeasurable is a fix that will silently regress.

Also measured: **H0 across the family boundary** — the target-80% arms are the ablation of the
_taper itself_ (set the knee above the SoC ceiling and AES must be a no-op), and it is, exactly.

## 14. Scalability analysis

The allocator change adds no asymptotic cost: `socBefore` is O(H) with H = 24, and the
allocator was already O(H·N) per pass with O(H) site-cap sums. Measured runtimes are dominated
by scenario generation, not allocation:

| level                | seeds | wall time (E6, 96-core x64, Node 20) |
| -------------------- | ----- | ------------------------------------ |
| 5 levels × 100 seeds | 500   | ~8 s total (receipt written)         |

At the scale the platform targets, the binding constraint is **not** the allocator but the OCPP
gateway and telemetry ingestion — `H` is horizon-bounded and the number of _concurrently
admitted_ vehicles per site is bounded by `C / P_min`. The relevant scale question is re-plan
frequency under the margin-erosion trigger (ADR-0014), which AES does not change: it makes the
_existing_ plan honest, not more frequent.

## 15. Security and trust consequences

Plan honesty is, at bottom, a **trust** property, and it has a security reading worth stating
without over-claiming:

- **A broken promise is a contract breach.** Under demand-response contracts, the certificate
  floor is the commitment. A dishonest plan cannot be detected from the CSMS's own planned
  metrics; it surfaces only as a downstream grid violation or an undelivered service. Making
  `η` a first-class metric moves a silent trust failure into the audit trail.
- **Do not confuse plan honesty with physical enforcement.** AES bounds what the CSMS
  _commands_. A non-compliant charger that ignores its profile can still exceed the site cap —
  our own E1b receipt measures this honestly (86.43 kW against a 40 kW cap, 46.4 kW of it from
  chargers that ignored their profiles). **Protocol-level scheduling cannot police a wilful
  device; per-connector breaker protection is physical.** Claiming otherwise would be the exact
  dishonesty this paper exists to prevent. AES makes the _honest_ case honest; it does not make
  a rogue device compliant.
- **One physics model is also a smaller attack surface.** Three private copies of `φ` are three
  things that can be tampered with, mis-configured or drift; one imported definition is one
  place to review, test and audit.

## 16. Limitations

1. **Synthetic, deterministic workload.** All results come from a generative twin, not from a
   physical charger fleet. The twin encodes `φ` and non-compliance; it does not encode thermal
   derating, cell imbalance, or charger firmware quirks. External validity is therefore
   **untested**, and we claim no field result.
2. **`φ` is a labelled approximation, not a battery model.** It is designed to make one fact
   true in one place. A real battery model would change the constants, not the argument — but
   the argument is validated only for this approximation.
3. **Horizon-bounded, single-site experiments.** H = 24, dt = 15 min, sites of ~5–20 connectors.
   Longer horizons, sub-minute control and multi-site coupling are untested.
4. **No hardware-in-the-loop and no real OCPP charger in the loop.** The control plane is
   driven end-to-end through HTTP against the durable stack in one e2e suite, but the meters
   are simulated.
5. **The comparison class is small.** We compare against three baselines and the pre-fix
   allocator. We do **not** compare against a MILP/MPC/RL scheduler, so we claim no
   state-of-the-art optimality; we claim plan honesty and cost/kWh against the industry default.
6. **Single-site economics.** Demand-charge modelling is present in the harness but the
   site-level tariff structure is simplified.

## 17. Future work

1. **Acceptance-aware optimisation.** Add the acceptance constraint to an LP/MILP formulation
   and measure the optimality gap AES leaves. The envelope is solver-independent by design:
   any optimiser inherits it by calling `acceptanceFactor`.
2. **MPC under forecast uncertainty.** Does plan honesty interact with forecast error? We
   expect no (the defect is a modelling disagreement, not a forecast error) but it is
   untested.
3. **Learned schedulers with `η` in the reward.** Instrument plan honesty as a training signal
   and test whether it changes learned policies.
4. **Real fleet validation.** The obvious next experiment: OCPP-metered traces from production,
   with `η` computed from metered acceptance rather than modelled acceptance.
5. **Plan honesty across a fleet of sites.** Does an honest per-site planner compose into an
   honest distribution-network-level plan? The relaxed `cost_lower_bound` suggests the
   question is well-posed.

## 18. Conclusion

We found, measured, and repaired a class of silent failure in EV charging control: an
allocator that reasons about power while the certifier reasons about the battery produces plans
that claim energy the battery cannot absorb — and the failure is invisible in every planned
KPI. We named the property **plan honesty** (`η = K(x) − D(x)`), showed it is violated by
1,280 kWh per 100 site-days in our own system and drives a 42.6% promise shortfall, and
contributed **acceptance-envelope scheduling**: a single-physics invariant plus an O(H·N)
allocator modification that makes `η ≈ 0` by construction. AES cuts the shortfall to 2.36%,
deadline misses from 56.6% to 15.7%, and is **bit-identical to the incumbent allocator below
the taper knee** — so the change is shippable and provably inert where the taper does not bind.
The wider lesson is methodological: a plan and a plant that share one physics definition cannot
lie to each other, and the metric that proves it belongs in the receipt.

---

## Appendix A — Reproducibility

```bash
npm install
npm run bench:e6     # this paper's results  → bench/results/e6-taper.json
npm run bench:e3     # the pre-fix record    → bench/results/e3-deadline.json (unmodified)
npm run bench:e1b    # cost / calibration   → bench/results/e1b-cost.json
node apps/api/test/control-aes.js   # A1–A4 property tests (mechanism invariants)
npm test             # full suite: control, twin, security, xlayer, invariants, openapi drift
```

Receipts are regenerable from their seeds alone (fixed UTC anchor, no wall clock, no local
timezone). Results that exist are never edited; a repair is a new experiment id.

## Appendix B — Notation

| symbol           | meaning                                                     |
| ---------------- | ----------------------------------------------------------- |
| `T = {1…H}`      | planning horizon, `dt` hours per slot (H = 24, dt = 0.25 h) |
| `x_{i,t}`        | energy (kWh) allocated to vehicle `i` in slot `t`           |
| `P_i`, `C`       | connector nameplate, site power cap (kW)                    |
| `B_i`, `s_i`     | battery capacity (kWh), state of charge (fraction)          |
| `a_i`, `d_i`     | arrival and deadline slots (hard windows)                   |
| `R_i`, `floor_i` | remaining energy requirement (kWh), certified floor (kW)    |
| `φ(s)`           | CC-CV acceptance factor (knee `κ = 0.8`, floor `0.15`)      |
| `A_{i,t}`        | acceptance envelope: `P_i·φ(s_{i,t−1})·dt`                  |
| `K(x)`, `D(x)`   | claimed and compliant-delivered energy of plan `x`          |
| `η(x)`           | plan-honesty gap `K(x) − D(x) ≥ 0`                          |

## Appendix C — Reference list (draft, to be verified before submission)

The related-work section is organised by approach class. The following are the standard
touchstone references for those classes and **must be checked, completed and formatted** with
the target venue's style before any submission; no citation here should be treated as verified.

- Coordinated / centralised EV charging to minimise cost and distribution impact
  (`Sortomme et al.`; `Clement-Nyns et al.`).
- Optimal decentralised / valley-filling charging protocols (`Gan, Topcu & Low`;
  `Ma, Callaway & Hiskens`).
- Reviews of smart-charging approaches and grid integration
  (`Richardson`; `García-Villalobos et al.`).
- Charging-session / battery acceptance modelling and CC-CV taper literature.
- MPC and learning-based charge scheduling.
- OCPP 1.6J / 2.0.1 smart-charging profile semantics (Open Charge Alliance specifications).

Documentation of _this_ system's decisions lives in `docs/adr/` (ADR-0010–0015), and the
committed experiment log in `docs/perf.md`.
