# Part III — System Architecture (and North Star)

> Masterplan sections 8 and 48. Each decision is written as Decision → Alternatives → Evaluation → Recommendation → Reason (D/A/E/R/R), so every choice can be defended as a trade-off rather than a preference.

---

## 8. System Architecture

### 8.1 Decision record: overall architecture style

**Decision:** Modular monolith (single NestJS deployable) + one worker process + a strict two-database data layer.

**Alternatives:** (a) microservices; (b) serverless functions; (c) layered monolith without modules; (d) modular monolith with worker.

**Evaluation:** Microservices would split the reservation/billing flow across processes, forcing distributed transactions (sagas, outboxes at the service level) that *obscure* exactly the database-level correctness this course grades; industry guidance is explicit that at low station counts a monolithic CSMS with a relational database is the right call, with microservices earned later by scale [6]. Serverless complicates WebSocket (OCPP needs a persistent socket) and local reproducibility. A feature-less layered monolith permits module boundaries to rot. The modular monolith with a separate worker gives clear boundaries, honest local development, and one process that can hold OCPP sockets while the API stays stateless.

**Recommendation:** (d) — modular monolith + worker.

**Reason:** The project's value is database correctness and clarity, not process choreography. A modular monolith keeps every correctness argument (constraints, locks, transactions) inside one database boundary where they are demonstrable — and it is the architecture industry itself recommends at this scale [5][6].

### 8.2 System context and ASCII architecture diagram

```
                                +---------------------------+
                                |        OPERATORS          |
   +-----------+   HTTPS/JSON   |  +---------+  +--------+  |
   |  DRIVERS  +--------------->|  | DRIVER  |  | OPERATOR| |     Next.js 15 (App Router)
   | (browser) |                |  |   APP   |  |  /ADMIN | |     TypeScript + Tailwind
   +-----------+                |  +---------+  +--------+  |     "Grid Current" design system
                                +------------+--------------+
                                             | REST (OpenAPI) + JWT
                                             v
+---------------------+          +---------------------------+           +----------------------+
|  CHARGER SIMULATOR  |          |        NESTJS API          |          |   WORKER PROCESS     |
|  (Node/TypeScript)  |  OCPP    |  +----------+  +--------+ |           |  - outbox relay      |
|  fleet of N virtual |  1.6J    |  | stations |  | sessions| |  SQL     |  - reservation       |
|  chargers speaking  +--------->|  | auth     |  | billing | +--------->|    expiry sweeper    |
|  JSON over WS       |          |  | reserve  |  | telemetry| | hand-   |  - DA3 stream loader |
|  scripted scenarios |          |  | ocpp-gw  |  | admin    |  written |  - notifications     |
+---------------------+          |  +----+-----+  +---+----+ |  + Zod   +----+-----------+-----+
   WebSocket (OCPP 1.6J)         |       |            |      |               |           |
                                 +-------+------------+------+               |           |
                                         |                        +          |           |
                     bind vars / PL/SQL calls             node-oracledb |           | pg driver
                                         v                             v          v           v
                          +-------------------------+     +---------------------------+  +-----------+
                          |      ORACLE (OLTP)      |     |  optional (stretch):      |  | TIMESCALE |
                          |  system of record:      |     |  Redis cache for hot      |  | (DA3 OLAP)|
                          |  users, stations, EVSE, |     |  station-search results   |  | meter     |
                          |  connectors, resv,      |     +---------------------------+  | ticks,    |
                          |  sessions, readings,    |                                    | state     |
                          |  tariffs, invoices,     |        OUTBOX (Oracle table)       | events,   |
                          |  payments, faults,      +--------------+                     | caggs     |
                          |  audit log              |              |  telemetry events   |           |
                          +-----------+-------------+              +-------------------->|           |
                                      ^                                                 +-----------+
                                      |  PL/SQL: CHARGE_SESSION_PKG, BILLING_PKG,           ^
                                      |  RESERVATION_PKG, MAINTENANCE_PKG, AUDIT_PKG        |
                                      +-----------------------------------------------------+
                                                  db/ migrations (versioned SQL)
```

Reading the diagram: all *transactional* truth lives in Oracle. The OCPP gateway and simulator make the database behave like a real charging network. The worker moves telemetry events (outbox pattern, Section 29) from Oracle into TimescaleDB, where analytics live. The optional Redis box is explicitly a stretch item, not a default.

### 8.3 Component inventory

