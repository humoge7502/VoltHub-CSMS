# Part II — Functional Requirements, Non-Functional Requirements, Scope, and Roles

> Masterplan sections 4–7. Requirements are numbered so that every entity, query, and screen later in the plan traces back to one. MoSCoW: **M** = must, **S** = should, **C** = could (stretch).

---

## 4. Functional Requirements

### 4.1 Identity and access

| ID | Requirement | MoSCoW | DA |
|---|---|---|---|
| FR-AUTH-01 | Users register as Driver with email + password (Argon2-hashed) and profile (name, phone) | M | DA2 |
| FR-AUTH-02 | Users authenticate and receive a JWT; roles: DRIVER, OPERATOR, ADMIN | M | DA2 |
| FR-AUTH-03 | Admin creates/edits Operator accounts and assigns them to stations | M | DA2 |
| FR-AUTH-04 | RBAC enforced at API layer (guards) and DB layer (grants); every mutation audit-logged | M | DA2 |

### 4.2 Vehicles and drivers

| ID | Requirement | MoSCoW | DA |
|---|---|---|---|
| FR-DRV-01 | Driver registers EVs: model, battery capacity kWh, connector standard(s) | M | DA2 |
| FR-DRV-02 | Driver sets a default vehicle used for reservation compatibility checks | S | DA2 |
| FR-DRV-03 | Driver views charging history with energy, cost, duration per session | M | DA2 |

### 4.3 Stations, charge points, connectors

| ID | Requirement | MoSCoW | DA |
|---|---|---|---|
| FR-STN-01 | Admin/Operator creates stations: name, geocode (lat/lng), address, operator owner | M | DA2 |
| FR-STN-02 | Station contains charge points (EVSE); each has OCPP identity and vendor/model | M | DA2 |
| FR-STN-03 | Charge points contain connectors; connector has standard (Type 2 / CCS2 / Bharat AC001 / CHAdeMO), max power kW, and live status | M | DA2 |
| FR-STN-04 | Driver searches stations by text, filters by connector standard and min power, sorts by distance | M | DA2 |
| FR-STN-05 | Map view renders stations; station detail shows connectors with live availability | M | DA2/3 |

### 4.4 Reservations

| ID | Requirement | MoSCoW | DA |
|---|---|---|---|
| FR-RSV-01 | Driver reserves an available connector for a 15–120 min future window | M | DA2 |
| FR-RSV-02 | Overlapping reservations on the same connector are impossible (DB-enforced) | M | DA2 |
| FR-RSV-03 | No-show reservations auto-expire and release the connector | M | DA2 |
| FR-RSV-04 | Driver can cancel a reservation before it starts | M | DA2 |
| FR-RSV-05 | Reservation converts to a session when the simulated charger reports plug-in with the reserving driver's idTag | S | DA2 |

### 4.5 Charging sessions and metering

| ID | Requirement | MoSCoW | DA |
|---|---|---|---|
| FR-SES-01 | Charger simulator performs full OCPP 1.6J flow: BootNotification, StatusNotification, Authorize, StartTransaction, MeterValues (5s ticks), StopTransaction | M | DA2 |
| FR-SES-02 | Backend creates/updates session rows from OCPP events; connector status mirrors charger-reported state | M | DA2 |
| FR-SES-03 | Every MeterValues tick is persisted: billing-grade readings in Oracle, telemetry ticks to the analytics store (DA3) | M | DA2/3 |
| FR-SES-04 | Driver sees live session: elapsed time, kWh delivered, current kW, estimated cost | M | DA2 |
| FR-SES-05 | Driver can remote-stop a session (OCPP RemoteStopTransaction) | S | DA2 |
| FR-SES-06 | Session state machine transitions validated in PL/SQL; illegal transitions rejected and logged | M | DA2 |

### 4.6 Tariffs, billing, payments

| ID | Requirement | MoSCoW | DA |
|---|---|---|---|
| FR-TAR-01 | Admin defines tariff plans: name, currency, optional fixed session fee, optional idle-fee per 30 min | M | DA2 |
| FR-TAR-02 | Tariff plans carry time-of-use rate bands: price per kWh valid within day-of-week + time windows | M | DA2 |
| FR-TAR-03 | Tariff plans are versioned; sessions record the tariff version used (price changes never rewrite history) | M | DA2 |
| FR-BIL-01 | On session completion, PL/SQL bills the session: kWh x band price + fees, creating an INVOICE | M | DA2 |
| FR-BIL-02 | Invoice is itemized (energy charge, session fee, idle fee, tax line) | S | DA2 |
| FR-PAY-01 | Driver "pays" invoices through a mocked wallet (prepaid balance); no real card data ever stored | M | DA2 |
| FR-PAY-02 | Failed wallet payment marks invoice PENDING and session billing state FAILED for retry | S | DA2 |

