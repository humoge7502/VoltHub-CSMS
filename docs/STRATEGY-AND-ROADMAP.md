# VoltHub CSMS — Strategic Analysis, Fix Catalogue & Roadmap

**Version:** 1.8.1 · **Date:** 2026-10-24 · **Scope:** whole repository (`apps/*`, `packages/*`, `db/`, `infra/`, `scripts/`, `.github/`, docs)
**Method:** static audit of the codebase, live probing of the public deployment, and objective design linting with the Impeccable detector (62 deterministic rules) plus the rules distilled from `taste-skill`, `emilkowalski/skills`, and `nutlope/hallmark`.

---

## 0. Executive scorecard

| Dimension        | Grade  | Evidence                                                                                                                                  |
| ---------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture     | **A−** | Two-engine money/telemetry split, in-transaction outbox, OCPP gateway, clean module boundaries                                            |
| Test engineering | **B+** | 143 Node cases + race suite + invariants + OpenAPI drift gate + E2E + control-plane E2E + real Oracle/Timescale CI job                    |
| CI/CD            | **A−** | 6 jobs, Node 20+22 matrix, `npm audit` on both lockfiles, Codecov, web build                                                              |
| Frontend quality | **B**  | Strong design system (tinted shadows, documented contrast, `ease-out`, 4px scale); **zero tests**; 3 design anti-patterns found and fixed |
| Security posture | **C**  | Good CSP/headers/JWT design, but **default admin password is live on the public URL**                                                     |
| Deployment       | **C+** | Working public stack, but ephemeral quick tunnels and a demo-grade credential model                                                       |
| Documentation    | **A−** | 16 ADRs, DEPLOY, ARCHITECTURE, wallet guide; a few stale numbers (now corrected)                                                          |
| Maintainability  | **B+** | ~0 TODO markers, 0 `console.log` in API source, error boundaries present; web is plain JS (no types)                                      |

**One-line verdict:** this is a genuinely well-engineered system whose weakest links are **operational** (public credentials, ephemeral hosting, untested UI), not architectural.

---

## 1. Project analysis & strategic opportunities

### 1.1 What the product actually is

VoltHub is a **charge-point operating system (CSMS)** with an unusually strong correctness story:

- **Money path** — Oracle 23ai, PL/SQL packages, `FOR UPDATE` reservation guards, invoices that bill exactly once.
- **Telemetry path** — TimescaleDB continuous aggregates, 90/180-day retention.
- **One transaction boundary** — every `MeterValues` writes billing + analytics through an in-transaction outbox; a relay delivers at-least-once; idempotent replay makes it effectively-once.
- **OCPP 1.6J** gateway over WebSocket with Basic auth.
- **Wallet rail** — EIP-191/EIP-4361 signature ceremonies with amount binding and replay refusal.

### 1.2 Competitive landscape

The CSMS market splits into four camps:

1. **Full-stack operators** (Driivz, EVBox Everon, ChargeLab, AmpUp, Monta) — broad features, closed, expensive.
2. **Open-source cores** (Open e-Mobility, SteVe, ev-dashboard) — free, but weak on money-path integrity and observability.
3. **Hardware-bundled** (ABB, Siemens, Alpitronic) — locked to hardware.
4. **Payment/roaming layers** (Monta, Hubject, Gireve) — strong on roaming, thin on operations.

**Where VoltHub can win:** the intersection nobody owns well — _open, auditable, transactionally provable operations_. Competitors claim "no double-booking"; VoltHub can **prove** it with a reproducible race test and a public receipt.

### 1.3 Differentiation vectors (ranked by defensibility)

| #   | Vector                                                                           | Why it is defensible                                         | Proof asset to ship                                              |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| D1  | **Provable correctness** (201/409 race test, SQL invariants, OpenAPI drift gate) | Hard to copy without re-architecting; becomes a trust brand  | `npm run test:race` transcript, CI badge, public "receipts" page |
| D2  | **Two-engine honesty** (money vs telemetry, no dual-write divergence)            | Most competitors hide a single brittle DB                    | Architecture diagram + outbox lag metric on the landing page     |
| D3  | **Open protocol surface** (OCPP 1.6J now, 2.0.1 next; OCPI roadmap)              | Interop is the buying criterion for CPOs                     | Conformance matrix, simulator fleet                              |
| D4  | **Wallet-native settlement** (signature-bound amounts, replay refusal)           | Differentiates from card-only incumbents; strong in India/EU | ADR-0016 + live ceremony                                         |
| D5  | **Measured, not claimed** (benchmarks in repo)                                   | Rare in this segment                                         | `docs/benchmarks.md`, k6 results in CI                           |

