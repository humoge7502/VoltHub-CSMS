# Part IV — DA1: Complete ER/EER Design

> Masterplan section 9. This is the design to redraw by hand for the DA1 report. Every entity, key, cardinality, participation constraint, and business rule is stated explicitly so the handwritten version can be reproduced without ambiguity. A rendered ER diagram lives in `diagrams/er-model.mmd`.

---

## 9.1 From requirements to entities

Each entity below traces to requirement groups from Section 4 (traceability shown in parentheses). The design contains **21 strong entities, 2 weak entities, 2 specializations, 2 conceptually multivalued attributes, and 5 derived attributes** — rich enough for full marks, small enough for a team of three to implement completely.

**Entity inventory:**

| #   | Entity                          | Type                 | Purpose                                                       | Trace           |
| --- | ------------------------------- | -------------------- | ------------------------------------------------------------- | --------------- |
| E1  | APP_USER                        | strong               | anyone who authenticates; superclass of Driver/Operator/Admin | AUTH-01..04     |
| E2  | WALLET_ACCOUNT                  | strong, 1:1          | prepaid balance for drivers                                   | PAY-01          |
| E3  | VEHICLE                         | strong               | driver's EV                                                   | DRV-01          |
| E4  | CONNECTOR_STANDARD              | lookup               | Type 2, CCS2, Bharat AC001, CHAdeMO                           | STN-03          |
| E5  | STATION                         | strong               | physical site with geocode                                    | STN-01          |
| E6  | CHARGE_POINT                    | strong               | EVSE cabinet with OCPP identity                               | STN-02, OCPP-02 |
| E7  | CONNECTOR                       | **weak**             | physical socket; partial key `connector_no`                   | STN-03          |
| E8  | TARIFF_PLAN                     | strong               | versioned tariff (self-versioning chain)                      | TAR-01..03      |
| E9  | TARIFF_BAND                     | strong (identifying) | ToU price band within a plan                                  | TAR-02          |
| E10 | RESERVATION                     | associative          | driver holds a connector for a window                         | RSV-01..05      |
| E11 | CHARGING_SESSION                | associative          | energy delivery event (the core entity)                       | SES-01..06      |
| E12 | METER_READING                   | **weak**             | meter tick within a session; partial key `seq_no`             | SES-03          |
| E13 | SESSION_STATE / CONNECTOR_STATE | lookup               | state machines + allowed transitions                          | SES-02,06       |
| E14 | INVOICE                         | strong               | bill for one session                                          | BIL-01          |
| E15 | INVOICE_LINE                    | strong (identifying) | itemized line (energy/fees/tax)                               | BIL-02          |
| E16 | PAYMENT                         | strong               | payment attempt against an invoice                            | PAY-01..02      |
| E17 | WALLET_LEDGER                   | strong (identifying) | append-only balance movements                                 | PAY-01          |
| E18 | FAULT                           | strong               | connector/charge-point fault event                            | FLT-01..02      |
| E19 | MAINTENANCE_RECORD              | strong               | work performed                                                | MNT-01..02      |
| E20 | REVIEW                          | strong               | driver rating tied to a session                               | REV-01          |
| E21 | NOTIFICATION                    | strong               | in-app message                                                | NTF-01          |
| E22 | AUDIT_LOG                       | strong               | mutation trail                                                | AUTH-04         |
| E23 | OUTBOX_EVENT                    | strong               | telemetry events for the DA3 pipeline                         | SES-03, ANL-02  |
| E24 | VEHICLE_STANDARD_SUPPORT        | associative          | resolves multivalued "supported standards"                    | DRV-01          |
| E25 | STATION_AMENITY                 | associative          | resolves multivalued "amenities"                              | STN-01          |

---

## 9.2 Entities, attributes, and keys

Notation: **PK** primary key, **CK** candidate key (unique), **FK** foreign key, **DE** derived, _partial key_ for weak entities.

