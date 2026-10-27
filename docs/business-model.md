# VoltHub Business Model — decided from market receipts (2026-10-24)

This document is the strategy record behind the pricing strip on the landing page.
Every market number carries its source; every product claim links to a repo receipt.
Research method: public pricing pages and buyer's guides (Oct 2026), CSMS market reports,
and the project's own audited capability set (`docs/comprehensive-review-2026-10-24.md`).

## 1. Market receipts

| Claim                                                       | Number                                                      | Source                             |
| ----------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------- |
| EV charging management software platform market (2025 base) | **$3.4B**, 24.8% CAGR 2026–2035                             | GM Insights, 2026                  |
| Broader EV charging station market                          | $22.93B (2026) → $139.93B (2034)                            | Fortune Business Insights          |
| Dominant pricing model for public networks                  | **per-connector monthly fees**                              | Market Research Future, 2026       |
| Typical SaaS CSMS price                                     | **$10–$50 / port / month** (enterprise builds $40K–$250K)   | Kodenique buyer's guide, 2026-10   |
| Commercial L2 network/software fees                         | $15–$75 / port / month                                      | AmpUp buyer's guide, 2026          |
| White-label cloud CSMS                                      | $3,000 onboarding + $10 / active connector / month          | Sock8 pricing page                 |
| Low-cost challenger                                         | €3.99 / station / month (positioned vs Driivz)              | ELVO pricing page                  |
| Startup tier                                                | $0 / mo ≤10 chargers + $1,500 setup; $10 / charger / mo     | Askacharge                         |
| Enterprise leaders                                          | **opaque, quote-based** (deployment size, modules, roaming) | Driivz, Ampcontrol RFP comparisons |

**Strategic read:** the market pays per connector; incumbents hide their price; the
credible open-source alternatives (SteVe: no smart charging/telemetry; CitrineOS: no
control-loop proof) don't have VoltHub's receipt discipline. The wedge is not "cheaper" —
it is **the only platform whose claims are provable**, at a price anyone can compute.

## 2. Ideal customer profile (in order)

1. **Small/mid CPOs (5–500 connectors)** running OCPP 1.6J hardware — priced out of
   Driivz/Ampcontrol, burned by opaque quotes, need reservations + billing + a driver
   console today, and smart charging next.
2. **Fleet depot operators** with demand-charge pain — the FC-HCC control loop's measured
   −46.7 cost units vs static caps (E1b) and 2.36% shortfall (E6) is their ROI receipt.
3. **Campus/workplace charging** (the current demo shape: Chennai corridor) — transparent
   pricing, prepaid wallet, no card-data compliance surface.

## 3. Pricing (published, per connector / month)

| Tier        | Price                       | Included                                                                                                                                   | Analogue                                                                        |
| ----------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| **Garage**  | free, self-host             | ≤ 10 connectors, full core (OCPP gateway, reservations, wallet, invoices, telemetry), community support                                    | Askacharge's free tier — but with no per-connector ceiling gotcha at 10         |
| **Network** | **$12 / connector / month** | unlimited connectors, multi-operator scoping, Grafana packs, signed wallet rail, priority support; SaaS **or** self-host at the same price | undercuts the $10–50 band's midpoint while publishing it                        |
| **Grid**    | **$29 / connector / month** | adds the FC-HCC control loop (certify→plan→actuate→verify), AI forecast rail, demand-charge receipts, V2G-ready schedule surface           | the Ampcontrol use-case, with published benchmarks instead of case-study claims |

Anchoring: Network at $12 sits below the band midpoint with a published price (the
anti-Driivz position); Grid at $29 prices the _measured_ optimization value (E1b/E6
receipts) at roughly one month of savings per port per quarter for a demand-charge-heavy
depot. Annual prepay −15%. Setup fee: none (the one-command demo is the onboarding).

## 4. Why customers stay (day-to-day job stories)

- A driver books a bay in the console in two clicks and **trusts** the reservation —
  overlap is impossible by construction (BR-05, race-tested).
- An operator watches faults auto-clear, sees the meter register base on every session,
  and never fields a "why was I overbilled" call (BUG-054 fix is user-visible).
- A finance owner reads the ledger: append-only, signed top-ups, one credit per
  signature — audit without a data team.
- An energy manager replays any day through the twin and sees plan-vs-actual honesty
  (plan-honesty gap 0.011 kWh per 100-seed run, E6).

Retention mechanics = the receipt discipline: every invoice line, every control decision,
every forecast interval is inspectable. Switching away means giving up the audit trail.

## 5. GTM & expansion

1. **Open-core funnel:** Garage self-host → the demo tunnel (`share-demo.sh`) IS the
   sales call — send a prospect a live URL in 30 seconds.
2. **Receipt-led content:** `docs/perf.md`, `docs/verification.md` and the benchmark
   receipts are the marketing; no case-study hand-waving.
3. **Land-and-widen:** start Garage on one site; Grid sells when the first demand-charge
   bill arrives; OCPI roaming (roadmap A-2) expands networks into roaming revenue.
4. **Moat compounding:** OCPP 2.0.1 + Plug & Charge (A-1) raises the bar faster than
   per-connector pricing lowers it.

## 6. Unit economics (SaaS tier, order-of-magnitude)

- Single-VM compose serves the demo scale (4 stations / 8 CPs / 82 paths, p95 < 300 ms
  in the k6 smoke); a Network customer at 100 connectors ≈ **$1,200 MRR** on infra a
  ~$40 VM handles — infrastructure cost < 4% of revenue at launch scale.
- Support load is bounded by the design: typed errors, request-ID envelopes, dead-letter
  triage, and docs that answer before the ticket does.

## 7. What investors see (see `docs/investor-one-pager.md`)

A market growing 24.8%/yr, a product whose every claim is CI-proven, a wedge that is
_transparency against opaque incumbents_, pricing the market already understands, and a
technical moat (two-engine transaction boundary + proven control loop) that took real
engineering and is very hard to fake.