### 1.4 Strategic opportunities (with measurable targets)

| Opportunity                                                  | Target metric                                                 | Effort | Why now                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------- | ------ | --------------------------------------- |
| **Publish a live "correctness receipt" page**                | Public page renders the latest race/invariant/OpenAPI results | 2–3 d  | Turns D1 into marketing, not a claim    |
| **OCPI 2.2 roaming (CPO + EMSP roles)**                      | One roaming handshake demoed end-to-end                       | 3–4 wk | Unlocks B2B deals; table stakes in EU   |
| **Smart Charging (OCPP 1.6 SmartCharging + 2.0.1 profiles)** | Load-managed site demo (cap 100 kW across 6 bays)             | 3–4 wk | Grid operators pay for this             |
| **Dynamic tariff engine** (ToU + carbon intensity)           | Price shown per session, billed correctly                     | 2 wk   | Direct revenue lever for CPOs           |
| **Driver mobile app** (Expo)                                 | iOS/Android build + deep links                                | 4–6 wk | Consumer acquisition channel            |
| **Multi-tenant + SSO**                                       | 2 tenants isolated, SAML login                                | 4 wk   | Required to sell to enterprises         |
| **Anomaly/fraud detection on meter values**                  | Precision/recall on seeded fraud set                          | 3 wk   | Protects margin; extends the AI sidecar |
| **White-label theming**                                      | One env var rebrands the console                              | 1 wk   | Reseller channel                        |

### 1.5 Positioning statement

> **VoltHub is the open CSMS you can audit.** Reservations cannot double-book, invoices cannot bill twice, and every meter tick is provably in both the money path and the analytics path — with the tests that prove it shipped in the repo.

---

## 2. Issues & required fixes

Severity = business/security impact. Priority = severity × user exposure. Effort is engineer-days unless noted.

### 2.1 Catalogue

| ID     | Issue                                                                                                     | Severity     | Priority | Effort  | Depends on                    | Timeline        |
| ------ | --------------------------------------------------------------------------------------------------------- | ------------ | -------- | ------- | ----------------------------- | --------------- |
| ISS-01 | **Default admin password live on the public URL** (`admin@volthub.in / Admin@123` returns an ADMIN JWT)   | **Critical** | **P0**   | 0.5 h   | —                             | **Immediately** |
| ISS-02 | **Web app has zero automated tests** (17 pages / 39 files, no test script)                                | High         | P1       | 3–5 d   | Playwright harness            | 2 weeks         |
| ISS-03 | **`apps/ai` is orphaned**: pytest suite never runs in CI, no Dockerfile, absent from compose              | High         | P1       | 2–3 d   | —                             | 2 weeks         |
| ISS-04 | **Access token in `localStorage`** (15-min TTL; the refresh token is already an httpOnly/SameSite cookie) | Medium       | P2       | 2–3 d   | in-memory access token + CSRF | 3 weeks         |
| ISS-05 | **Ephemeral deployment**: quick-tunnel URL changes on restart; host must stay on                          | Medium       | P2       | 0.5–1 d | Domain or Cloudflare account  | 1 week          |
| ISS-06 | **Load tests not gated**: `test:load` silently skips without k6                                           | Medium       | P2       | 1 d     | k6 in CI                      | 2 weeks         |
| ISS-07 | **`apps/web` outside npm workspace** — local `test`/`lint`/`coverage` skip it                             | Medium       | P3       | 0.5 d   | —                             | 1 month         |
| ISS-08 | **Dual lockfiles** (root + `apps/web`) — dependency drift risk                                            | Low          | P3       | 0.5 d   | ISS-07                        | 1 month         |
| ISS-09 | **AI requirements unpinned** (`torch>=2.1`, …) — non-reproducible builds                                  | Medium       | P3       | 0.5 d   | —                             | 1 month         |
| ISS-10 | **No coverage threshold**; Codecov `fail_ci_if_error: false`                                              | Low          | P3       | 0.5 d   | —                             | 1 month         |
| ISS-11 | **Stale "66 paths"** on landing page (actual: 72)                                                         | Low          | P3       | —       | —                             | **Fixed**       |
| ISS-12 | **3 design anti-patterns** (hero eyebrow chip, Inter at 66%, kicker-above-heading)                        | Medium       | P2       | —       | —                             | **Fixed**       |
| ISS-13 | **Single-node Oracle/Timescale** — no HA/failover                                                         | High (prod)  | P2       | 5–10 d  | Managed DB or replicas        | Quarter         |
| ISS-14 | **OCPP over plaintext `ws://`** unless a TLS proxy is deployed                                            | High         | P1       | 1 d     | TLS/Caddy                     | 1 week          |
| ISS-15 | **Demo credentials printed on the public landing page** (compounds ISS-01)                                | High         | P0       | —       | ISS-01                        | Immediately     |
| ISS-16 | **Web is plain JavaScript** — no type safety on API contracts                                             | Medium       | P3       | 10–15 d | TS migration plan             | Quarter         |
| ISS-17 | **Accessibility unverified** (no axe run; 29 aria-labels, 0 `<img>`)                                      | Medium       | P2       | 1 d     | axe + Playwright              | 2 weeks         |