**E1 APP_USER** — `user_id PK (surrogate)`, `email CK NOT NULL`, `password_hash NOT NULL`, `full_name NOT NULL`, `phone`, `role NOT NULL CHECK (role IN ('DRIVER','OPERATOR','ADMIN'))`, `status NOT NULL`, `created_at NOT NULL`. _Specialization discriminator: `role`._

**E2 WALLET_ACCOUNT** — `user_id PK, FK -> APP_USER (1:1)`, `balance NOT NULL CHECK (balance >= 0)` _(DE: derivable from WALLET_LEDGER; cached for O(1) checks — denormalization analyzed in Section 12.6)_, `currency NOT NULL DEFAULT 'INR'`, `updated_at NOT NULL`.

**E3 VEHICLE** — `vehicle_id PK`, `owner_id FK -> APP_USER`, `make NOT NULL`, `model NOT NULL`, `battery_kwh CHECK (5..250)`, `created_at`. _Multivalued attribute `supported_standards` resolved as E24._

**E4 CONNECTOR_STANDARD** — `standard_id PK`, `code CK NOT NULL UNIQUE ('TYPE2','CCS2','BHARAT_AC001','BHARAT_DC001','CHADEMO')`, `display_name NOT NULL`, `max_typical_kw`.

**E5 STATION** — `station_id PK`, `name NOT NULL`, `latitude/longitude NOT NULL (CHECK ranges)`, `address_line, city, state, pincode`, `status NOT NULL`, `operator_id FK -> APP_USER`, `created_at`. _Derived: `available_connector_count` (computed, not stored — Section 12.6). Multivalued `amenities` resolved as E25._

**E6 CHARGE_POINT** — `cp_id PK`, `station_id FK -> STATION`, `ocpp_identity CK NOT NULL UNIQUE` (the OCPP chargeBox identity), `vendor, model, firmware_version`, `status NOT NULL`, `last_boot_at`, `created_at`.

**E7 CONNECTOR (weak)** — `cp_id FK -> CHARGE_POINT (identifying relationship)`, `connector_no *partial key*`, `PK = (cp_id, connector_no)`, `standard_id FK -> CONNECTOR_STANDARD`, `max_power_kw CHECK (3..400)`, `status NOT NULL FK -> CONNECTOR_STATE`, `last_state_change_at`, `created_at`. _A connector cannot exist without its charge point (existence dependency)._

**E8 TARIFF_PLAN** — `plan_id PK`, `group_id NOT NULL` (identity of the tariff across versions), `version_no NOT NULL`, `CK = (group_id, version_no)`, `name NOT NULL`, `currency NOT NULL DEFAULT 'INR'`, `session_fee CHECK (>= 0) nullable`, `idle_fee_per_30min nullable`, `active_from NOT NULL`, `active_to nullable`, `supersedes_plan_id FK -> TARIFF_PLAN (self, nullable)`, `created_by FK -> APP_USER`. _Versioning rule BR-09._

**E9 TARIFF_BAND** — `band_id PK`, `plan_id FK -> TARIFF_PLAN`, `price_per_kwh NOT NULL CHECK (> 0)`, `day_scope CHECK IN ('ALL','WEEKDAY','WEEKEND')`, `start_time NOT NULL`, `end_time NOT NULL`, `CK = (plan_id, day_scope, start_time)`. _Business rule BR-08: bands within a plan+day_scope must not overlap (enforced in TARIFF_PKG)._

**E10 RESERVATION** — `reservation_id PK`, `connector_id FK`, `user_id FK`, `vehicle_id FK`, `start_at NOT NULL`, `end_at NOT NULL CHECK (end_at > start_at)`, `status NOT NULL FK -> RESERVATION_STATE`, `created_at`, `cancelled_at`. _Window rule BR-04 (15–120 min); overlap rule BR-05 enforced by RESERVATION_PKG (Section 15/31)._

