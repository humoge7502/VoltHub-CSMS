# Part XIX — Critique, Final Stack, Implementation Order, Final Checklist

> Masterplan sections 45–50. The plan ends the way it started: adversarially.

---

## 45. What I Would NOT Build (and the reason each rejection survives scrutiny)

| Rejected                               | Why it would hurt the project                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Microservices**                      | Splits the reservation/billing correctness story across processes; the graded substance is database-level integrity [6]. A modular monolith demonstrates the same boundaries with testable invariants. |
| **Kafka/RabbitMQ**                     | The outbox + worker delivers the same event-driven lesson (atomic commit, at-least-once, idempotent sink) with zero new ops surface. A broker would be technology collecting.                          |
| **Kubernetes/Terraform**               | One VM runs the demo. K8s YAML would consume a week and answer no interview question the repo can't answer better.                                                                                     |
| **Real payment gateway**               | PCI scope, fake money anyway; the wallet ledger demonstrates double-entry correctness — the part that matters — without pretending to be a PSP.                                                        |
| **ML demand prediction**               | 10k sessions cannot train anything defensible; it would invite the question "why?" with no good answer. DA3 analytics already deliver the data-science-adjacent payoff.                                |
| **GraphQL layer**                      | Resolvers would wrap the same views; adds N+1 risk into Oracle and a second contract to defend. REST + OpenAPI is complete.                                                                            |
| **Mobile app**                         | Halves frontend quality for the same demo value; responsive driver flow covers the phone story.                                                                                                        |
| **ISO 15118 implementation**           | Certificate PKI for Plug&Charge is a protocol-spec project, not a database one [24]; discussed, mapped to the Authorize step, not built.                                                               |
| **Multi-region / HA setup**            | Nothing we run needs it; claiming it would violate the honesty rule.                                                                                                                                   |
| **More "modern DBs" than TimescaleDB** | The DA3 brief wants _one_ technology used well. Two would dilute the comparative analysis and halve the depth.                                                                                         |

## 46. Likely Weaknesses (and how each is addressed)

| Weakness an interviewer will find            | Mitigation                                                                                                                                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Your chargers are simulated."               | Yes — and stated everywhere. Precedent: CSMS testing uses emulators/OCPP reference servers [10]. The simulator speaks the real protocol with scripted edge cases; correctness claims attach to the _database_, which does not care where bytes come from. |
| "Data volume is small."                      | Honest numbers + a measured 1.7M-tick burst + workload-shape argument (24). We never claim scale we didn't measure.                                                                                                                                       |
| "TimescaleDB is overkill at this scale."     | The argument is shape (append-heavy, immutable, time-windowed), not size [7][22]; plus Oracle Free lacks the partitioning/cagg machinery to even try (28).                                                                                                |
| "Business logic in PL/SQL is dated."         | Answer with nuance: invariants that money depends on sit next to the data with grant-enforced ownership (13.2); app remains free to orchestrate. It's a _choice_ with reasons, not nostalgia.                                                             |
| "Two engines = operational risk."            | Acknowledged and tested: pipeline degrades gracefully, billing unaffected; kill-and-replay demo (29). Exit criteria stated (41.3.5).                                                                                                                      |
| "Frontend is charts-and-tables boilerplate?" | The anti-vibe-coded rulebook (21.4) + the connector grid and tariff timeline as bespoke components; typography-led identity.                                                                                                                              |
| "Only one of you really understands the DB?" | Pairing rules (42): every demo beat owner explains end-to-end; viva prep is cross-team.                                                                                                                                                                   |
| "Where's your testing?"                      | DB invariants, race tests, API integration, E2E, k6 — with the two signature tests demoed live (33.2).                                                                                                                                                    |

## 47. Final Recommended Technology Stack (locked)

