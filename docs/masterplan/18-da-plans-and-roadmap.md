# Part XVIII — DA Plans, Team Responsibilities, Roadmap, Priority Matrix

> Masterplan sections 39–44. Handwritten-report outlines are page-budgeted; viva banks include the *strong* answers, not just questions.

---

## 39. DA1 Plan — ER/EER, relational conversion, normalization (10 marks)

### 39.1 Handwritten report outline (≈ 22–26 sides)

| Sides | Content |
|---|---|
| 1–2 | Cover + problem statement & scope (from Parts I–II, condensed) |
| 3 | Requirements summary table (FR groups 4.1–4.10, abbreviated) |
| 4–5 | Entity list with attributes (Part IV, 9.2 — neat tables) |
| 6–9 | **Full ER diagram** (draw twice: overview on one side, detail of session/billing cluster on another) with cardinalities and participation annotations |
| 10 | EER notation: USER specialization (disjoint/total), PAYMENT specialization (partial), multivalued + derived attributes labeled |
| 11–12 | Weak entities justification (CONNECTOR, METER_READING) with identifying relationships drawn |
| 13 | Relationship table (Part IV, 9.3) |
| 14–17 | **Relational conversion**: all 25 relations in TABLE(...) notation (Part V) with PK/FK/UNIQUE/CHECK callouts |
| 18–19 | FD lists + candidate-key derivations (Part VI, 11) |
| 20–22 | The four normalization walkthroughs (Part VI, 12.1–12.4) — the 2NF, 3NF, and BCNF examples with decomposition diagrams |
| 23 | Controlled-denormalization table + temporal versioning note (12.6–12.7) |
| 24–25 | Business rules BR-01..14 + index plan summary |
| 26 | Conclusion + references |

### 39.2 DA1 presentation outline (8–10 slides)
Problem -> actors -> ER highlights -> EER choices -> conversion decisions -> BCNF story (12.4) -> trade-offs table -> what DA2 will build.

### 39.3 DA1 viva bank (with strong answers)

1. *"Why is CONNECTOR weak?"* — no identity outside its charge point; OCPP addresses it as identity/connector_no [1]; existence-dependent; partial key.
2. *"Why is your specialization total?"* — every user row carries exactly one role; CHECK enforces disjointness; no role-less users exist in the business.
3. *"Show a relation that is 3NF but not BCNF."* — Part VI 12.4's naive CONNECTOR_SLOT; prime-attribute explanation; then show the decomposition.
4. *"Why store energy_kwh if derived?"* — frozen business fact at billing (BR-10); owner package named; deletion/update anomaly impossible because writes funnel through BILLING_PKG.
5. *"Why encode connector_ref as 'cp:no' instead of composite FK?"* — documented trade-off (Part V, 10.3): uniform child-table keys; uniqueness still guaranteed by the parent's composite PK; composite-FK version drafted and shown as alternative.
6. *"What breaks if two tariff bands overlap?"* — nothing schema-wise (non-overlap is non-FD); TARIFF_PKG validates; that is the FD-vs-constraint point from 11.2.

## 40. DA2 Plan — SQL + PL/SQL implementation (10 marks)

### 40.1 Handwritten report outline (≈ 22–26 sides)

| Sides | Content |
|---|---|
| 1–2 | Cover + DA1 recap (1 page — continuity) + implementation environment (Docker oracle-free) |
| 3–6 | **Complete DDL** for core tables (Part VII, 14.1 — write the important ones fully, repeat-pattern ones abbreviated) |
| 7 | Sequences/identity + grants/roles excerpt (13.2–13.4) |
| 8–9 | Views + materialized view + scheduler job (14.2–14.3) |
| 10–14 | **PL/SQL**: RESERVATION_PKG (full), CHARGE_SESSION_PKG (transition + meter tick), BILLING_PKG (resolve_band_price, bill_session, pay_invoice), trigger listings (15.2–15.5) |
| 15 | Exception-handling map (error-code table) |
| 16–17 | Sample-data strategy + volume table + diurnal model (16.1–16.3) |
| 18–20 | **Query portfolio**: pick 10 across tiers (Q1, Q4, Q5, Q9, Q10, Q11, Q13, Q15, Q21, Q25) with purposes |
| 21 | Screenshots/printouts list (app + SQLcl) |
| 22–23 | Demo checklist + test results (race test, invariants) |
| 24–25 | Architecture diagram + what DA3 will add |
| 26 | References |

