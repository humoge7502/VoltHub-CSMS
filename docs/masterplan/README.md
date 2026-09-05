# VoltHub CSMS — Engineering Masterplan (Docs)

**Project:** Electric Vehicle Charging Station Management System
**Course:** BACSE202 — Database Systems (Digital Assignments DA1 / DA2 / DA3)
**Architecture codename:** VoltHub CSMS

This `docs/` folder is the complete engineering masterplan, organized as repo-ready Markdown. The polished, typeset version of the same content is `VoltHub-CSMS-Engineering-Masterplan.pdf` in the repository root.

## Reading map

| File | Contents | Masterplan sections |
|---|---|---|
| `01-research-and-domain.md` | Executive summary, research findings, real-world domain analysis | 1–3 |
| `02-requirements-scope-roles.md` | Functional requirements, non-functional requirements, scope, user roles | 4–7 |
| `03-system-architecture.md` | Architecture decision records, component map, North Star architecture | 8, 48 |
| `04-da1-er-design.md` | Full ER/EER model for DA1 (entities, constraints, business rules) | 9 |
| `05-relational-schema.md` | ER → relational conversion, complete schema with constraints | 10 |
| `06-normalization-bcnf.md` | Functional dependencies, 1NF→BCNF proofs, decompositions | 11–12 |
| `07-oracle-implementation.md` | Oracle DDL, views, materialized views, indexes (DA2 core) | 13–14 |
| `08-plsql-design.md` | Packages, procedures, triggers, audit, exception handling | 15 |
| `09-sample-data-and-queries.md` | Dataset generation strategy + 25-query SQL portfolio | 16–17 |
| `10-backend-and-api.md` | NestJS architecture, data access, API catalog, OpenAPI | 18–19 |
| `11-frontend-design-system.md` | Next.js architecture + "Grid Current" design system + anti-vibe-coded rules | 20–21 |
| `12-screen-by-screen-ux.md` | Driver / Operator / Admin screen specs and cut-list | 22 |
| `13-da3-database-decision.md` | 12-criteria decision matrix, why TimescaleDB wins | 23–24 |
| `14-da3-architecture.md` | DA3 topology, hypertable data model, pipeline, DA3 queries | 25–29 |
| `15-security-concurrency-performance.md` | Security, race-condition catalog, performance plan | 30–32 |
| `16-testing-devops-deployment.md` | Testing strategy, Docker/CI, deployment, demo runbook | 33–35 |
| `17-repo-portfolio-demo.md` | GitHub architecture, README strategy, recruiter narrative, demo script | 36–38 |
| `18-da-plans-and-roadmap.md` | DA1/DA2/DA3 report plans, team split, week-by-week roadmap, priority matrix | 39–44 |
| `19-critique-stack-checklist.md` | What NOT to build, weaknesses, final stack, implementation order, final checklist | 45–50 |
| `references.md` | Numbered citations used across all files | — |

## Companion artifacts

| Path | Purpose |
|---|---|
| `../diagrams/*.mmd` | Mermaid sources: ER model, architecture, session lifecycle, reservation sequence, DA3 pipeline, DA3 schema |
| `../scripts/scaffold.sh` | Creates the entire VoltHub monorepo tree with stub files |
| `../career/resume-bullets.md` | Resume bullets + 30-second pitch + interview soundbites |

## Continuity contract (DA1 → DA2 → DA3)

One ER model (DA1) converts to one Oracle schema (DA2), which remains the system of record in DA3. TimescaleDB is added as a purpose-built telemetry and analytics store — never a duplicate of Oracle tables. Every DA builds on the same codebase, same schema, same demo story.