### 4.7 Faults and maintenance

| ID | Requirement | MoSCoW | DA |
|---|---|---|---|
| FR-FLT-01 | OCPP StatusNotification error codes create FAULT records automatically; operator can file faults manually | M | DA2 |
| FR-FLT-02 | Faulted connectors become unavailable for reservation immediately | M | DA2 |
| FR-MNT-01 | Operator opens maintenance records: type, description, parts cost, start/end timestamps, resolution | M | DA2 |
| FR-MNT-02 | Resolving maintenance on a fault restores connector to AVAILABLE (state machine enforced) | S | DA2 |

### 4.8 Reviews and notifications

| ID | Requirement | MoSCoW | DA |
|---|---|---|---|
| FR-REV-01 | Driver rates a completed session's station (1–5 + comment); one review per session | S | DA2 |
| FR-NTF-01 | In-app notifications: reservation confirmation/expiry, session completion, invoice due | S | DA2/3 |

### 4.9 Analytics and observability

| ID | Requirement | MoSCoW | DA |
|---|---|---|---|
| FR-ANL-01 | Operator dashboard: revenue, energy, utilization, active sessions, faults per station | M | DA2/3 |
| FR-ANL-02 | DA3: live network load curve, hourly utilization heatmap, per-connector power traces from TimescaleDB | M | DA3 |
| FR-ANL-03 | Admin system dashboard: user growth, network KPIs, audit log browser | S | DA2 |

### 4.10 Charger/protocol (system actor)

| ID | Requirement | MoSCoW | DA |
|---|---|---|---|
| FR-OCPP-01 | Simulator fleet runs scripted scenarios: normal charge, simultaneous race for one connector, fault mid-session, no-show reservation, out-of-order meter ticks | M | DA2/3 |
| FR-OCPP-02 | OCPP gateway accepts authenticated WebSocket connections per charge point identity | M | DA2 |

---

## 5. Non-Functional Requirements

| ID | Category | Requirement | Acceptance criterion |
|---|---|---|---|
| NFR-01 | Correctness | No double reservation, no negative energy, no invoice without completed session, ever | Concurrency test suite passes; DB constraints reject violations |
| NFR-02 | Consistency | Reservation overlap prevention is enforced by the database, not app logic | Two concurrent requests: exactly one succeeds (demoed live) |
| NFR-03 | Performance | Interactive API p95 < 300 ms on laptop-scale data (10k sessions) | k6 smoke script report |
| NFR-04 | Ingestion | Simulator fleet of 50 chargers x 5 s ticks ingests without unbounded lag | Pipeline lag metric stays < 30 s in 10-min run |
| NFR-05 | Auditability | Every state-changing mutation has an audit trail row (who, what, when, old/new) | Spot-check in demo; AUDIT_LOG row exists for every mutation |
| NFR-06 | Security | Passwords Argon2-hashed; JWT RBAC; parameterized SQL only; no card data | Security checklist in Section 30 fully ticked |
| NFR-07 | Testability | Core flows covered by automated tests runnable in CI | `npm run test` green in GitHub Actions |
| NFR-08 | Reproducibility | `docker compose up` produces a fully seeded working system on any laptop | Fresh-clone setup documented and verified |
| NFR-09 | Demo-ability | Every showcase feature reachable in <= 2 clicks from a dashboard | Demo rehearsal checklist |
| NFR-10 | Observability | Structured JSON logs with request IDs; health endpoints for API and both DBs | `/health` reports Oracle + Timescale status |
| NFR-11 | Honesty | No claims of production scale without benchmark numbers shown in-repo | README states tested scale explicitly |

---

## 6. Scope Definition

### 6.1 Core MVP (the system must ship with all of this)

Stations / charge points / connectors hierarchy; driver/operator/admin roles with JWT auth; station search + map + connector availability; reservations with DB-enforced overlap prevention; full OCPP 1.6J simulator loop producing sessions and meter readings; tariff plans with ToU bands and versioning; PL/SQL billing into itemized invoices; wallet payments; faults + maintenance; operator dashboard with core KPIs; audit logging; Docker Compose with seeded data.