| Component | Tech | Responsibility |
|---|---|---|
| Web app | Next.js 15, TypeScript, Tailwind v4 | Driver/Operator/Admin UI; RSC for reads, client islands for live data |
| API | NestJS 11, node-oracledb, Zod, OpenAPI | REST endpoints, RBAC guards, validation, transaction scripts calling PL/SQL |
| OCPP gateway | NestJS module + `ws` | OCPP 1.6J JSON-over-WebSocket server; per-charger sessions; event emission |
| Simulator | Node CLI | Fleet of virtual chargers running scripted scenarios (normal, race, fault, no-show) |
| Worker | Node CLI | Outbox relay to TimescaleDB, reservation expiry sweeper, notification dispatch |
| Oracle | gvenzl/oracle-free (23ai) container | OLTP system of record + PL/SQL packages |
| TimescaleDB | timescale/timescaledb container | Hypertables, continuous aggregates, compression, retention (DA3) |
| Migrations | plain numbered SQL + runner script | Single source of truth for both schemas |
| CI | GitHub Actions | lint, typecheck, unit tests, DB constraint tests on service containers |

### 8.4 Sub-decisions

**Caching. D/A/E/R/R.** Decision: no cache in MVP; materialized views + keyset pagination first. Alternatives: Redis everywhere; in-process LRU. Evaluation: at 10k-session scale, Oracle answers interactive queries in low tens of milliseconds when indexed; a cache adds invalidation bugs that would *cost* correctness credibility. Recommendation: optional stretch only, for the station-search endpoint, with a measured before/after. Reason: caching must solve a measured problem, and none exists yet (NFR-03 threshold is met without it).

**Background jobs. Decision:** worker process with a job table (reservation expiry, notification dispatch) + outbox relay. Alternatives: cron in API; external scheduler. Evaluation: in-API timers die with the API process and complicate tests; a job table keeps scheduling state in the transactional store where it belongs. Reason: demonstrates queue semantics using pure database features.

**Event-driven pieces. Decision:** outbox table in Oracle, relayed to TimescaleDB (Section 29). Alternatives: dual-write from API (loses atomicity); full CDC (Oracle XStream/LogMiner — operationally heavy for a student project). Evaluation: the outbox is the classic pattern giving atomic commit + async publish with at-least-once delivery and idempotent loads. Reason: honest event-driven architecture with database-engineering substance, not buzzword streaming.

**Authentication. Decision:** short-lived access JWT (15 min) + rotating refresh token stored hashed in Oracle; Argon2id password hashing. Alternatives: session cookies; OAuth providers. Evaluation: JWT keeps API stateless and demonstrates token lifecycle; refresh rotation covers revocation. Reason: NFR-06; the security section (30) details the full model.

**Observability. Decision:** pino structured JSON logs with request IDs; `/health` endpoint reporting Oracle + Timescale connectivity; simulator prints a compact scenario report. Alternatives: OpenTelemetry tracing stack. Evaluation: full OTel is overkill for three processes; structured logs + health checks cover the demo and CI needs. Reason: NFR-10 at appropriate depth.

**External integrations. Decision:** none in MVP; maps use open tiles (no paid API keys), payments are an internal wallet. Reason: zero-cost reproducibility for evaluators (NFR-08).

---

## 48. North Star Architecture

> Section 48 is placed here (with Section 8) so the target picture is visible before the detailed designs; the section numbering is preserved from the master outline.

**The finished system, described exactly:** A visitor opens a polished dark web app. As a **driver**, they find stations on a map, see live connector availability driven by a charger simulator actually speaking OCPP 1.6J, reserve a CCS2 connector for 6:15 PM, and — when the simulated charger plugs in — watch their live session stream kWh and cost in real time; when it stops, an itemized invoice (ToU energy charge + session fee) appears and the wallet pays it. As an **operator**, they watch a data-dense dashboard: connector state grid, active sessions, revenue and energy trends, a fault feed, and — in DA3 — a live network load curve and utilization heatmap served from TimescaleDB continuous aggregates. As an **admin**, they manage users, operators, stations, and tariff versions, and browse a complete audit trail.

Underneath, one Oracle schema (18 relations, BCNF-analyzed, with packages `RESERVATION_PKG`, `CHARGE_SESSION_PKG`, `BILLING_PKG`, `MAINTENANCE_PKG`, `AUDIT_PKG`) holds every business fact; an outbox relay streams telemetry ticks into TimescaleDB hypertables with 1-minute and 1-hour continuous aggregates, compression, and 90-day retention; Docker Compose brings the whole system up seeded on any laptop; GitHub Actions proves the constraint tests — including the two-concurrent-reservations race — on every push. The README leads with an architecture diagram, a live demo GIF, and honest numbers: 50 simulated chargers, 5-second ticks, p95 240 ms, ingestion lag under 30 s. Nothing is claimed that is not demonstrated.

**The one-sentence version for the resume:** "A two-engine Charging Station Management System — Oracle for ACID-resilient billing and reservations, TimescaleDB for charger telemetry analytics — driven end-to-end by an OCPP 1.6J charger simulator, with a race-condition-proof reservation core and a typography-led Next.js operator dashboard."
