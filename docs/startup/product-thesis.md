# VoltHub CSMS — Product & Startup Thesis

**Status:** internal product hypothesis, 2026-09-14. **Not** a business plan, **not** a
forecast, **not** a claim of traction. There are no customers, no revenue, and no pilots as of
this writing. Every number below is an **assumption with its arithmetic shown**, so it can be
attacked, corrected, or falsified. Nothing here guarantees funding, profit, or success.

---

## 1. What the product actually is (today)

A two-engine **charging station management system (CSMS)** for OCPP 1.6J charge points:

| Layer                    | What exists in this repository                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OCPP 1.6J gateway        | WebSocket, HTTP-Basic on upgrade, per-CP credentials, core messages + Smart Charging profiles                                                                           |
| Durable data             | Oracle OLTP (29-relation schema, PL/SQL packages, state-guard trigger, least-privilege role) + TimescaleDB telemetry (hypertables, continuous aggregates, outbox relay) |
| Control loop             | sense → **certify** (worst-case, taper-aware) → **schedule** (acceptance-envelope) → compile → actuate (ack-correlated) → verify against metered kW                     |
| Simulator / digital twin | deterministic generative fleet (arrivals, SoC, CC-CV acceptance, ToU prices, non-compliant chargers)                                                                    |
| Experiments              | pre-registered, paired-seed benchmarks with committed receipts and bootstrap CIs                                                                                        |
| Interfaces               | 66 spec'd HTTP paths (OpenAPI with a CI drift gate), 17-route operator/driver web UI                                                                                    |

**The one-line product claim:** _a CSMS whose plans are the plans your chargers can actually
execute_ — and can prove it, per plan, in an audit trail.

That claim is backed by a measured mechanism (ADR-0015, `docs/research/paper.md`): on a
taper-bound fleet the shipped allocator cut certificate shortfall **42.6% → 2.36%** and deadline
miss **56.6% → 15.7%**, closing a **1,280 kWh** plan-honesty gap to **0.011 kWh** with **zero
change** to fleets that never charge past 80% SoC.

## 2. Who would pay, and for what

| Segment                                  | Job to be done                                                       | What they buy                                                    |
| ---------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **CPO (SME operator, 20–500 CPs)**       | Keep promises to drivers; avoid demand charges; avoid vendor lock-in | Hosted CSMS + smart charging that respects a real site cap       |
| **Fleet operator (last-mile, delivery)** | Every van must be ready by its departure time                        | Fleet charging with deadline guarantees and honest feasibility   |
| **Workplace / apartment / hotel**        | Charge many cars on a small supply                                   | Load-managed charging behind an existing breaker                 |
| **Demand-response aggregator**           | Commit a _reliable_ load-reduction and prove it                      | Certificates with honoured floors + the plan-honesty audit trail |

The honest read: the **fleet operator** and **aggregator** segments are where the plan-honesty
property is worth money, because they are the ones who sign a commitment and then have to
_prove_ it was met. The workplace segment buys simplicity, not sophistication.

## 3. Competitive landscape (assumptions, to be validated)

Publicly known platforms in this space include **Driivz, AMPECO, Monta** (CSMS/smart-charging
software), and **ChargePoint, EVgo, Shell Recharge, BP Pulse** (network operators with their own
platforms), plus equipment vendors with management software (**ABB, Siemens, Schneider**).

> **Honesty note.** The capability-by-capability comparison below is **assumption, not verified
> fact**. These vendors' internal architectures are not public. Any claim about a competitor's
> gaps in a real pitch must be verified by hands-on evaluation and customer interviews first.
> The author has **not** benchmarked against any commercial CSMS.

The _hypothesis_ about the gap: incumbents compete on **breadth** (payment rails, roaming,
apps, fleet portals, whitespace). The claim of this project is orthogonal: **provable plan
honesty under a hard site cap**, with a public, reproducible benchmark discipline. Whether that
gap is real and monetisable is the single most important thing to test with customers, and it
has not been tested.

## 4. Differentiation — and an honest moat assessment

**Differentiators (technical, verifiable today):**

1. **The mechanism.** Accept-bound economic re-allocation plus a computed plan-honesty metric
   (ADR-0015). Competitors may already do the first part privately; the second part (publishing
   `claimed − deliverable` per plan) is unusual.
2. **The benchmark discipline.** Pre-registered hypotheses, paired seeds, committed receipts,
   fixed UTC anchors, and a _published failure_ kept beside its repair. Most projects cannot
   show this, and it is the thing that makes every other claim checkable.
3. **Certificates as durable, auditable rows.** A promise is a persisted object with a status,
   a floor, and an enforcement history — useful for DR settlements.

**Honest moat assessment — this is weak, and saying so is the point:**

- The **algorithm is not a moat.** It is ~40 lines of JS around a shared acceptance function.
  An incumbent with a good team copies the idea in a sprint once it is public.
- The **real moat candidates** are: (a) _data_ — metered acceptance curves and compliance
  behaviour from a real fleet, which no competitor can copy and which improves the model;
  (b) _switching cost_ — a CSMS accumulates tariff versions, sessions, invoices and audit
  history; (c) _IP_ — only if counsel finds the mechanism patentable, which is unproven
  (see `docs/patent/invention-disclosure.md`); (d) _distribution_, which this project does not
  have at all.
- **Conclusion:** the moat is speculative. The technology is a credible wedge, not a fortress.

## 5. Pricing possibilities (assumptions)