### 2.2 Detail on the top issues

**ISS-01 / ISS-15 — Public admin takeover.** Reproduction: `POST /api/v1/auth/login` with `{"email":"admin@volthub.in","password":"Admin@123"}` against the public API returns `200` with an `ADMIN` access token; the same credentials are printed on the landing page. Expected: the public deployment refuses default credentials or does not expose an admin login. Actual: full admin. Fix: rotate the seeded admin password, gate `/admin` behind an allow-list or a second factor, and replace the printed credentials with a "request access" path. This is the only issue that can destroy the project's reputation overnight.

**ISS-02 — Untested UI.** The web app is the most user-visible surface and the only one with no automated verification. Expected: at least a smoke suite (login → discover → reserve → session → wallet → invoice). Actual: `apps/web/package.json` has `dev`/`build`/`start` only. Fix: Playwright against a seeded stack; assert on visible outcomes, not implementation details.

**ISS-03 — AI sidecar is dark in production.** `apps/ai/tests/test_ai.py` exists but no CI job runs pytest, there is no Dockerfile, and compose has no `ai` service. Expected: the advisory service is built and tested like the rest. Actual: `/ai/*` returns `503 AI_UNAVAILABLE` in the public deployment. Fix: add a pytest job, a slim Dockerfile, and an optional compose profile.

**ISS-04 — Token storage.** `apps/web/src/lib/ui.js:8` keeps the 15-minute **access** token in `localStorage`; the 30-day **refresh** token is already an `httpOnly`/`SameSite` cookie (SEC tests 11–14), so the long-lived credential is not XSS-readable. The residual risk is a 15-minute window. Fix: keep the access token in memory only and refresh silently via the existing cookie, or add a CSRF token if it moves to a cookie.

**ISS-14 — OCPP transport.** Basic auth over `ws://` is plaintext. `DEPLOY.md` says TLS is not optional once SEC-003 lands. Fix: terminate TLS at Caddy/Cloudflare and require `wss://` in production config.

---

### 2.3 Implementation status (this pass)

| ID                                             | Status                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ISS-01 / ISS-15                                | **Done** — Argon2id rotation; env-provisioned via `ADMIN_BOOTSTRAP_PASSWORD`; removed from landing, login hint, README, DEPLOY, SECURITY; old password returns 401 |
| ISS-02                                         | **Partial** — 16-check smoke + 12-check authenticated E2E; wired into the `ui` workflow                                                                            |
| ISS-03                                         | **Done** — `apps/ai/Dockerfile`, pinned `requirements.txt`, `ai` compose profile, pytest CI job                                                                    |
| ISS-06                                         | **Done** — nightly `load` workflow runs k6 against a booted stack                                                                                                  |
| ISS-09                                         | **Done** — AI dependencies pinned                                                                                                                                  |
| ISS-10                                         | **Done** — `codecov.yml` project/patch thresholds                                                                                                                  |
| ISS-17                                         | **Partial** — a11y floor (input labels, button names, single h1) gated in smoke                                                                                    |
| ISS-05, ISS-07, ISS-08, ISS-13, ISS-14, ISS-16 | **Open** — need infra/accounts (named tunnel, HA) or multi-week refactors (workspace, TLS proxy, TypeScript)                                                       |

## 3. Enhancements & modifications (by module)

### 3.1 `apps/api`

