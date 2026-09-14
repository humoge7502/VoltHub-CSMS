# VoltHub CSMS — Recruitment / Portfolio Dossier

**Status:** portfolio positioning, 2026-09-14. Everything claimed here must be demonstrable in
the repository — if a claim cannot be reproduced from a committed script or test, it does not
belong on a résumé. Nothing here guarantees interviews, offers, or employment.

---

## 1. The three pitches

**30-second (recruiter / screen).**

> I built an OCPP EV-charging management system — the software a charging network runs on — with
> a real control loop: it certifies what it can promise, plans charging under a site power cap,
> sends the plan to chargers and verifies what actually happened. The interesting part: I found
> a class of silent bug where the planner claimed energy the batteries physically couldn't
> absorb — 1,280 kWh per 100 site-days — and no standard metric could see it. I defined the
> metric that does, fixed the allocator, and cut failed promises from 43% to 2.4% while proving
> the change is a no-op on the fleets it shouldn't affect. It's all benchmarked with
> committed, reproducible receipts.

**2-minute (hiring manager / technical screen).**

> VoltHub is a CSMS for OCPP 1.6J chargers — think the backend that ChargePoint or Driivz runs.
> Two storage engines: Oracle for transactional state (users, tariffs, sessions, certificates)
> and TimescaleDB for meter telemetry, joined by an outbox→relay pipeline with crash-safe replay.
> The core is a control loop: **certify** — a worst-case feasibility check that issues a durable
> certificate with a floor power commitment; **schedule** — a deterministic three-pass allocator
> (certified floors → earliest-deadline-first fill → cost shift) under a site cap; **actuate** —
> compile to OCPP smart-charging profiles with CALLRESULT ack correlation; **verify** — compare
> metered kW against the profile that was actually in force.
>
> The research contribution came from auditing my own system. I'd built a taper-aware certifier
> — batteries stop accepting full power past ~80% SoC — but the allocator only reasoned about
> power. So it shifted energy into cheap late intervals where the battery couldn't take it: the
> plan was infeasible, the promise broke, and **every planned metric looked fine**, because the
> metrics were computed from the plan, and the plan didn't know about the taper. That's the
> failure mode — it's invisible unless you instrument the gap between claimed and deliverable
> energy. I built a deterministic simulator ("digital twin") to measure it: 42.6% of certificates
> shortfell and the planner claimed 1,280 kWh/100 site-days it could never deliver.
>
> The fix, acceptance-envelope scheduling: make the allocator consume the same acceptance
> function the certifier and the simulator already shared — one physics model, three consumers —
> and bound _every_ allocation, including the economic re-allocation, by the destination
> interval's acceptance headroom. Shortfall went 42.6% → 2.36%, deadline misses 56.6% → 15.7%,
> the honesty gap 1,280 kWh → 0.011 kWh, and cost per kWh delivered actually _fell_. Below the
> taper knee it's bit-identical to the old allocator — I pinned that as a property test, because
> a fix you can't prove is inert on the compliant case isn't shippable.
>
> Throughout, the discipline is what I'd want to be judged on: pre-registered hypotheses, paired
> seeds, bootstrap confidence intervals, receipts anchored to a fixed UTC epoch so they
> regenerate from their seeds alone — and the original failing receipt committed next to the
> repair, because a benchmark you edit to show your fix is a marketing artefact, not evidence.

**Technical depth (a peer / staff engineer).** Same as above, then: the multi-tenancy and RBAC
scoping, the concurrency work (`SELECT … FOR UPDATE`, `SKIP LOCKED` bulk expiry, idempotency
keys, error-band mapping from Oracle `RAISE_APPLICATION_ERROR` numbers to HTTP once), the
outbox/DLQ semantics and at-least-once dedupe, the OpenAPI drift gate, and the two-engine parity
testing (`STORE=oracle` suites) that catches "works locally, broken on the durable engine" bugs.

## 2. Component → skill map

