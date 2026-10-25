# VoltHub CSMS — Investor One-Pager (2026-10)

**One line:** the charge-point-operator platform whose every claim is provable — two
database engines behind one transaction boundary, race-tested in CI on every push, priced
per connector with the price published.

## Problem

CPOs run charging on software they cannot audit. Incumbents (Driivz, Ampcontrol) sell
opaque per-quote platforms; budget open-source (SteVe) lacks smart charging and telemetry;
billing disputes ("why was I charged for 500 kWh I never received?") are unanswerable
because the software can't show its work. The CSMS software market is **$3.4B (2025)
growing 24.8%/yr** (GM Insights), with per-connector monthly pricing the dominant model
($10–50/port/month; MRFR, Kodenique, AmpUp 2026 buyer's guides).

## Product

VoltHub CSMS: OCPP 1.6J gateway, Oracle 23ai money path (35 tables, 8 PL/SQL packages),
TimescaleDB telemetry (hypertables, caggs, compression), in-transaction outbox relay
(effectively-once, zero broker), prepaid **signed wallet rail** (EIP-191, one credit per
signature, no card data ever), a driver console and an operator console, and the
**FC-HCC control loop** — certify → plan → actuate → verify smart charging with measured
results: cost −46.7 vs static caps (E1b, 95% CI), shortfall 42.6% → **2.36%** (E6).

## Why it wins (the moat, each item a repo receipt)

1. **Provability as a feature.** Races proven in CI on both engines; every benchmark has
   a script + committed receipt; the OpenAPI is drift-gated. Switching away means giving
   up the audit trail — retention is architectural.
2. **The two-engine transaction boundary** is genuinely hard engineering (Oracle row
   locks + Timescale hypertables joined by an idempotent relay) — hard to fake, slow to copy.
3. **The control loop ships with negative results published** (E3) — evidence the
   benchmarks are honest, which is exactly what a fleet energy manager is buying.
4. **Transparent pricing against opaque incumbents** — $12/connector (Network) or
   $29/connector with the control loop (Grid), self-host or SaaS at the same price.

## Business model (full detail: `docs/business-model.md`)

- **Garage** free self-host ≤ 10 connectors (open-core funnel; the one-command public
  demo tunnel is the sales call).
- **Network** $12/connector/mo · **Grid** $29/connector/mo (adds smart-charging control
  loop + forecast rail). Annual −15%. No setup fee.
- Infra < 4% of revenue at launch scale (single-VM compose, p95 < 300 ms in k6 smoke).

## Traction assets (today, in the repo)

23-route Next.js 16 console (dark "Grid Current" design system, command palette,
count-up live telemetry), 72-path OpenAPI drift-gated API, 14 test suites + race suites +
SQL/JS invariant mirror + e2e control-plane journey all green, conformal-interval demand
forecaster with MASE-baselined backtests, public live demo (cloudflared), demo film
pipeline, 16 ADRs including wallet rail and control-loop closure.

## The ask / use of funds

Fund the OCPP 2.0.1 + ISO 15118 Plug & Charge gateway (the standards moat), OCPI 2.2.1
roaming (network revenue), and the first 10 design-partner CPOs on the Garage tier.
Every dollar ships with a receipt.

---

_Sources for market figures: GM Insights (market size/CAGR), Fortune Business Insights
(station market), Market Research Future (pricing-model prevalence), Kodenique + AmpUp
buyer's guides and public pricing pages (per-port ranges). Full table with links:
`docs/business-model.md`._