- **Add a validation layer** (zod/ajv) in front of every mutating route; derive schemas from the OpenAPI spec so contract and runtime cannot drift. _Benefit:_ kills mass-assignment and malformed-input 500s. _Trade-off:_ ~1 week, slight latency.
- **Split `routes.js`/`extended.js`** into domain routers (`reservations`, `sessions`, `invoices`, `wallet`, `admin`) with per-router tests. _Benefit:_ reviewability, smaller blast radius. _Trade-off:_ mechanical churn.
- **Idempotency keys** on POST endpoints (reservations, top-ups). _Benefit:_ safe retries from mobile clients. _Trade-off:_ storage + TTL policy.
- **Structured logging with correlation IDs** (request → outbox → relay). _Benefit:_ debuggable incidents. _Trade-off:_ log volume.
- **Cursor pagination** on list endpoints. _Benefit:_ stable paging at scale. _Trade-off:_ client changes.

### 3.2 `apps/web`

- **TypeScript migration** (incremental, `allowJs`). _Benefit:_ catches contract drift at build time. _Trade-off:_ 2–3 weeks.
- **Data layer**: adopt TanStack Query for caching, retries, and optimistic updates. _Benefit:_ removes hand-rolled fetch state. _Trade-off:_ one dependency.
- **Design system extraction** (`/impeccable extract`): move tokens/components into `packages/ui`. _Benefit:_ reuse across driver app and white-label. _Trade-off:_ upfront refactor.
- **Empty/error/loading states** everywhere (`/impeccable harden`, `/onboard`). _Benefit:_ perceived quality. _Trade-off:_ design time.
- **Mobile-native fixes** (`emilkowalski/mobile-native`): 100vh bug, input zoom, tap highlight, safe areas. _Benefit:_ feels like an app on phones. _Trade-off:_ small CSS debt.

### 3.3 `apps/worker`

- **Dead-letter queue + poison-message quarantine** with a replay tool. _Benefit:_ no silent data loss. _Trade-off:_ new table + runbook.
- **Backoff with jitter** and circuit breaker on Timescale writes. _Benefit:_ resilience during DB blips. _Trade-off:_ tuning.
- **Lag SLO** exported as a metric with alerting. _Benefit:_ operational confidence.

### 3.4 `apps/simulator`

- **Scenario DSL** (YAML) so new failure modes are data, not code. _Benefit:_ extensible chaos testing. _Trade-off:_ parser + docs.
- **Fault injection**: duplicate `MeterValues`, out-of-order frames, clock skew. _Benefit:_ proves idempotency claims.

### 3.5 `packages/*`

- **Single source of truth** for OCPP message schemas + status enums; generate TS types and validators from them. _Benefit:_ removes duplication between API/worker/simulator. _Trade-off:_ codegen step.

### 3.6 `apps/ai`

- **Containerise** (slim Python image, model mounted or downloaded at boot). _Benefit:_ deployable sidecar.
- **Pin dependencies** (`pip-compile` lockfile). _Benefit:_ reproducible builds.
- **Contract test** between API and AI (`/forecast` schema). _Benefit:_ no silent 503s.

### 3.7 `db/`

- **Migration checksum table** (Flyway-style) to detect edited migrations. _Benefit:_ avoids "works on my machine" drift.
- **Documented rollback** per migration. _Benefit:_ safe deploys.

### 3.8 `infra/`

- **Healthchecks + resource limits** on every service. _Benefit:_ predictable behaviour under load.
- **Named tunnel or VM+Caddy** for a stable URL. _Benefit:_ a real deployment.
- **Secrets via Docker secrets / Vault**, not `.env`. _Benefit:_ smaller blast radius.

---

## 4. Advanced features (differentiation-grade)