| Repository component                                     | Skills demonstrated                                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/api/src/control/` (certify/plan/compile/verify)    | Algorithm design, heuristic vs certified feasibility, deterministic systems, domain modelling        |
| `apps/simulator/src/twin.js` + `offline.js`              | Simulation, reproducibility engineering, experimental design, statistical reporting (bootstrap CIs)  |
| `bench/e6-taper.js`                                      | Pre-registration, ablation methodology, hypothesis testing, honest negative-result handling          |
| Oracle PL/SQL schema + packages + triggers               | Relational design (BCNF), transactions, concurrency control, least-privilege, stored-procedure logic |
| TimescaleDB hypertables + continuous aggregates + outbox | Time-series modelling, materialised views, write-path design, ingestion pipelines                    |
| OCPP gateway + smart charging profiles                   | Protocol implementation (WebSocket, auth, state machines), interoperability, standards reading       |
| Auth/RBAC/tenant scoping + security tests                | AppSec: JWT/refresh rotation, argon2 hashing, horizontal-privilege checks, rate limiting, audit logs |
| `openapi` generation + drift gate, CI matrix             | API design, contract testing, CI/CD, "docs are code" discipline                                      |
| Docker/compose, migrations, seed scripts                 | DevOps, reproducible local environments, schema evolution                                            |
| 200+ tests across 14 suites                              | Testing strategy: unit, integration, contract, race, security, property-based, e2e                   |

## 3. Interview questions this project invites — and strong answers

**Distributed systems / reliability**

1. _Your API and your telemetry store are separate systems. How do you guarantee an event isn't
   lost or double-counted?_ — Transactional **outbox**: the API writes state + an outbox row in
   one transaction; a relay copies rows to Timescale and acks; crash-after-COPY replays are safe
   because the consumer is idempotent on `event_id`; a dead-letter path catches poison events;
   delivery is **at-least-once**, not exactly-once, which is the only honest claim over a network.
2. _What's your consistency model?_ — Strong consistency on the OLTP engine for money and
   session state; **eventual consistency** for analytics/telemetry (caggs lag by design).
   Certificate issuance is a transaction against the OLTP engine, so an admitted promise is
   durable before it is dispatchable.
3. _What happens on a partition between the CSMS and a charge point?_ — The plan is durable on
   our side; dispatch is retried with idempotency per `(cp, decision)`; silence is swept to an
   explicit `ACK_TIMEOUT` rather than assumed success; the vehicle keeps charging at whatever
   profile was last in force, which is why the profile we sent is persisted, not just logged.
4. _Why a modular monolith and not microservices?_ — ADR-0001. One team, one deployable, strong
   transactional boundaries (certificates ↔ sessions ↔ tariffs) that would otherwise need
   sagas. The seams are already drawn as ports/adapters, so a specific bottleneck can be
   extracted; extracting on spec would buy operational cost with no measured benefit.

**Databases**

5. _Why two databases?_ — Different access patterns: OLTP needs row-level locking, FKs,
   transactions; telemetry is append-heavy, time-ordered, aggregated. Timescale adds hypertable
   partitioning and continuous aggregates so the load curve is a rollup scan, not a raw scan.
6. _How do you keep the Oracle and local engines from diverging?_ — Both implement the same
   **store port**; a `STORE=oracle` CI job runs the same suites against a real Oracle container.
   That asymmetry is exactly how I found several "works locally, 500s on Oracle" bugs.
7. _Optimistic vs pessimistic locking here?_ — Pessimistic where correctness is money
   (`SELECT … FOR UPDATE` on wallets/reservations) and `SKIP LOCKED` for bulk expiry so workers
   don't convoy on the same rows.

**Control / optimisation**

8. _Why a heuristic instead of a MILP?_ — The shipped solver is the one the benchmark measures;
   the LP is a _reference bound_. A MILP gives an optimal objective, not a deliverability
   guarantee, and the failure I was fixing was a modelling disagreement, not suboptimality. The
   envelope is expressed so an LP/MILP inherits it as an extra constraint later.
9. _What is plan honesty, formally?_ — `η(x) = K(x) − D(x)`, claimed minus compliant-deliverable
   energy. `η = 0` iff every allocation is within the acceptance envelope
   `x_{i,t} ≤ P_i·φ(s_{i,t−1})·dt`. Above the knee `φ` decays, so back-loading breaks it;
   front-loading floors plus an acceptance-bounded cost shift restores it.
10. _Why is that a *cost* pass's problem?_ — Because the feasibility passes can be correct and
    the **economic** pass re-introduces infeasible energy by moving it into cheap late intervals.
    The load-bearing line is bounding that move by destination _acceptance_ headroom, not just
    capacity headroom. That's the ablation that proves causality.

**Systems design / scale**

11. _How does this scale to 100k chargers?_ — Documented exits, not a rewrite: the Maps read-cache
    becomes read-through (Redis justified at multi-VM), the OCPP gateway shards by identity hash
    past ~50 CPs/VM, and telemetry scales by Timescale partitioning + the relay consumer group.
    Each is triggered by a measurement, not a vibe.
12. _Where's the first bottleneck?_ — The OCPP gateway's per-connection memory and the write path
    on telemetry ingestion, not the allocator (which is O(H·N) with H = 24).

**Security**

13. _A charger is compromised. What can it do?_ — It already has a per-CP credential; the blast
    radius is bounded by tenant/site scoping and the fact that profiles are commands, not
    capabilities. It can lie about its meter — which is precisely why the verifier compares
    _scheduled vs metered_ kW instead of trusting either, and why **plan honesty is about
    commands, not device behaviour** (a rogue charger can and does exceed the site cap — 86 kW
    vs 40 kW, measured).
14. _How do you stop horizontal privilege escalation?_ — Every operator route resolves the
    station from the token's scope and 403s `OUT_OF_SCOPE`; the regression suite includes
    cross-tenant probes (analytics, cancel, remote-start, active-session minimisation), because
    scoping bugs are invisible until someone asks for the wrong ID.

**Honesty / judgement (the questions that actually differentiate)**

15. _What's the weakest part of this project?_ — External validity. Every result is from a
    deterministic simulator; there is no hardware-in-the-loop and no real fleet, so I can claim a
    modelled technical effect, not a field result. The twin models the taper and non-compliance,
    not thermal derating or firmware quirks.
16. _What did you get wrong?_ — I shipped a certifier that reasoned about batteries and an
    allocator that reasoned about power, and I published the resulting failure rather than hiding
    it. The original receipt is still committed. The lesson I'd bring to a team: **if two
    components model the same physical system, they must not have two copies of the model — and
    every plan must carry the metric that proves it is deliverable.**

## 4. Résumé bullets (only demonstrable claims)

- Designed and implemented an OCPP 1.6J CSMS control loop (certify → plan → actuate → verify)
  over Oracle + TimescaleDB, with durable feasibility certificates and ack-correlated dispatch.
- Identified and repaired a silent class of scheduling defect ("plan honesty") in my own system:
  measured **1,280 kWh/100 site-days** of undeliverable charging plans invisible to planned cost,
  peak and fairness metrics; reduced certificate shortfall **42.6% → 2.36%** and deadline miss
  **56.6% → 15.7%**, with a **bit-identical no-op** proven below the taper knee.
- Built a deterministic digital-twin experiment harness with pre-registered hypotheses, paired
  seeds, bootstrap CIs and receipts reproducible from their seeds alone (fixed UTC anchor).
- Implemented transactional-outbox telemetry ingestion (at-least-once, idempotent, DLQ) and
  two-engine parity testing (Oracle + local) across 14 test suites / 200+ assertions.

## 5. Artifacts worth opening in an interview

| Artifact                                            | Why it lands                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `docs/adr/0015-acceptance-envelope-scheduling.md`   | The full reasoning: problem, decision, measured evidence, rejected alternatives     |
| `bench/e6-taper.js` + `bench/results/e6-taper.json` | Pre-registered hypotheses and the raw receipt (including the honest trade-offs)     |
| `apps/api/test/control-aes.js`                      | The mechanism's invariants as executable properties (A1–A4)                         |
| `apps/api/src/control/model.js`                     | One acceptance function, three consumers — the invariant in code                    |
| `docs/perf.md`                                      | The failure (E3) and the repair (E6) side by side, neither edited                   |
| `docs/research/paper.md`                            | The contribution written up as a paper, limitations first-class                     |
| `docs/patent/invention-disclosure.md`               | Intellectual-honesty discipline: novelty boundary, eligibility risks, no over-claim |

## 6. What NOT to say

- "It will make huge profits" — there are no customers. Say the business is a _hypothesis_.
- "It's patentable" — counsel has not looked at it; the disclosure says so explicitly.
- "It scales to a million chargers" — untested. Say _which_ measurement triggers _which_ exit.
- "It's novel research" — it is a systems/measurement contribution with honest limits, not a
  new algorithm class. Say what it is and let the receipts make the argument.