**E11 CHARGING_SESSION** — `session_id PK`, `connector_id FK NOT NULL`, `user_id FK NOT NULL`, `vehicle_id FK nullable`, `reservation_id FK UQ nullable (0..1 on each side)`, `tariff_plan_id FK NOT NULL`, `id_tag NOT NULL`, `state NOT NULL FK -> SESSION_STATE`, `billing_state CHECK IN ('UNBILLED','BILLED','FAILED','WAIVED')`, `started_at`, `ended_at`, `start_meter_kwh NOT NULL`, `end_meter_kwh nullable`, `energy_kwh DE (end - start, persisted by BILLING_PKG at completion — Section 12.6)`, `stop_reason nullable`.

**E12 METER_READING (weak)** — `session_id FK -> CHARGING_SESSION (identifying)`, `seq_no *partial key*`, `PK = (session_id, seq_no)`, `taken_at NOT NULL`, `meter_kwh NOT NULL CHECK (>= 0)`, `power_kw`, `voltage_v`, `current_a`, `source CHECK IN ('OCPP','SYNTHETIC')`, `ingested_at`. _Out-of-order rule BR-11: seq_no assigned by gateway per session; monotonic per session._

**E13 State lookups** — `CONNECTOR_STATE(state_code PK, description, is_terminal)`: AVAILABLE, OCCUPIED, RESERVED, FAULTED, OFFLINE, UNAVAILABLE. `SESSION_STATE(state_code PK, description)`: RESERVED, PREPARING, CHARGING, SUSPENDED, COMPLETED, CANCELLED, FAILED. Transition matrix lives in PL/SQL `CHARGE_SESSION_PKG.TRANSITION` (Section 15.2) — the database is the state-machine authority.

**E14 INVOICE** — `invoice_id PK`, `session_id FK UQ NOT NULL (1:1)`, `tariff_plan_id FK NOT NULL`, `issued_at NOT NULL`, `status CHECK IN ('DUE','PAID','FAILED','VOID')`, `total DE (sum of lines, persisted at issue)`, `currency NOT NULL`.

**E15 INVOICE_LINE** — `invoice_id FK (identifying)`, `line_no *partial*`, `PK = (invoice_id, line_no)`, `kind CHECK IN ('ENERGY','SESSION_FEE','IDLE_FEE','TAX','ADJUSTMENT')`, `description NOT NULL`, `quantity NOT NULL`, `unit`, `amount NOT NULL CHECK (>= 0)`.

**E16 PAYMENT** — `payment_id PK`, `invoice_id FK NOT NULL`, `amount NOT NULL CHECK (> 0)`, `method CHECK IN ('WALLET')` — _specialization: CARD_PAYMENT deliberately not implemented (Section 12.7); the method column is the extension point_, `status CHECK IN ('SUCCESS','FAILED')`, `attempted_at NOT NULL`, `reference`.

**E17 WALLET_LEDGER** — `user_id FK (identifying)`, `seq_no *partial*`, `PK = (user_id, seq_no)`, `kind CHECK IN ('TOPUP','PAYMENT','REFUND','ADJUSTMENT')`, `amount (signed) NOT NULL`, `balance_after NOT NULL`, `payment_id FK nullable`, `created_at NOT NULL`. _Append-only: UPDATE/DELETE revoked by grant (Section 13.4)._

**E18 FAULT** — `fault_id PK`, `connector_id FK nullable`, `cp_id FK nullable (CHECK: exactly one of connector/cp is set)`, `code NOT NULL`, `severity CHECK IN ('INFO','WARN','CRITICAL')`, `source CHECK IN ('OCPP','MANUAL')`, `reported_at NOT NULL`, `cleared_at nullable`, `note`.

**E19 MAINTENANCE_RECORD** — `maint_id PK`, `connector_id FK nullable`, `fault_id FK UQ nullable (a fault is fixed by at most one maintenance record)`, `type CHECK IN ('INSPECTION','REPAIR','REPLACEMENT')`, `description NOT NULL`, `parts_cost CHECK (>= 0)`, `performed_by FK -> APP_USER`, `started_at NOT NULL`, `ended_at nullable`, `outcome`.