1. **OCPP 2.0.1 + ISO 15118 Plug & Charge** — certificate-based auth, smart charging profiles. _Business value:_ enterprise/grid deals. _Technique:_ OCPP 2.0.1 state machine, PKI, V2G message set.
2. **OCPI 2.2 roaming** (CPO + EMSP) — CDR exchange and settlement. _Value:_ network effects. _Technique:_ signed CDRs, idempotent handshakes.
3. **Grid-aware smart charging** — site-level load caps, ToU, carbon-intensity signals. _Value:_ lower energy cost, utility partnerships. _Technique:_ optimisation (LP/MPC), OCPP `SetChargingProfile`.
4. **V2G / V2H dispatch** — bidirectional energy accounting. _Value:_ premium differentiator. _Technique:_ separate energy ledger with sign conventions.
5. **Digital twin + what-if simulator** — replay a day of telemetry under a new tariff. _Value:_ sales demos, capacity planning. _Technique:_ deterministic simulation (already have `twin.test.js`).
6. **Predictive maintenance** — anomaly detection on voltage/current curves. _Value:_ uptime SLAs. _Technique:_ isolation forest / autoencoder on Timescale features.
7. **Fraud & tamper detection** — meter-value plausibility, replay detection. _Value:_ margin protection. _Technique:_ rule engine + statistical bounds.
8. **Event sourcing / CQRS read models** — append-only ledger with projections. _Value:_ auditability, time travel. _Technique:_ outbox → projections (already half-built).
9. **Real-time console** — SSE/WebSocket push instead of polling. _Value:_ "live" feel. _Technique:_ server-sent events with backpressure.
10. **Offline-first driver PWA** — queue actions, sync on reconnect. _Value:_ reliability at remote sites. _Technique:_ service worker + IndexedDB.
11. **Multi-tenant + SSO** — tenant isolation, SAML/OIDC. _Value:_ enterprise sales. _Technique:_ row-level security + Keycloak.
12. **White-label theming** — per-tenant tokens. _Value:_ reseller channel. _Technique:_ CSS variables per tenant.
13. **Public API + webhooks** — signed events for partners. _Value:_ ecosystem. _Technique:_ HMAC signatures, retries.
14. **Settlement & reconciliation engine** — match gateway payouts to invoices. _Value:_ finance trust. _Technique:_ double-entry ledger.

---

## 5. New additions (practical integrations)

| Addition                                         | Why                                                                  | Effort |
| ------------------------------------------------ | -------------------------------------------------------------------- | ------ |
| **Razorpay/UPI + Stripe** payment intents        | India-first + global card coverage; wallet top-up becomes real money | 2 wk   |
| **GST-compliant invoicing** (HSN/SAC, e-invoice) | Legal requirement for Indian CPOs                                    | 1–2 wk |
| **OCPI roaming module**                          | B2B network access                                                   | 3–4 wk |
| **Sentry** (web + API + worker)                  | Error visibility in production                                       | 2 d    |
| **OpenTelemetry + Grafana Cloud**                | Traces across gateway → API → outbox → Timescale                     | 1 wk   |
| **Keycloak/Auth0 SSO**                           | Enterprise login                                                     | 1–2 wk |
| **Mapbox/Google Maps** station map               | Discover UX                                                          | 3–5 d  |
| **Twilio / WhatsApp Business** notifications     | Session started/ended, invoice ready                                 | 3 d    |
| **Slack/Teams + PagerDuty alerts**               | Ops on-call                                                          | 2 d    |
| **Tally/Zoho Books sync**                        | Accounting automation                                                | 1 wk   |
| **Backblaze B2/S3 backups**                      | Off-host durability                                                  | 1 d    |
| **Doppler/Vault secrets**                        | Remove secrets from `.env`                                           | 2 d    |
| **Playwright + axe-core**                        | UI + a11y regression                                                 | 1 wk   |

---

## 6. Verification & testing strategy

### 6.1 Current coverage (verified)

- **143 Node cases**: relay 7, API 37, simulator 2, security 17, rate-limit 8, cross-layer 5, OCPP-remote 2, gateway-close 11, control 16, control-AES 6, wallet 14, AI contract 6, twin 12.
- **Race suite** (R1 double-reserve, R4 double-pay) on both engines.
- **SQL invariants** runner, **OpenAPI drift gate** (72 paths), **snapshot check**.
- **E2E** + **control-plane E2E** against a real compose stack in CI.

### 6.2 Target test pyramid

| Layer          | Tool                            | What it must prove                                        | Gate         |
| -------------- | ------------------------------- | --------------------------------------------------------- | ------------ |
| Unit           | node:test / pytest              | pure logic, money math, OCPP codecs                       | every push   |
| Contract       | Schemathesis / OpenAPI          | request/response conformance for all 72 paths             | every push   |
| Property-based | fast-check                      | invariants: energy = ∫power·dt; no double-book; bill-once | nightly      |
| Integration    | compose + real DBs              | outbox relay, cagg refresh, migrations                    | every push   |
| Race/chaos     | existing race suite + Toxiproxy | contention, network partitions, poison messages           | every push   |
| Load           | k6                              | p95 < 250 ms at 200 rps; outbox lag < 2 s                 | nightly      |
| Soak           | k6                              | 24 h, no memory growth, lag stable                        | weekly       |
| Security       | Semgrep + CodeQL + Trivy + ZAP  | no high/critical; secrets never committed                 | every push   |
| A11y           | axe-core + Playwright           | 0 serious violations on 17 pages                          | every push   |
| Visual         | Playwright snapshots            | no unintended layout drift at 375/768/1280                | nightly      |
| UAT            | scripted scenarios              | driver, operator, admin journeys                          | each release |

