# Part XVII — GitHub Architecture, Portfolio Strategy, and Demo Storyline

> Masterplan sections 36–38. The repository *is* the portfolio artifact — most recruiters read the README and repo tree before anything else, so both are engineered deliberately.

---

## 36. GitHub Architecture

### 36.1 Monorepo layout (created by `scripts/scaffold.sh`)

```
volthub-csms/
├── README.md                     # the front door (36.2)
├── docs/                         # this masterplan + ADRs + perf.md + demo-script.md
├── diagrams/                     # mermaid sources + rendered SVGs
├── db/
│   ├── oracle/                   # V001__core_schema.sql ... V00N, packages/, seed/
│   └── timescale/                # T001__hypertables.sql ..., policies
├── apps/
│   ├── api/                      # NestJS (modules per Part X)
│   ├── web/                      # Next.js + Grid Current design system
│   ├── worker/                   # outbox relay, sweepers
│   └── simulator/                # OCPP charger fleet + scenarios
├── packages/
│   ├── shared/                   # zod schemas + TS types
│   └── ocpp-messages/            # typed OCPP 1.6J models
├── infra/
│   ├── docker-compose.yml  docker-compose.demo.yml
│   └── grafana/                  # optional dashboards
├── test/
│   ├── sql/ races/ api/ e2e/ load/
├── scripts/                      # scaffold.sh, seed runners, demo helpers
├── .github/workflows/ci.yml
└── LICENSE  CONTRIBUTING.md  SECURITY.md
```

### 36.2 README skeleton (order = recruiter attention span)

1. **Hero:** project name + one-liner ("Two-engine CSMS: Oracle for ACID billing & reservations, TimescaleDB for charger telemetry analytics — driven end-to-end by an OCPP 1.6J charger simulator") + badges (CI, license, tech chips).
2. **30-second demo GIF** (race-condition rejection + live session + telemetry dashboard).
3. **Why two databases** — 4 lines + the architecture diagram.
4. **Screenshot grid** — 4 images max: operator connector grid, live session, load curve, invoice.
5. **Database engineering highlights** — BCNF notes link, race-condition mechanism, outbox pipeline; each with a one-line "show me" pointer to code/tests.
6. **Honest scale & limits** — tested numbers (NFR-11), what is simulated, what is out of scope. *This section wins trust; do not skip it.*
7. **Quickstart** — `docker compose up` + seeded credentials.
8. **Docs map** — link into `docs/` (this masterplan).
9. **License + credits.**

### 36.3 Repo hygiene signals

Conventional commits (`feat(db): ...`); PRs even for solo work (a clean PR history is a story); CODEOWNERS trivially set; no `console.log` litter; `.env.example` complete; issues used for the roadmap; releases tagged per DA milestone (`da1-er-design`, `da2-oracle`, `da3-timescale`) — the tag history *is* the course-continuity proof.

---

## 37. Portfolio / Recruiter Strategy

### 37.1 The eight wow-moments, mapped to interview questions

| # | Wow moment | Interview question it answers |
|---|---|---|
| W1 | BCNF proofs with a *consciously accepted* dependency-preservation trade-off (Part VI, 12.4) | "Explain normalization beyond 3NF — why would you ever stop at BCNF?" |
| W2 | Double-reservation race killed with locks + test (31.1) | "Tell me about a concurrency bug you prevented by design." |
| W3 | OCPP 1.6J simulator + state machine in PL/SQL | "How would you integrate with hardware you don't control?" |
| W4 | Business invariants in packages + grants (13.2, 15) | "Where should business logic live — app or DB?" (a *nuanced* answer) |
| W5 | OLTP/OLAP split with cited industry precedent (2.3, 24) | "When would you add a second database?" |
| W6 | Continuous aggregates + compression/retention policies (26) | "How do you serve fast aggregates on append-heavy data?" |
| W7 | Outbox pipeline with exactly-once-effect demo (29) | "How do you keep two datastores consistent?" |
| W8 | Design system with an anti-vibe-coded rulebook (21.4) | "Walk me through a UI decision you made against the grain." |

### 37.2 Narrative rules (integrity = differentiation)

- Never claim production readiness; claim *production habits* (CI, migrations, tests, backups) — verifiable in-repo.
- Every number in the README is reproducible by the reader on their laptop.
- "What I would build next" section shows judgment (read-partitioning, CDC, multi-station pricing) — hiring loops reward a roadmap over a museum.
- Resume bullets + pitch: see `career/resume-bullets.md` (companion artifact).

---

## 38. Demo Strategy — the 12-minute storyline

> Principle: tell an *engineering story* — every screen shown exists because a constraint forced it. Slides only at the bookends; the middle is live.

| # | Time | Beat | What happens | Line to say |
|---|---|---|---|---|
| 1 | 0:00–1:00 | The problem | Landing page + operator dashboard idle | "Charging networks sell electricity and *certainty*. Certainty is a database property." |
| 2 | 1:00–2:00 | Architecture | One diagram slide (Part III) | "One OLTP engine of record, one telemetry engine, one protocol between hardware and truth." |
| 3 | 2:00–3:30 | ER → schema | 2 diagram slides: ER + the CONNECTOR BCNF decomposition | "The naive design violates BCNF here — decompose, lose one FD, accept it consciously." |
| 4 | 3:30–5:00 | The race | Two terminals: fire two reservations; one 201, one 409; then `test:race` green | "The loser wasn't rejected by the app. The *database* locked the row." |
| 5 | 5:00–7:00 | Real session | Driver reserves; simulator plugs in; live session streams kWh/kW/cost; stop → invoice lines appear | "Every number here was written by a protocol message, priced by a package." |
| 6 | 7:00–8:30 | PL/SQL deep-dive | Show `create_reservation` and `pay_invoice` in editor; run wallet double-pay test | "FOR UPDATE here; ledger balance_after here; one payment, provably." |
| 7 | 8:30–10:00 | DA3: telemetry | Switch to load curve + heatmap; generate a burst of simulated chargers; curve moves; show cagg definition + compression sizes | "600k ticks, 1-minute aggregates, 10x compressed — this is why TimescaleDB." |
| 8 | 10:00–11:00 | Engineering hygiene | CI green (constraint invariants), OpenAPI docs, audit log diff | "Tests, migrations, audit — habits, not features." |
| 9 | 11:00–12:00 | Conclusion | Honest-limits slide + roadmap | "Small data, correct by construction. Here's what I'd build next." |

**Rehearsal checklist:** every beat <= 90s; the race demo rehearsed 10x (it is the moment); fallback GIFs exist for beats 5 and 7; a printed `docs/demo-script.md` with the exact SQL to paste if the app misbehaves; timekeeper role assigned to one teammate.

### 38.1 Rapid-fire Q&A drill (top 5, full banks in Part XVIII)

1. "Why not just Oracle partitions?" — EE-only option; Free tier lacks it; Timescale chunks + incremental caggs + compression; measured numbers in Section 28.
2. "Why is the DB the state machine, not the app?" — single authority, trigger-guarded, grant-enforced; app is replaceable, invariants are not.
3. "What if two payment workers race?" — invoice-row lock + status flip in one transaction; second gets 409 (R4).
4. "Why OCPP 1.6 and not 2.0.1?" — most deployed, simplest to implement correctly, TransactionEvent's unified lifecycle noted as the 2.0.1 upgrade path [2][4].
5. "Is this production-ready?" — "No. It is production-*shaped*: the habits are real, the scale is not, and the README says exactly which is which."