**E20 REVIEW** — `review_id PK`, `session_id FK UQ NOT NULL (one review per session)`, `user_id FK NOT NULL`, `rating CHECK (1..5)`, `comment`, `created_at`. _CK: `session_id` (functional dependency: session determines review)._

**E21 NOTIFICATION** — `notification_id PK`, `user_id FK`, `kind NOT NULL`, `payload (JSON CLOB)`, `read_at`, `created_at`.

**E22 AUDIT_LOG** — `audit_id PK`, `actor_user_id FK nullable (NULL = system/OCPP)`, `entity_name NOT NULL`, `entity_pk NOT NULL`, `action NOT NULL`, `old_values CLOB (JSON)`, `new_values CLOB (JSON)`, `occurred_at NOT NULL`. _Insert-only by grant._

**E23 OUTBOX_EVENT** — `event_id PK`, `kind CHECK IN ('METER_TICK','CONNECTOR_STATE','SESSION_EVENT')`, `payload CLOB (JSON) NOT NULL`, `created_at NOT NULL`, `processed_at nullable`. _DA3 relay cursor; idempotency key = (kind, source ids, seq)._

**E24 VEHICLE_STANDARD_SUPPORT** — `vehicle_id FK`, `standard_id FK`, `PK = (vehicle_id, standard_id)`. _Resolves multivalued attribute `VEHICLE.supported_standards`._

**E25 STATION_AMENITY** — `station_id FK`, `amenity CHECK IN ('CAFE','RESTROOM','WIFI','PARKING','SHOP','CANOPY','CCTV')`, `PK = (station_id, amenity)`. _Resolves multivalued attribute `STATION.amenities`._

---

## 9.3 Relationships, cardinalities, and participation

| #   | Relationship                                         | Cardinality          | Participation                         | Notes                                   |
| --- | ---------------------------------------------------- | -------------------- | ------------------------------------- | --------------------------------------- |
| R1  | APP_USER owns VEHICLE                                | 1:N                  | VEHICLE total, USER partial           | a vehicle always has an owner           |
| R2  | APP_USER holds WALLET_ACCOUNT                        | 1:1                  | partial (drivers only)                | specialization consequence              |
| R3  | APP_USER operates STATION                            | 1:N                  | STATION total, USER partial           | operator assignment                     |
| R4  | STATION contains CHARGE_POINT                        | 1:N                  | CP total, STATION partial             | composition                             |
| R5  | CHARGE_POINT has CONNECTOR                           | 1:N **identifying**  | CONNECTOR total                       | weak entity; partial key `connector_no` |
| R6  | CONNECTOR_STANDARD classifies CONNECTOR              | 1:N                  | CONNECTOR total                       | lookup                                  |
| R7  | TARIFF_PLAN contains TARIFF_BAND                     | 1:N **identifying**  | BAND total                            | bands exist only within a plan          |
| R8  | TARIFF_PLAN supersedes TARIFF_PLAN                   | 1:N (self)           | partial                               | version chain BR-09                     |
| R9  | APP_USER reserves CONNECTOR (via RESERVATION)        | M:N with attributes  | associative entity                    | attributes: window, status              |
| R10 | APP_USER charges at CONNECTOR (via CHARGING_SESSION) | M:N with attributes  | associative entity                    | the core business event                 |
| R11 | CHARGING_SESSION produces METER_READING              | 1:N **identifying**  | READING total, SESSION partial        | weak entity; partial key `seq_no`       |
| R12 | CHARGING_SESSION billed as INVOICE                   | 1:1                  | INVOICE total, SESSION partial (0..1) | session exists before bill              |
| R13 | INVOICE itemized as INVOICE_LINE                     | 1:N identifying      | LINE total                            |                                         |
| R14 | INVOICE settled by PAYMENT                           | 1:N                  | PAYMENT total, INVOICE partial        | retry attempts allowed                  |
| R15 | PAYMENT debits WALLET_LEDGER                         | 1:1                  | partial                               | ledger entry references payment         |
| R16 | APP_USER has WALLET_LEDGER                           | 1:N identifying      | LEDGER total                          | append-only history                     |
| R17 | CONNECTOR suffers FAULT                              | 1:N                  | FAULT total (to connector or CP)      | CHECK exactly-one-target                |
| R18 | FAULT addressed by MAINTENANCE_RECORD                | 1:0..1               | partial                               | UQ fault_id                             |
| R19 | APP_USER performs MAINTENANCE_RECORD                 | 1:N                  | RECORD total, USER partial            |                                         |
| R20 | CHARGING_SESSION reviewed (REVIEW)                   | 1:0..1               | partial both                          | UQ session_id                           |
| R21 | APP_USER receives NOTIFICATION                       | 1:N                  | partial                               |                                         |
| R22 | APP_USER performs AUDIT_LOG action                   | 1:N                  | partial                               | NULL actor = system                     |
| R23 | VEHICLE supports CONNECTOR_STANDARD (E24)            | M:N                  | total both sides                      | resolves multivalued attribute          |
| R24 | STATION offers amenity (E25)                         | M:N (with value-set) | total                                 | resolves multivalued attribute          |
| R25 | RESERVATION converts to CHARGING_SESSION             | 1:0..1               | partial                               | UQ reservation_id                       |

