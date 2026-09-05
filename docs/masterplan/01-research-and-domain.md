# Part I — Executive Summary, Research Findings, and Domain Analysis

> Masterplan sections 1–3. This part establishes what VoltHub is, why every major decision in it is defensible, and how the real EV charging industry actually works. Facts are labeled **[Fact]** with citations; judgment calls are labeled **[Recommendation]** or **[Assumption]**.

---

## 1. Executive Summary

**VoltHub CSMS** is a Charging Station Management System for a mid-size electric-vehicle charging network operator (a CPO — Charge Point Operator). It manages stations, charging points, connectors, drivers, reservations, charging sessions, metering, tariffs, billing, payments, faults, maintenance, and analytics. It is being built by a three-person team as the assigned mini-project for BACSE202 (Database Systems), and it deliberately satisfies the university's DA1 → DA2 → DA3 progression with a single continuous codebase instead of three disconnected submissions.

The core architectural thesis is a **two-engine database design**: Oracle remains the system of record for everything transactional (users, stations, connectors, reservations, sessions, tariffs, payments, invoices, maintenance — the OLTP workload), while **TimescaleDB** is introduced in DA3 as the purpose-built store for high-frequency charger telemetry and time-series analytics (the OLAP workload). This is not "Oracle plus another database for the resume." It is the same split real charging networks make: industry references describe EV charging platforms as mixing 15–30 second telemetry writes with strictly consistent billing data [8], and Timescale's own CSMS architecture guide identifies meter values, transaction records, status events, and configuration as four distinct data workloads with different storage requirements [7]. DA1 designs the relational core, DA2 implements it in Oracle SQL/PL-SQL, and DA3 streams the telemetry slice into TimescaleDB with hypertables, continuous aggregates, compression, and retention policies — a genuine OLTP-versus-OLAP separation that can be defended line-by-line in a viva.

The application layer is a **modular monolith** written in **TypeScript**: a NestJS REST API plus an OCPP 1.6J WebSocket gateway with a built-in charger simulator, backed by Oracle (via `node-oracledb` with hand-written SQL and calls to PL/SQL packages). The frontend is a **Next.js (App Router)** application with a custom design system called **Grid Current** — typography-led, dark, data-dense, inspired by the engineering discipline of acmvit.in (Astro, Tailwind, oversized display type, cream-on-near-black palette) but an original identity: Space Grotesk display type, IBM Plex Mono for tabular numerals, a carbon/cream/electric-lime palette, and hairline-bordered data surfaces instead of glassmorphism and gradient decoration.

**The eight recruiter-facing "wow moments" this plan is engineered to produce:**

1. **A BCNF-honest relational model** with worked functional-dependency proofs and two intentional, justified denormalizations.
2. **Race-condition-proof reservation logic** — `SELECT ... FOR UPDATE` plus a uniqueness constraint that makes double-booking physically impossible, demonstrated live with two parallel requests.
3. **A realistic charging-session lifecycle** driven by a simulated OCPP 1.6J charger speaking JSON over WebSocket (BootNotification, StatusNotification, Authorize, StartTransaction, MeterValues, StopTransaction) [4][23].
4. **Business logic in the right place**: billing, tariff resolution, and connector-state invariants implemented as Oracle packages and triggers, not scattered across app code.
5. **An OLTP/OLAP split with evidence**: Oracle for transactions, TimescaleDB hypertables + continuous aggregates for utilization and load analytics, with compression and retention policies [7][19].
6. **A query portfolio that reads like an analyst wrote it**: window functions, CTEs, gaps-and-islands utilization, revenue trends, keyset pagination.
7. **A frontend that does not look AI-generated**: an original design system, data-dense operator dashboards, live telemetry charts, and a map-based station discovery experience.
8. **Production hygiene**: Docker Compose, CI on GitHub Actions, versioned SQL migrations, seeded deterministic data, structured logs, health checks, and a real test suite that includes concurrency tests.

**What this project is not:** it is not a microservices platform, not a real hardware deployment, not a payments processor (no card data is ever stored), and not a machine-learning product. Every exclusion is documented in Section 45 with the reasoning, because knowing what not to build is part of the engineering maturity this project is meant to demonstrate.

---

## 2. Research Findings

This section is the evidence base for every later decision. Each finding is marked **[Fact]** (verifiable, cited), **[Recommendation]** (our judgment based on facts), or **[Assumption]** (stated belief we could not fully verify).

### 2.1 OCPP — the protocol that makes this project real