| Model                    | Assumption                                               | Note                                                                                       |
| ------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Per-charger SaaS         | ₹/$ 8–20 per charger / month, tiered by features         | The industry-standard shape; price is an assumption                                        |
| Per-session fee          | small fixed fee per completed session                    | Aligns with growth, punishes over-charging                                                 |
| Optimization / DR module | uplift % of measured demand-charge or DR revenue avoided | **Needs a validated measurement method** — the plan-honesty metric is a candidate baseline |
| Enterprise licence       | annual, self-hosted or dedicated tenancy                 | For operators who cannot use shared tenancy                                                |
| API / white-label        | per-call or per-CP for partners                          | Post-MVP only                                                                              |

## 6. Unit economics — arithmetic with explicit assumptions

These are **illustrative scenarios**, not projections. Change any assumption and the answer
changes. Currency is a single unit (call it "revenue units", RU).

**Baseline assumptions (all unvalidated):**

- A: average customer = **50 managed charge points**.
- B: price = **RU 12 / charger / month** → **RU 600 MRR / customer**, **RU 7,200 ARR / customer**.
- C: cloud + infra marginal cost ≈ **RU 1.5 / charger / month** → **RU 75 / customer / month**.
- D: support ≈ 0.5 engineer-hour/customer/month at RU 40/h → **RU 20 / customer / month**.
- E: gross margin ≈ (600 − 75 − 20) / 600 ≈ **84%**.
- F: CAC assumption = **RU 3,000** (founder-led sales, trade shows, inbound).
- G: payback = 3,000 / (600×0.84) ≈ **6 months**. Churn assumed 1%/month.

**Scenario table (revenue arithmetic only — no profit claim):**

| Customers | Charge points | MRR        | ARR        | Gross profit / month (≈84%) |
| --------- | ------------- | ---------- | ---------- | --------------------------- |
| 5         | 250           | RU 3,000   | RU 36,000  | RU 2,520                    |
| 25        | 1,250         | RU 15,000  | RU 180,000 | RU 12,600                   |
| 100       | 5,000         | RU 60,000  | RU 720,000 | RU 50,400                   |
| 500       | 25,000        | RU 300,000 | RU 3.6M    | RU 252,000                  |

**What these tables hide (the part that kills companies):** founder time is not costed; support
load grows super-linearly with _heterogeneous_ hardware, not with CP count; enterprise sales
cycles are 6–12 months; hardware/OEM certification gates access; and one large customer churning
can erase 20% of MRR. **No profit is promised or implied.**

## 7. Go-to-market, realistically

1. **Wedge:** the _deadline-guarantee_ claim for fleet operators — a segment that feels the pain
   in money and can pilot fast.
2. **Proof asset:** the benchmark receipts. Lead with "here is the failure we found in our own
   system and the receipt that shows it fixed" — credibility that most vendors cannot match.
3. **Channel:** OEM/installer partnerships and OCPP-agnostic onboarding (import an existing CP
   fleet without re-hardware). Distribution is the hard part.
4. **Regulatory tailwind:** demand-response programs and grid-connection limits are increasing
   the value of provable smart charging. (Assumption; jurisdiction-dependent.)

## 8. What to build now vs later — and what never to build

**Build now (already exists or is the next step):** the control loop, the certificates, the
benchmark harness, onboarding for a real OCPP charger, one real customer pilot.

**Build later (only after a pilot):** billing/payments hardening, roaming (OCPI), mobile app,
multi-region, SSO/enterprise admin, ML forecasting — each is real, but none is the wedge.

**Do NOT build (complexity without value at this stage):**

- **Blockchain-based energy trading.** No customer is asking; it solves a settlement problem
  that a database transaction already solves.
- **A general-purpose LLM assistant.** A support chatbot is not a differentiator and invites
  hallucination into a safety-relevant control path. (An LLM nowhere near the actuation path
  is fine, later, and only if a real support-volume problem exists.)
- **Microservices for their own sake.** The modular monolith (ADR-0001) is the right shape until
  a measured bottleneck says otherwise.
- **A full battery electrochemical model.** More parameters than the data can identify; the
  labelled acceptance approximation is the honest choice (`docs/research/paper.md` §16).
- **Claiming physical enforcement of the site cap.** Protocol-level scheduling bounds _commands_;
  a rogue charger ignores them (measured: 86 kW against a 40 kW cap). Sell breaker protection
  for that job, and never market otherwise.

## 9. Risks (ranked)

| #   | Risk                                                     | Severity | Mitigation / status                                  |
| --- | -------------------------------------------------------- | -------- | ---------------------------------------------------- |
| 1   | **No distribution** — nobody finds the product           | critical | Partnership/OEM channel; not solved                  |
| 2   | Incumbents already do this; the wedge is not real        | high     | Must be falsified by customer interviews; not tested |
| 3   | Hardware heterogeneity (OCPP dialect bugs) eats margin   | high     | OCPP conformance testing; not done                   |
| 4   | IP unproven; mechanism easy to copy                      | medium   | Counsel review; not started                          |
| 5   | Regulatory/utility process varies by jurisdiction        | medium   | Pick one market first; not chosen                    |
| 6   | Solo-founder execution bandwidth                         | high     | Not solved                                           |
| 7   | Data deprivation (no real fleet → model stays synthetic) | medium   | One pilot fixes it; not started                      |

## 10. The honest one-paragraph thesis

If this becomes a company, it will be because a fleet operator or grid aggregator will pay for
**a charging plan that can be trusted and audited under a hard power limit**, and because this
project can demonstrate that trustworthiness with reproducible evidence rather than a slide.
The technology is real and measured; the business is entirely unproven, and every number in
this document is an assumption waiting to be falsified by a customer conversation this project
has not yet had.