### 9.3.1 Compact ER overview (hand-copy friendly)

```
APP_USER 1──N VEHICLE            APP_USER 1──1 WALLET_ACCOUNT
APP_USER 1──N STATION (operates) APP_USER 1──N NOTIFICATION / AUDIT_LOG
STATION  1──N CHARGE_POINT 1──N CONNECTOR N──1 CONNECTOR_STANDARD
APP_USER M── CONNECTOR ──M via RESERVATION (window,status)
APP_USER M── CONNECTOR ──M via CHARGING_SESSION ──N METER_READING (weak, seq_no)
TARIFF_PLAN 1──N TARIFF_BAND ;  TARIFF_PLAN supersedes TARIFF_PLAN (self)
CHARGING_SESSION 1──1 INVOICE 1──N INVOICE_LINE ; INVOICE 1──N PAYMENT
PAYMENT 1──1 WALLET_LEDGER ;  CONNECTOR 1──N FAULT 0..1──1 MAINTENANCE_RECORD
CHARGING_SESSION 0..1──1 REVIEW ;  RESERVATION 0..1──1 CHARGING_SESSION
VEHICLE M──N CONNECTOR_STANDARD (support) ;  STATION M──N AMENITY (value set)
```

---

## 9.4 EER constructs (specialization, multivalued, derived)

**Specialization 1 — APP_USER superclass.** Subclasses DRIVER, STATION_OPERATOR, ADMIN. Constraints: **disjoint** (one role per user; enforced by CHECK) and **total** (every user has exactly one role). Predicate-defined (on `role`). Relational mapping (Section 10.2): single table with role discriminator + optional subclass tables where subclass-specific attributes exist (WALLET_ACCOUNT for DRIVER). We considered three tables joined on user_id and rejected it: two extra joins on every auth lookup for zero normalization gain — the discriminator column is a key, not a fact, so 3NF is not violated. This trade-off is a strong viva discussion.

**Specialization 2 — PAYMENT superclass.** Subclasses WALLET_PAYMENT (implemented) and CARD_PAYMENT (deliberately future). **Partial, disjoint.** Only WALLET_PAYMENT rows exist today; the discriminator `method` plus a documented extension plan shows forward-design thinking without speculative tables.

**Multivalued attributes (conceptually justified, not decorative).** A vehicle genuinely supports several connector standards (a 2024 Tata Nexon EV: Type 2 AC + CCS2 DC) — modeled as VEHICLE_STANDARD_SUPPORT. A station genuinely offers several amenities — modeled as STATION_AMENITY with a constrained value set. Both would be 1NF violations as comma-separated lists (Section 12.1 demonstrates exactly that failure).