**[Fact]** The Open Charge Point Protocol (OCPP) is the open, vendor-neutral protocol connecting charging stations (charge points) to central management systems. It is developed by the Open Charge Alliance and is the de-facto global standard [1].

**[Fact]** OCPP 1.6J (JSON over WebSocket) remains the most widely deployed version in the field [4]. OCPP 2.0.1 replaced the classic `StartTransaction`/`StopTransaction`/`MeterValues` flow with a unified `TransactionEvent` message, added a structured Device Model, and introduced formal security profiles [2][3]. OCPP 2.1 has since been published as IEC 63584, extending 2.0.1 compatibly [1].

**[Fact]** A charging session in OCPP 1.6 follows a recognizable message choreography: the charger sends `BootNotification` when it comes online, `StatusNotification` as its connector state changes, `Authorize` when a driver presents an idTag, `StartTransaction` when energy flow begins, periodic `MeterValues` while charging, and `StopTransaction` with a final meter value when it ends [1][23]. Remote operations (`RemoteStartTransaction`, `RemoteStopTransaction`, `Reset`, `ChangeAvailability`) flow from the central system to the charger.

**[Recommendation]** We implement an **OCPP 1.6J subset** in both directions: our backend acts as the central system, and a Node.js **charger simulator** acts as the charge point. This is the single highest-leverage research-based decision in the project. It converts every database feature from an abstract CRUD row into the observable outcome of a protocol conversation — connector states change because `StatusNotification` arrived, sessions and meter readings exist because the charger reported them, and reservations end in a real state machine. OCPP 1.6J is chosen over 2.0.1 because it is simpler, dramatically better documented for implementers, most deployed in the real world, and fully sufficient to demonstrate the database concepts DA1–DA3 grade on. The simulator replaces physical chargers; we make no claims about real hardware behavior beyond what the protocol specifies.

**[Assumption]** The professor will treat an OCPP simulator as a legitimate "realistic workload generator." SteVe — a mature open-source OCPP server maintained since 2013 [10] — establishes strong precedent that this is exactly how CSMS software is built and tested without hardware.

### 2.2 CSMS architecture in industry

**[Fact]** A Charging Station Management System (CSMS) is the backend platform that handles OCPP communication, user authentication, billing, and network management for a charging network [5][7].

**[Fact]** Industry engineering guidance states that at low scale, a monolithic CSMS with a relational database is the appropriate architecture, with microservices reserved for networks scaling to very large station counts [6]. AWS's reference architecture similarly decomposes the domain into command/control of chargers, session processing, and billing rather than into microservices [5].

**[Recommendation]** **Modular monolith**: one NestJS application with strict module boundaries (auth, stations, sessions, billing, telemetry, admin), one Oracle schema, one TimescaleDB store, plus a small worker process for the telemetry pipeline. Microservices would add distributed-transaction complexity that would *weaken* the database story this course grades. Section 8 contains the full decision record.

### 2.3 The data workload evidence — why two engines

**[Fact]** Timescale's CSMS guide states that EV charging databases must handle four distinct OCPP data types — meter values, charge detail records (CDRs), status events, and configuration — and that meter values are high-volume, time-ordered, and analytics-heavy, which is a poor fit for a row-store OLTP engine tuned for transactions [7].

**[Fact]** Managed-database providers serving EV charging platforms describe workloads that "mix 15–30 second telemetry writes with PCI-DSS billing data" [8]. Billing data demands strict ACID guarantees; telemetry demands cheap, append-heavy ingestion with time-windowed analytical reads.

**[Fact]** OLTP and OLAP are fundamentally different workloads: OLTP optimizes many small fast operations with concurrency control; OLAP optimizes large scans and aggregations over historical data [22]. Forcing both into one engine forces compromises in indexing, storage layout, and vacuum/maintenance behavior.

**[Recommendation]** Oracle holds the money-path (reservations, sessions, payments, invoices — strictly ACID), and TimescaleDB holds the telemetry path (meter ticks, connector state events — insert-heavy, time-ordered, aggregated with continuous aggregates [19]). This is the DA3 thesis, and it is the same thesis industry sources describe [7][8].

### 2.4 Tariffs and pricing

**[Fact]** Real networks price charging through several mechanisms: per-kWh energy pricing, time-based pricing, per-session fees, idle fees after charging completes, and time-of-use (ToU) schedules where the per-kWh price depends on time of day [12][13][14]. India's CEA framework for public charging stations is built around a single-part energy tariff per kWh (a billing simplification mandated by regulation) [17].