### 40.2 Demo checklist (DA2)
- [ ] `docker compose up oracle` fresh; migrate + seed in < 3 min
- [ ] Register driver, top-up wallet, register vehicle
- [ ] Operator console: station + tariff v1 visible
- [ ] Simulator session: reserve -> plug-in -> 60 ticks -> stop -> invoice -> pay
- [ ] Race demo: two reservations, one 409
- [ ] SQLcl: show Q10 utilization, Q25 zero-rows, trigger audit rows
- [ ] Show `V$SQL` bind reuse (one command, one line of narration)

### 40.3 DA2 viva bank

1. *"Why FOR UPDATE and not SERIALIZABLE?"* — Section 31.2 answer (locks target the contention point; SERIALIZABLE's retries buy nothing here).
2. *"Walk me through bill_session's atomicity."* — single transaction: lock session row, resolve plan, insert invoice+lines, flip billing_state; either all commit or none; UQ(session_id) makes double-bill impossible.
3. *"What does the guard trigger actually protect?"* — column ownership: status changes only via gateway identity or package paths; demo the rejected ad-hoc UPDATE.
4. *"Why an MV here but not everywhere?"* — one expensive dashboard aggregate justifies it; freshness traded via 15-min refresh; DA3 replaces it with incremental caggs (bridge to DA3).
5. *"BULK COLLECT LIMIT 500 — why the limit?"* — memory-bounded batch processing; PGA control; classic bulk-processing hygiene.
6. *"Your cursor is slow — how do you know?"* — DBMS_APPLICATION_INFO tags + EXPLAIN PLAN habit; show the plan for Q15 vs an OFFSET variant.

## 41. DA3 Plan — TimescaleDB extension (10 marks)

### 41.1 Handwritten report outline (≈ 20–24 sides)

| Sides | Content |
|---|---|
| 1–2 | Cover + continuity recap + why extend at all (workload table from 2.3) |
| 3–5 | **Decision matrix** (23.3) + per-technology rejection notes |
| 6–7 | TimescaleDB concepts: hypertables/chunks, caggs, compression, policies [19] |
| 8–10 | **DA3 DDL**: hypertables + caggs + policies (Part XIV, 26) |
| 11–12 | Pipeline: outbox pattern diagram + relay code excerpt + idempotency (29) |
| 13–15 | **Technology-specific queries** Q-T1..T6 with Oracle equivalents side-by-side |
| 16–18 | **Comparative analysis**: Section 28 table + measured micro-benchmarks + honest limitations |
| 19–20 | Demo screenshots (load curve, heatmap, compression before/after) |
| 21–22 | Justification summary + "what I'd build next" |
| 23–24 | References |

### 41.2 Demo checklist (DA3)
- [ ] Outbox lag dashboard honest (few seconds under burst)
- [ ] Kill worker mid-batch -> restart -> zero duplicate ticks (count query shown)
- [ ] Load curve moves live during simulator burst
- [ ] `time_bucket_gapfill` demo on a dead period
- [ ] Compression: sizes before/after policy
- [ ] Side-by-side: same 24h aggregate, Oracle raw vs cagg, both timings on screen

### 41.3 DA3 viva bank

1. *"Is TimescaleDB 'modern' or just Postgres?"* — extension architecture: chunking, background workers, columnar compression — engine mechanics, not branding; university list names it.
2. *"Why not InfluxDB?"* — 23.3 C2/C5 answer + cite the comparisons [20][21].
3. *"Show me a fact TimescaleDB holds that Oracle doesn't."* — historical per-minute connector state (utilization/fault-time queries, Q-T2/T3): Oracle keeps current status + change timestamps, not tick-resolution history.
4. *"What's your consistency story between the two?"* — at-least-once + sink dedupe; billing never reads Timescale; the split is by *consumer*, not by chance.
5. *"When would you abandon this design?"* — if billing analytics needed cross-engine joins constantly (would consolidate), or if ingest outgrew one node (would add distributed caggs/CDC) — showing exit criteria is maturity.

## 42. Three-Person Team Responsibilities

| Workstream | Member A — **Database Core** | Member B — **Platform/API** | Member C — **Product/Frontend** |
|---|---|---|---|
| Owns | ER/normalization, Oracle DDL, PL/SQL packages, seeds, DA reports' DB chapters | NestJS API, OCPP gateway + simulator, worker/relay, Docker/CI, tests | Next.js app, Grid Current system, charts/maps, README/screenshots, demo video |
| DA1 lead | A (design + proofs) | B (relational conversion review) | C (diagram art + slide design) |
| DA2 lead | A (packages + DDL) | B (API + simulator + demo flow) | C (driver/operator UI) |
| DA3 lead | A (caggs + policies + comparisons) | B (relay + telemetry endpoints) | C (telemetry screens) |
| Shared | All three: demo rehearsal, viva prep for each other's sections, every PR reviewed by one non-author | | |

Pairing rules: no one owns a demo beat they cannot explain end-to-end; A and B pair on the race tests (the hardest correctness surface); C ships the README hero early and iterates.

## 43. Week-by-Week Roadmap (14 weeks, quality-first — deadlines deliberately not the driver)

| Week | Deliverables | Owner | DoD (definition of done) |
|---|---|---|---|
| 1 | Repo scaffold; requirements freeze; ER v1 | all / A | scaffold.sh runs; ER reviewed by all 3 |
| 2 | Normalization proofs; relational schema v1; DA1 diagrams | A (+C art) | Part V+VI complete; DA1 report drafted |
| 3 | DA1 report final + slides + rehearsal | all | handwritten report done 1 week early; mock viva passed |
| 4 | Oracle DDL + migrations; seeds v1 (200 sessions) | A | `compose up oracle` seeded; invariants green |
| 5 | Packages: RESERVATION, TARIFF, AUDIT | A | race test R1 green in CI |
| 6 | Packages: CHARGE_SESSION, BILLING; triggers | A (+B pairing) | full session bills; R4 green |
| 7 | API skeleton + auth + stations; MV + scheduler | B | OpenAPI live; Q26 in use |
| 8 | OCPP gateway + simulator (normal scenario) | B | session flows from protocol; 404-fault free |
| 9 | Web: design system + driver flow (D1–D4) | C | discovery + reservation usable end-to-end |
| 10 | Web: live session D5 + wallet D7 + operator O1 | C (+B) | demo beats 5–6 run without notes |
| 11 | DA3: hypertables + relay + telemetry endpoints | B (+A) | burst demo: curve moves; lag < 30s |
| 12 | DA3: caggs + policies + comparisons; O4 screens | A (+C) | Q-T1..T6 live; compression shown |
| 13 | Hardening: perf.md, E2E, README hero, backup drill | all | all checklists ticked; restore tested |
| 14 | Demo polish: GIFs, runbook, mock demos x2 | all | 12-min run under 12:30 twice in a row |

Buffer philosophy: weeks 13–14 are *entirely* polish/buffer; every prior week's DoD is binary.

## 44. Priority Matrix

| Feature | Academic value | Portfolio value | Complexity | Priority |
|---|---|---|---|---|
| ER/BCNF + reports | 10/10 | 7/10 | M | **P0** |
| Oracle schema + packages (reservation/session/billing) | 10/10 | 9/10 | M–H | **P0** |
| OCPP simulator + session lifecycle | 8/10 | 10/10 | M | **P0** |
| Race-condition defense + tests | 9/10 | 10/10 | M | **P0** |
| Wallet/ledger billing | 8/10 | 7/10 | M | **P0** |
| Driver app (discover/reserve/session/history) | 6/10 | 9/10 | M | **P0** |
| Operator dashboard + analytics (MV) | 7/10 | 8/10 | M | **P0** |
| DA3 Timescale pipeline + caggs | 10/10 | 9/10 | M | **P0** |
| Comparative analysis + benchmarks | 10/10 | 8/10 | L | **P0** |
| Telemetry screens (load curve/heatmap) | 7/10 | 9/10 | M | **P1** |
| CI + Docker Compose + migrations | 5/10 | 10/10 | M | **P1** |
| Keyset pagination + index plan | 7/10 | 8/10 | L | **P1** |
| Audit trail + guard triggers | 8/10 | 7/10 | L | **P1** |
| Tariff versioning UI | 6/10 | 7/10 | M | **P1** |
| Reviews/notifications | 5/10 | 5/10 | L | **P2** |
| Grafana sidecar | 3/10 | 7/10 | L | **P2** |
| SSE live push | 2/10 | 5/10 | M | **P2** |
| Redis cache | 2/10 | 4/10 | L | **P2 (measured only)** |
| GraphQL read API | 3/10 | 4/10 | M | **P3** |
| OCPI roaming / ML / mobile / K8s | - | - | H | **P3 (omit)** |