| Layer               | Choice                                                         | Why it belongs (one line)                                                    |
| ------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| OLTP database       | **Oracle 23ai Free (Docker)**                                  | the course's engine; packages/grants/MVs carry correctness                   |
| OLAP database (DA3) | **TimescaleDB (PG16)**                                         | hypertables/caggs/compression are the right mechanics for telemetry [19][28] |
| Backend             | **NestJS 11 + TypeScript + node-oracledb + Zod**               | thin, typed, one language across api/gateway/worker/simulator                |
| Realtime protocol   | **OCPP 1.6J over WebSocket (`ws`)**                            | the industry standard that makes data _real_ [1][4]                          |
| Frontend            | **Next.js 15 App Router + Tailwind v4 + TanStack Query**       | RSC reads + client islands for live data; team fluency                       |
| Charts / Map        | **Recharts / MapLibre GL + CARTO style**                       | zero-key, dark-native, performant                                            |
| Design system       | **Grid Current (Space Grotesk + Inter + IBM Plex Mono)**       | authored identity; anti-generic rulebook enforced                            |
| Auth                | **Argon2id + JWT access/refresh rotation**                     | OWASP baseline, stateless API                                                |
| Testing             | **Vitest + Supertest + Playwright + k6 + SQL invariant suite** | pyramid weighted toward DB correctness                                       |
| CI/CD               | **GitHub Actions + GHCR + Docker Compose**                     | green-badge credibility; laptop-reproducible deploys                         |
| Docs                | **this masterplan + ADRs + OpenAPI + perf.md**                 | the recruiter reads these first                                              |

## 48. North Star Architecture

Restated here for completeness (full text in Part III): the finished VoltHub is a two-engine CSMS — Oracle as transactional system of record, TimescaleDB as telemetry analytics — driven end-to-end by an OCPP 1.6J charger simulator, exposed through a NestJS API and a typography-led Next.js product, shipped with CI, migrations, invariant tests, and honest measured numbers. One diagram, one paragraph, no asterisks.

## 49. Exact Implementation Order (0 → deployed portfolio)

| Step | Build                                                          | Verify-gate                                       |
| ---- | -------------------------------------------------------------- | ------------------------------------------------- |
| 0    | Scaffold repo, CI skeleton, compose with oracle+timescale only | `compose up` healthy; CI badge on empty repo      |
| 1    | DA1 artifacts (ER, proofs, report) — _before any app code_     | report done; team can whiteboard the schema       |
| 2    | Oracle DDL migrations + grant script                           | invariant queries run green on empty schema       |
| 3    | Seeds v1 + lookup tables                                       | seeded 200-session DB; Q25 zero rows              |
| 4    | RESERVATION_PKG + R1 race test                                 | test green — **gate: do not proceed until it is** |
| 5    | TARIFF_PKG + tariff seeds                                      | band-overlap rejection test green                 |
| 6    | CHARGE_SESSION_PKG (transition, ticks) + guard trigger         | illegal-transition test green                     |
| 7    | BILLING_PKG + wallet (bill, pay, ledger)                       | Q19 reconciliation green; R4 race test green      |
| 8    | API: auth + users + wallet + OpenAPI                           | supertest suite green                             |
| 9    | API: stations/reservations/sessions/billing endpoints          | happy path via HTTP only                          |
| 10   | OCPP gateway + simulator normal scenario                       | session born from protocol; meter ticks flow      |
| 11   | Outbox events + relay worker + Timescale hypertables           | burst demo; lag < 30s; dedupe verified            |
| 12   | Caggs + policies + telemetry endpoints                         | Q-T1/T2/T5 live                                   |
| 13   | Web design system primitives + discovery (D1–D3)               | UI passes a11y contrast checks                    |
| 14   | Web: reservations, live session, wallet, history (D4–D7)       | driver flow E2E green                             |
| 15   | Operator dashboards O1–O3 (+MV)                                | demo beats 5–7 run clean                          |
| 16   | DA3 screens O4 + heatmap                                       | curve + compression visible                       |
| 17   | Admin screens A1–A5                                            | tariff versioning UI complete                     |
| 18   | Hardening: perf.md, k6, backup drill, a11y pass                | all checklists ticked                             |
| 19   | README hero + GIFs + screenshots; deploy demo env              | public URL + "restore tested" note                |
| 20   | DA2/DA3 reports + demo rehearsals x2                           | 12-minute run under 12:30, twice                  |