**[Recommendation]** Model tariffs as **versioned tariff plans with time-of-use rate bands**: a tariff has a fixed session fee (nullable), and a set of rate bands each defining a price per kWh that applies within time windows. This exercises versioning, temporal validity intervals, and non-trivial joins — all excellent database-design material — while remaining honest to how Indian CPOs actually bill [17].

### 2.5 The Indian deployment context (assumed market)

**[Fact]** India standardizes on Type 2 AC connectors (7.4–22 kW), CCS2 DC fast charging (25–150 kW), and the indigenous Bharat AC001/DC001 standards for low-cost charging [15][16]. National guidelines target one public charging station per 3x3 km grid in cities and one every 25 km on highways [18].

**[Recommendation]** Seed data reflects this reality: stations in Chennai with mixed Type 2 / CCS2 / Bharat AC001 connectors, ToU tariffs in INR per kWh, and coordinates around VIT Chennai and OMR. Local realism makes the demo memorable and defensible.

### 2.6 Time-series database landscape (DA3 candidates)

**[Fact]** TimescaleDB extends PostgreSQL with hypertables (automatic time/space chunking), continuous aggregates (incrementally-maintained materialized views refreshed in the background), native compression (commonly 10–20x), and retention policies [19][28]. InfluxDB 3 rebuilds the product on the FDAP stack (Flight, DataFusion, Arrow, Parquet) with SQL support and no cardinality limit; it wins on raw write throughput for pure metrics, while TimescaleDB wins when SQL semantics and hybrid relational workloads matter [20][21].

**[Fact]** Distributed SQL engines (CockroachDB, YugabyteDB, TiDB) solve horizontal scalability and geo-distribution; practitioners note they are niche compared to a well-tuned single-node relational database at small scale [27].

**[Recommendation]** TimescaleDB is the DA3 choice; the full 12-criteria decision matrix and the honest counterarguments are in Section 23–24 (file `13-da3-database-decision.md`).

### 2.7 acmvit.in — design forensics and extracted principles

**[Fact]** (Direct observation of `https://www.acmvit.in/` HTML, fetched 2026-09.) The site is built with **Astro** (`.astro` component scripts, scoped `data-astro-cid` styles), styled with **Tailwind CSS** (arbitrary-value utilities such as `text-[8rem]`, `leading-[0.85]`, `tracking-tighter`), self-hosts the **PolySans** family (Bold, Bulky Wide, Slim) as display type with **Inter** 400/700/900 as body type, uses a cream-on-dark palette (headline color `#FFFDD0`), full-screen video background sections, hairline `border-white/10` dividers, and oversized uppercase headings [25].

**[Recommendation]** What we take from ACM VIT is not their code or their look — it is their **design discipline**: (1) typography carries the identity, not decoration; (2) a near-monochrome palette with one warm accent; (3) enormous, tightly-tracked display type used sparingly for scale; (4) hairline borders instead of shadows-and-glass; (5) section-per-view narrative scrolling. What we deliberately do *not* copy: PolySans (paid), the cassette/retro motif, and Astro (wrong tool for a data-dense application). Our frontend uses Next.js and an original identity called **Grid Current**, specified in Section 21. For dark data-dense UIs we additionally apply the elevation-contrast lesson: without distinct surface steps, adjacent panels bleed together [26].

### 2.8 KPIs operators actually track

**[Fact]** Charging-network operators track uptime, charging success rate, energy delivered, utilization, session duration, and downtime [29][30]. A 2026 arXiv paper formalizes **Fault Time, Fault-Reason Time, and Unreachable Time** as actionable, computable performance metrics for charging sites [9].

**[Recommendation]** Our analytics schema computes exactly these: connector uptime %, utilization % (occupied time / sellable time), energy delivered per station/day, mean session duration, fault counts by reason, and peak-hour load curves. The arXiv metric definitions directly shape our `connector_state_event` model in DA3 — status transitions with timestamps make Fault/Unreachable Time a simple window computation [9].

---

## 3. Real-World EV Charging Domain Analysis

This section defines the domain vocabulary the entire database design is built on. Every entity in DA1 traces back to a concept defined here.

### 3.1 Actors and organizations

A **Charge Point Operator (CPO)** owns/operates physical charging infrastructure. An **eMobility Service Provider (EMSP)** owns the customer relationship with drivers [11]. In VoltHub these are simplified into one platform with three human roles: **Drivers** (discover, reserve, charge, pay), **Station Operators** (operate stations: monitor, maintain, manage faults), and **Admins** (manage users, operators, tariffs, and the audit trail). The fourth actor is not human: the **charger itself**, which speaks OCPP and is the source of truth for connector state and metering [1].