**Derived attributes (5).** WALLET_ACCOUNT.balance (sum of ledger), CHARGING_SESSION.energy_kwh (meter delta), INVOICE.total (sum of lines), STATION.available_connector_count (count over connectors), KPI metrics (uptime, utilization). Each is either computed on read (station count) or persisted by the package that owns the invariant (energy_kwh, invoice total, balance_after) — the "store derived data only at the moment its precondition is locked" rule, explained in Section 12.6.

---

## 9.5 Business rules (BR-01 … BR-14)

| BR  | Rule                                                                                           | Enforced by                                                      |
| --- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 01  | Email is globally unique; passwords stored only as Argon2 hashes                               | CK + app policy                                                  |
| 02  | A wallet balance can never go negative                                                         | CHECK + ledger-debit procedure                                   |
| 03  | A connector belongs to exactly one charge point; a charge point to one station                 | FK chain                                                         |
| 04  | Reservation windows span 15–120 minutes and must start in the future                           | CHECK + package validation                                       |
| 05  | Two reservations on the same connector may never overlap                                       | RESERVATION_PKG (SELECT FOR UPDATE + overlap query) — Section 31 |
| 06  | A reservation can convert to at most one session; a session references at most one reservation | UQ reservation_id                                                |
| 07  | Connector status is only set by OCPP events or the state machine, never ad-hoc UPDATE          | grants + trigger                                                 |
| 08  | Tariff bands within a plan and day-scope may not overlap in time-of-day                        | TARIFF_PKG validation                                            |
| 09  | Tariff plans are immutable once active; changes create a new version superseding the old       | self-FK + package                                                |
| 10  | A session bills exactly once; INVOICE is 1:1 with COMPLETED sessions                           | UQ session_id + BILLING_PKG                                      |
| 11  | Meter readings are monotonic per session by seq_no; meter_kwh non-decreasing within tolerance  | PK + package check on ingest                                     |
| 12  | A faulted connector is immediately unbookable                                                  | status check in reservation package                              |
| 13  | One review per completed session, author must be the session's driver                          | UQ + package check                                               |
| 14  | Every state-changing mutation writes AUDIT_LOG                                                 | triggers + package discipline                                    |

---

## 9.6 Weak entities — why they are genuinely weak

**CONNECTOR** is identified by its charge point plus `connector_no` (OCPP addressing is exactly `chargePointIdentity/connectorId` [1]). It has no global identity independent of its parent; delete the charge point and the connector ceases to exist. That is the textbook definition of a weak entity with an identifying relationship — and it mirrors the physical world, which makes it easy to defend.

**METER_READING** is identified by its session plus `seq_no`. A reading without its session is meaningless; readings are existence-dependent and share their parent's fate. The surrogate `reading_id` used in Oracle is an implementation convenience; the _logical_ key is (session_id, seq_no), and the UNIQUE constraint proves we understand the difference.

## 9.7 Design decisions a viva will probe

1. **Why is RESERVATION an entity and not a M:N relation directly?** Because it carries attributes (window, status, timestamps) — a M:N relationship with attributes is mapped as an associative entity; also because the _no-overlap_ invariant needs a key space to constrain.
2. **Why lookups for states instead of CHECK enums?** Because transitions are data (driven by protocol events), need descriptions in UI, and CHECK-only states cannot express "which transitions are legal from which state" — the matrix lives in CHARGE_SESSION_PKG.
3. **Why is energy_kwh stored if derived?** Because the meter may keep reporting corrections after end; the completed-session delta is a _business fact_ frozen at billing time (BR-10), not a live computation. The derivation rule is documented, which is what "derived attribute" means in a report.
4. **Why not one STATION_ADDRESS separate entity?** Address is single-valued 1:1 data; splitting it adds a join with no FD-based justification. Section 12.4 shows the _opposite_ example (where splitting IS required).
5. **Why AUDIT_LOG as JSON blobs instead of per-table history tables?** One append-only trail covers 15 tables with a uniform query interface; per-table history would triple table count for no analytical gain at this scale. Trade-off honestly stated: JSON columns are schema-flexible but not FK-constrainable — acceptable for an audit trail whose purpose is forensics, not referential integrity.