The order encodes the philosophy: **database first, protocol second, UI third, polish last** — and DA gates (4, 7) that refuse to let weak correctness be papered over by screens.

## 50. Final Checklist

**Academic compliance (DA1)**

- [x] ER/EER with cardinality + participation annotated (`diagrams/er-model.mmd`)
- [x] weak entities justified (`docs/masterplan/04`, `05`)
- [ ] specializations labeled
- [x] relational conversion complete (29 relations)
- [x] FDs + candidate keys derived (`docs/masterplan/04`)
- [x] 2NF/3NF/BCNF worked examples (`docs/masterplan/06-normalization-bcnf.md`)
- [x] lossless/dependency-preservation discussed (`docs/masterplan/06-normalization-bcnf.md`)
- [ ] handwritten report per outline
- [ ] presentation rehearsed.

**Academic compliance (DA2)**

- [x] DDL with constraints + indexes (`db/oracle/V001..V006`)
- [x] views + MV + scheduler (`db/oracle/V002`)
- [x] packages with cursors/functions/exceptions (`db/oracle/V003`)
- [x] triggers justified (`V004`/`V005` + docs/masterplan/07-08)
- [x] sample data coherent + sized (`db/oracle/seed/seed.sql` + demo seed)
- [ ] live demo checklist passes (needs Docker runtime — CI `e2e` job)
- [ ] handwritten report per outline.

**Academic compliance (DA3)**

- [x] decision matrix + rejections (`docs/masterplan/13-da3-database-decision.md`)
- [x] hypertable DDL + policies (`db/timescale/T001`, `T002` — caggs/compression/retention)
- [x] dataset imported/generated (simulator burst + `scripts/seed/` + `bench/` generator)
- [ ] core ops demonstrated (runtime — CI `db-tests` applies DDL; refresh verifications P2V-01..03)
- [x] technology-specific queries with Oracle equivalents (`db/timescale/queries.sql` + `db/oracle/queries.sql`, masterplan §14)
- [ ] comparative analysis with measurements (perf exp. 4 cagg-vs-raw needs Timescale runtime)
- [x] justification one-paragraph ready (`docs/masterplan/13`)
- [ ] handwritten report per outline.

**Engineering quality**

- [x] CI green on main (3-job ladder — quality / db-tests / e2e)
- [x] migrations versioned (`db/oracle/V00*`, `db/timescale/T0*`)
- [x] race tests in suite (R1 double-reserve, R4 double-pay — both engines in CI)
- [x] invariant queries in suite (11 checks, 0 rows — local + Oracle runner)
- [x] `/health` shows both engines (oracle/timescale state when wired; `/health/deep` probes)
- [x] structured logs with request IDs (pino + `x-request-id` echo)
- [x] OpenAPI current (drift gate, zero notes)
- [x] seeds deterministic (demo seed + `db/oracle/seed/seed.sql`)
- [ ] backup restore tested (host-runtime item — `expdp`/pg_dump story in DEPLOY.md)
- [x] perf numbers reproducible (`bench/` scripts + `docs/perf.md` methodology + `results-local.json`).

**Portfolio**

- [x] README hero + GIF (`docs/screenshots/` strip + `demo-live.gif`)
- [x] architecture diagram (README mermaid + `ARCHITECTURE.md`)
- [x] honest-limits section
- [x] screenshots (4) (dashboard · live session · telemetry · invoice @2x)
- [ ] demo video (GIF captured; full-length video is a recording task)
- [x] DA-tagged releases (`git tag v1.1.0` + GitHub Release from CHANGELOG)
- [x] resume bullets drafted (`docs/resume-bullets.md`)
- [ ] 30-second pitch rehearsed
- [ ] eight wow-moments each have a "show me" path.

**Honesty**

- [x] no unmeasured scale claims (perf.md is methodology + measured tables only)
- [x] simulated components labeled (README honest limits + everywhere)
- [x] payment scope stated (prepaid wallet, no card data)
- [x] "what I'd build next" written (masterplan §02 stretch list + §18 roadmap + ADRs).