### 6.3 Definition of done (per change)

1. Unit + contract tests added.
2. `npm test` green; race + invariants green.
3. OpenAPI snapshot regenerated and checked.
4. `eslint --max-warnings 0` and `prettier --check` clean.
5. No new `npm audit` findings.
6. If UI: axe clean at 3 widths; screenshots reviewed.
7. If DB: migration reversible and documented.

---

## 7. Beyond the brief

### 7.1 Business model options

- **SaaS per charge point / month** (₹150–400) — predictable, aligns with CPO growth.
- **Transaction fee** (0.5–1.5%) — aligns with utilisation.
- **Self-hosted licence** + support — for utilities that cannot use SaaS.
- **White-label** — resellers pay per tenant.

### 7.2 Compliance & risk register

- **GDPR/DPDP**: driver PII minimisation, retention policy, DSAR tooling.
- **PCI-DSS**: stay out of scope by never touching card data (wallet rail already helps).
- **OCPI/OCPP conformance**: certify against the official test suite.
- **ISO 27001 readiness**: access control, logging, incident runbooks.
- **Key risks**: default credentials (mitigated by ISS-01), single-node DB (ISS-13), ephemeral URL (ISS-05), AI sidecar unavailability (ISS-03).

### 7.3 90-day plan

| Window     | Focus                                                             | Exit criteria                      |
| ---------- | ----------------------------------------------------------------- | ---------------------------------- |
| Days 1–7   | ISS-01/15 rotate creds; ISS-14 TLS; stable URL (ISS-05)           | Public site safe and permanent     |
| Days 8–21  | ISS-02 web smoke tests; ISS-03 AI in CI + Dockerfile              | UI and AI gated in CI              |
| Days 22–45 | ISS-04 cookie auth; ISS-06 k6 gate; ISS-17 axe                    | Security + perf + a11y gates       |
| Days 46–90 | OCPI roaming spike; smart charging prototype; multi-tenant design | Two differentiated features demoed |

### 7.4 KPIs

- **Reliability**: uptime ≥ 99.9%, outbox lag p95 < 2 s, error rate < 0.1%.
- **Quality**: coverage ≥ 80% on money path, 0 critical vulns, 0 a11y serious.
- **Product**: time-to-first-session < 3 min, reservation success > 99.5%, invoice accuracy 100%.

---

## Appendix A — Skills applied and what changed

| Skill / source                            | Rule applied                                                                                                                            | Concrete change                                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pbakaus/impeccable` (detector, 62 rules) | No eyebrow chip above hero; no kicker above heading; no overused fonts; no numbered section labels                                      | Removed hero eyebrow + "TAKE IT FROM THE TOP" kicker; removed 3 section numbers; swapped Inter→IBM Plex Sans, Space Grotesk→Bricolage Grotesque |
| `Leonxlnx/taste-skill`                    | Clear title on first screen, equal margins, no random blank stretches; app screens: quiet panels, aligned figures, colour spent on data | Verified against the design system; kept the dark ops surface, fixed hierarchy tells                                                            |
| `emilkowalski/skills`                     | `ease-out` for enters (never `ease-in`); semi-transparent shadows not solid borders; transform/opacity only                             | Confirmed `--ease-out: cubic-bezier(.23,1,.32,1)` and tinted shadows already correct; flagged mobile-native fixes as next                       |
| `nutlope/hallmark`                        | No invented facts; real numbers; hero must land on first screen                                                                         | Corrected "66 paths" → 72; removed decorative labels that carried no information                                                                |
| `VoltAgent/awesome-agent-skills`          | Testing/security/perf catalogues                                                                                                        | Mapped Playwright, axe, k6, Semgrep, OpenTelemetry into §6                                                                                      |

## Appendix B — Verification commands

```bash
# correctness
npm test                     # 143 cases + invariants + OpenAPI drift
npm run test:race            # 201/409 proof on both engines
npm run test:e2e             # browser E2E against the stack

# quality
npm run lint                 # eslint --max-warnings 0
npm run format:check         # prettier

# design lint (objective)
npx impeccable detect apps/web/src
npx impeccable detect https://<public-url>

# deployment
curl -sf https://<api>/api/v1/health/deep
```