**Rationale:** this set alone fully satisfies DA1 (rich ER model), DA2 (SQL + PL/SQL + objects + sample data + live demo), and the transactional core of DA3 (telemetry outbox streaming into TimescaleDB).

### 6.2 Strong portfolio features (high signal, moderate cost)

Live telemetry charts on the operator dashboard (TimescaleDB continuous aggregates); utilization heatmap; keyset-paginated history endpoints; race-condition test suite demonstrated in CI; versioned SQL migrations; OpenAPI docs; LTTB-downsampled power traces; reservation expiry background job; notifications.

### 6.3 Stretch features (build only if ahead of schedule)

Grafana dashboard over TimescaleDB (1 hour of work, huge demo payoff); CSV export; GraphQL read endpoint beside REST (only with explicit "why both" answer prepared); multi-currency tariffs; ISO 15118 Plug-and-Charge *simulation* of the authorize step (concept discussed, not implemented).

### 6.4 Explicitly excluded (with reasons)

| Excluded | Reason |
|---|---|
| Real payment gateway (Stripe/Razorpay) | Storing/handling real money flows adds compliance burden (PCI) with zero database-learning value. Mocked wallet keeps the billing model honest. |
| Microservices / Kafka / RabbitMQ | One node, one team. An outbox table + worker gives the event-driven lesson without the operational tax. |
| Kubernetes | Docker Compose is the honest deployment for the scale; K8s would be resume-keyword collecting. |
| Mobile app | Responsive web covers the demo; a second frontend halves quality. |
| ML (demand prediction, dynamic pricing) | No defensible dataset at student scale; would look like technology collecting. |
| OCPI roaming | Real multi-party protocol requiring a partner CPO; out of scope, discussed in docs only [11]. |
| Real charger hardware | Impossible in scope; the OCPP simulator is the accepted approach in CSMS testing [10]. |
| Redis caching layer (early) | At our scale Oracle + materialized views + keyset pagination suffice; Redis appears only as an optional stretch with a measured reason. |

---

## 7. User Roles

### 7.1 Role definitions

**Driver** — the customer. Registers EVs, discovers stations on map/list, checks live connector availability, reserves, charges (via the simulated charger assigned their idTag), watches the live session, pays invoices from wallet, reviews stations, browses history and personal energy/cost analytics.

**Station Operator** — runs assigned stations. Sees station health at a glance (connector states, active sessions), revenue and energy analytics, opens/manages faults and maintenance, forces connector availability changes (OCPP ChangeAvailability), monitors live network load (DA3).

**Admin** — runs the platform. Manages users and operators, owns stations and tariff plans, reads the audit log, sees network-wide KPIs and growth analytics.

**System (OCPP actor)** — the charger fleet (simulated). Not a UI user: authenticates per charge point over WebSocket, reports state and metering, receives remote commands. Treating the charger as a first-class actor is what keeps the schema honest.

### 7.2 RBAC permission matrix

| Capability | Driver | Operator | Admin | OCPP actor |
|---|---|---|---|---|
| Search stations / view availability | yes | yes | yes | n/a |
| Create/edit own EVs | yes | - | - | n/a |
| Create reservations | yes | - | - | n/a |
| Cancel own reservation | yes | operator (station scope) | yes | n/a |
| Start/stop own session | via charger | remote stop (station scope) | - | start/stop (protocol) |
| View own invoices/history | yes | - | - | n/a |
| Pay invoices (wallet) | yes | - | - | n/a |
| Review stations (own session) | yes | - | - | n/a |
| View station analytics | - | yes (assigned stations) | yes (network) | n/a |
| Manage faults/maintenance | - | yes (station scope) | yes | report (protocol) |
| Manage users/operators | - | - | yes | n/a |
| Manage stations/charge points | - | - | yes | n/a |
| Manage tariff plans | - | - | yes | n/a |
| Read audit log | - | - | yes | n/a |
| Report meter values / status | - | - | - | yes (protocol identity) |

Authorization is enforced twice: NestJS guards for API ergonomics, Oracle grants and `SECURE_PKG.CHECK_ACCESS` calls inside PL/SQL for defense in depth — a nice viva point showing defense is layered, not cosmetic.