### 3.2 The physical hierarchy — Station, Charge Point (EVSE), Connector

**[Fact]** Charging infrastructure follows a strict three-level hierarchy. A **station** (location) contains one or more **charge points** (the physical cabinet; OCPP 2.x calls this an EVSE — Electric Vehicle Supply Equipment), each offering one or more **connectors** (the physical socket/cable: Type 2, CCS2, Bharat AC001, CHAdeMO) [1][15][16].

This hierarchy is not negotiable in the data model because OCPP itself identifies devices as `chargePointId / connectorId`, availability is a property of a *connector*, power capability is a property of a *connector's standard*, and a station's "has available chargers" is a *derived* aggregate over its connectors. Getting this hierarchy right is the difference between a toy schema and one that mirrors reality.

### 3.3 The charging session lifecycle

**[Fact]** Across OCPP versions, a session moves through an operational lifecycle: a driver authorizes (RFID tag / app / Plug-and-Charge in ISO 15118 [24]); the connector transitions to preparing; energy flow begins (charging); it may suspend (EV full, EVSE paused, fault); it finishes with a final meter reading; then the connector returns to available (or into fault) [1][2][23].

**[Recommendation]** VoltHub models the session lifecycle as an explicit, database-enforced state machine:

```
RESERVED -> PREPARING -> CHARGING -> SUSPENDED -> CHARGING -> COMPLETED
                  |                     |
                  +--> CANCELLED        +--> FAILED  (fault, payment failure)
COMPLETED -> BILLED -> PAID   (billing pipeline, separate from energy flow)
```

Session states live in a lookup table; PL/SQL package procedures are the *only* code path allowed to transition states; a trigger rejects illegal transitions; every transition is audit-logged. This turns "we thought about correctness" into a demoable, testable fact.

### 3.4 Reservations

Drivers reserve a **connector** for a future time window. Real systems constrain reservations to available connectors, prevent overlapping holds, expire no-shows, and convert a reservation into a session when the driver plugs in. Reservations are VoltHub's flagship concurrency problem: two drivers racing for the last CCS2 connector at 6 PM must be impossible to double-book, enforced by the database rather than by hope. Section 31 specifies the mechanism (`SELECT FOR UPDATE` + an exclusion constraint pattern); Section 15 implements it in PL/SQL.

### 3.5 Metering, energy, and billing

**[Fact]** Chargers report meter values (energy, power, current, voltage) periodically during a session — typically every 15–60 seconds in real deployments [7][8]. A session's bill derives from final meter deltas priced under the tariff plan active during the session, plus session/idle fees [13][14].

**[Recommendation]** Every `MeterValues` message becomes a `METER_READING` row in Oracle (session-scoped, the *billing* record of record: reading at start, at end, and periodic deltas) *and* a telemetry tick streamed to TimescaleDB in DA3 (the *analytics* record: high-frequency power/voltage/current/SOC for load curves). Same physical event, two purposeful representations at different resolutions — the clearest possible demonstration that OLTP and OLAP schemas differ by design, not by accident.

### 3.6 Faults, maintenance, and the operator loop

Connectors fail: hardware faults, cable breaks, payment terminal errors, or the charger simply becoming unreachable. Operators need a loop — fault reported or detected, maintenance ticket opened, work performed, connector restored — and managers need fault-time metrics per station [9]. VoltHub models `FAULT` (reported by OCPP `StatusNotification` with error codes, or manually) and `MAINTENANCE_RECORD` (inspection, repair, replacement with parts cost), linked to connectors and resolved by operators.

### 3.7 KPI definitions (used across DA2 queries and DA3 analytics)

| KPI | Definition | Where computed |
|---|---|---|
| Connector uptime % | 1 - (fault time / sellable time) over a period | DA3 cagg + DA2 MV |
| Utilization % | occupied session time / sellable connector time | DA3 cagg + DA2 MV |
| Energy delivered | sum of session kWh | Oracle sessions + DA3 ticks |
| Revenue | sum of invoice totals | Oracle (system of record) |
| Charging success rate | completed sessions / started sessions | Oracle |
| Mean session duration | avg(completed_at - started_at) | Oracle |
| Fault time | sum of fault-state durations by reason | DA3 state events [9] |
| Peak load | max avg power (kW) per time bucket | DA3 only |

The split is deliberate: money and session KPIs are Oracle-native (they need transactional truth); telemetry KPIs are TimescaleDB-native (they need time-series aggregation). Neither engine is asked to do the other's job.
