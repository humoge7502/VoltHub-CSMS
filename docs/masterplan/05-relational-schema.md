# Part V — Relational Schema (ER → Relations)

> Masterplan section 10. Every relation is written in assignment notation with datatype, keys, and constraints, followed by the mapping rationale and the index plan. Oracle 23ai datatypes are used (DA2 runs on gvenzl/oracle-free); `NUMBER`, `TIMESTAMP`, `CLOB` map directly to the handwritten report.

---

## 10.1 Relation inventory

25 relations: 21 business tables + 3 state lookups + 1 audit + 1 outbox. Naming: `SNAKE_CASE`, singular entity names, `*_id` surrogate keys, `*_at` timestamps. All tables `NOMONITORING`-friendly and created by versioned migration `db/oracle/V001__core_schema.sql`.

---

## 10.2 The relations

### Identity, wallet, vehicles

```
APP_USER(
  user_id        NUMBER(9)        PK (sequence),
  email          VARCHAR2(255)    NOT NULL, UNIQUE,
  password_hash  VARCHAR2(97)     NOT NULL,             -- Argon2id encoded
  full_name      VARCHAR2(120)    NOT NULL,
  phone          VARCHAR2(20),
  role           VARCHAR2(12)     NOT NULL CHECK (role IN ('DRIVER','OPERATOR','ADMIN')),
  status         VARCHAR2(10)     NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at     TIMESTAMP(6)     NOT NULL DEFAULT SYSTIMESTAMP
)
-- CK: email ; CK: (email) is the natural/candidate key, user_id surrogate
```

```
WALLET_ACCOUNT(
  user_id    NUMBER(9)      PK, FK -> APP_USER(user_id),
  balance    NUMBER(12,2)   NOT NULL CHECK (balance >= 0),
  currency   CHAR(3)        NOT NULL DEFAULT 'INR',
  updated_at TIMESTAMP(6)   NOT NULL
)
-- 1:1 with APP_USER (partial: DRIVER rows only) ; balance = derived, maintained by BILLING_PKG
```

```
WALLET_LEDGER(
  user_id       NUMBER(9)     FK -> APP_USER,        -- identifying
  seq_no        NUMBER(9)     NOT NULL,              -- partial key
  -- PK (user_id, seq_no)
  kind          VARCHAR2(12)  NOT NULL CHECK (kind IN ('TOPUP','PAYMENT','REFUND','ADJUSTMENT')),
  amount        NUMBER(12,2)  NOT NULL,              -- signed
  balance_after NUMBER(12,2)  NOT NULL CHECK (balance_after >= 0),
  payment_id    NUMBER(12)    FK -> PAYMENT(payment_id) nullable,
  created_at    TIMESTAMP(6)  NOT NULL,
  note          VARCHAR2(200)
)
```

```
VEHICLE(
  vehicle_id  NUMBER(9)     PK,
  owner_id    NUMBER(9)     NOT NULL FK -> APP_USER(user_id),
  make        VARCHAR2(40)  NOT NULL,
  model       VARCHAR2(60)  NOT NULL,
  battery_kwh NUMBER(6,1)   NOT NULL CHECK (battery_kwh BETWEEN 5 AND 250),
  created_at  TIMESTAMP(6)  NOT NULL
)
```

```
VEHICLE_STANDARD_SUPPORT(
  vehicle_id  NUMBER(9)  FK -> VEHICLE,   -- PK (vehicle_id, standard_id)
  standard_id NUMBER(4)  FK -> CONNECTOR_STANDARD
)
-- resolves multivalued attribute supported_standards
```

### Stations and hardware

```
CONNECTOR_STANDARD(
  standard_id    NUMBER(4)     PK,
  code           VARCHAR2(16)  NOT NULL UNIQUE,   -- 'TYPE2','CCS2','BHARAT_AC001','BHARAT_DC001','CHADEMO'
  display_name   VARCHAR2(60)  NOT NULL,
  max_typical_kw NUMBER(6,1)
)
```

```
STATION(
  station_id   NUMBER(9)      PK,
  name         VARCHAR2(120)  NOT NULL,
  latitude     NUMBER(9,6)    NOT NULL CHECK (latitude BETWEEN 6 AND 37),      -- India bounds
  longitude    NUMBER(9,6)    NOT NULL CHECK (longitude BETWEEN 68 AND 98),
  address_line VARCHAR2(200)  NOT NULL,
  city         VARCHAR2(80)   NOT NULL,
  state        VARCHAR2(80)   NOT NULL,
  pincode      VARCHAR2(10),
  status       VARCHAR2(12)   NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  operator_id  NUMBER(9)      NOT NULL FK -> APP_USER(user_id),
  created_at   TIMESTAMP(6)   NOT NULL
)
-- CK candidate: (name, city) is NOT declared unique (two branches may share a name) - documented
```

```
STATION_AMENITY(
  station_id NUMBER(9)    FK -> STATION,   -- PK (station_id, amenity)
  amenity    VARCHAR2(12) NOT NULL CHECK (amenity IN
             ('CAFE','RESTROOM','WIFI','PARKING','SHOP','CANOPY','CCTV'))
)
```

```
CHARGE_POINT(
  cp_id            NUMBER(9)     PK,
  station_id       NUMBER(9)     NOT NULL FK -> STATION(station_id),
  ocpp_identity    VARCHAR2(60)  NOT NULL UNIQUE,     -- OCPP chargeBox identity
  vendor           VARCHAR2(60),
  model            VARCHAR2(60),
  firmware_version VARCHAR2(40),
  status           VARCHAR2(10)  NOT NULL DEFAULT 'OFFLINE'
                   CHECK (status IN ('ONLINE','OFFLINE','FAULTED')),
  last_boot_at     TIMESTAMP(6),
  created_at       TIMESTAMP(6)  NOT NULL
)
```

```
CONNECTOR(
  cp_id                NUMBER(9)    FK -> CHARGE_POINT(cp_id),   -- identifying
  connector_no         NUMBER(2)    NOT NULL CHECK (connector_no BETWEEN 1 AND 8),
  -- PK (cp_id, connector_no)
  standard_id          NUMBER(4)    NOT NULL FK -> CONNECTOR_STANDARD(standard_id),
  max_power_kw         NUMBER(6,2)  NOT NULL CHECK (max_power_kw BETWEEN 3 AND 400),
  status               VARCHAR2(12) NOT NULL DEFAULT 'OFFLINE'
                       FK -> CONNECTOR_STATE(state_code),
  last_state_change_at TIMESTAMP(6),
  created_at           TIMESTAMP(6) NOT NULL
)
-- weak entity: logical key (cp_id, connector_no)
```

### Tariffs

```
TARIFF_PLAN(
  plan_id            NUMBER(9)     PK,
  group_id           NUMBER(9)     NOT NULL,           -- tariff identity across versions
  version_no         NUMBER(3)     NOT NULL,
  -- UNIQUE (group_id, version_no)
  name               VARCHAR2(80)  NOT NULL,
  currency           CHAR(3)       NOT NULL DEFAULT 'INR',
  session_fee        NUMBER(8,2)   CHECK (session_fee >= 0),       -- nullable = no fee
  idle_fee_per_30min NUMBER(8,2)   CHECK (idle_fee_per_30min >= 0),
  active_from        TIMESTAMP(6)  NOT NULL,
  active_to          TIMESTAMP(6),                                     -- NULL = current
  supersedes_plan_id NUMBER(9)     FK -> TARIFF_PLAN(plan_id),
  created_by         NUMBER(9)     NOT NULL FK -> APP_USER(user_id)
)
```

```
TARIFF_BAND(
  band_id       NUMBER(9)     PK,
  plan_id       NUMBER(9)     NOT NULL FK -> TARIFF_PLAN(plan_id),
  day_scope     VARCHAR2(8)   NOT NULL CHECK (day_scope IN ('ALL','WEEKDAY','WEEKEND')),
  start_time    TIMESTAMP(0)  NOT NULL,    -- time-of-day, normalized date 01-JAN-2000
  end_time      TIMESTAMP(0)  NOT NULL,
  price_per_kwh NUMBER(8,4)   NOT NULL CHECK (price_per_kwh > 0),
  -- UNIQUE (plan_id, day_scope, start_time)
  -- band non-overlap enforced by TARIFF_PKG (BR-08)
)
```

### Reservations, sessions, metering

```
RESERVATION_STATE(
  state_code  VARCHAR2(12) PK,   -- BOOKED, CONVERTED, COMPLETED, CANCELLED, EXPIRED, NO_SHOW
  description VARCHAR2(80) NOT NULL
)

RESERVATION(
  reservation_id NUMBER(9)    PK,
  connector_id   VARCHAR2(72) NOT NULL,     -- FK -> CONNECTOR; encoded 'cp_id:connector_no'
                                            -- (composite-FK alternative noted in 10.3)
  user_id        NUMBER(9)    NOT NULL FK -> APP_USER(user_id),
  vehicle_id     NUMBER(9)    NOT NULL FK -> VEHICLE(vehicle_id),
  start_at       TIMESTAMP(6) NOT NULL,
  end_at         TIMESTAMP(6) NOT NULL,
  status         VARCHAR2(12) NOT NULL FK -> RESERVATION_STATE(state_code),
  created_at     TIMESTAMP(6) NOT NULL,
  cancelled_at   TIMESTAMP(6),
  CHECK (end_at > start_at),
  -- overlap prevention: RESERVATION_PKG + BR-05 (Section 31); Oracle has no exclusion
  -- constraints, so the invariant lives in the package + locking (documented trade-off)
)
```

```
SESSION_STATE(
  state_code  VARCHAR2(12) PK,   -- RESERVED, PREPARING, CHARGING, SUSPENDED, COMPLETED, CANCELLED, FAILED
  description VARCHAR2(80) NOT NULL,
  is_terminal NUMBER(1)    NOT NULL CHECK (is_terminal IN (0,1))
)

CONNECTOR_STATE(
  state_code  VARCHAR2(12) PK,   -- AVAILABLE, OCCUPIED, RESERVED, FAULTED, OFFLINE, UNAVAILABLE
  description VARCHAR2(80) NOT NULL
)

CHARGING_SESSION(
  session_id      NUMBER(12)    PK,
  connector_id    VARCHAR2(72)  NOT NULL FK -> CONNECTOR,
  user_id         NUMBER(9)     NOT NULL FK -> APP_USER(user_id),
  vehicle_id      NUMBER(9)     FK -> VEHICLE(vehicle_id),
  reservation_id  NUMBER(9)     UNIQUE FK -> RESERVATION(reservation_id),   -- 0..1
  tariff_plan_id  NUMBER(9)     NOT NULL FK -> TARIFF_PLAN(plan_id),
  id_tag          VARCHAR2(40)  NOT NULL,
  state           VARCHAR2(12)  NOT NULL FK -> SESSION_STATE(state_code),
  billing_state   VARCHAR2(10)  NOT NULL DEFAULT 'UNBILLED'
                  CHECK (billing_state IN ('UNBILLED','BILLED','FAILED','WAIVED')),
  started_at      TIMESTAMP(6),
  ended_at        TIMESTAMP(6),
  start_meter_kwh NUMBER(10,3)  NOT NULL CHECK (start_meter_kwh >= 0),
  end_meter_kwh   NUMBER(10,3),
  energy_kwh      NUMBER(10,3),             -- derived, frozen by BILLING_PKG (BR-10)
  stop_reason     VARCHAR2(40),
  created_at      TIMESTAMP(6)  NOT NULL,
  CHECK (end_meter_kwh IS NULL OR end_meter_kwh >= start_meter_kwh)
)
```

```
METER_READING(
  session_id NUMBER(12)    FK -> CHARGING_SESSION(session_id),   -- identifying
  seq_no     NUMBER(9)     NOT NULL,                             -- partial key
  -- PK (session_id, seq_no)
  taken_at   TIMESTAMP(6)  NOT NULL,
  meter_kwh  NUMBER(10,3)  NOT NULL CHECK (meter_kwh >= 0),
  power_kw   NUMBER(8,3),
  voltage_v  NUMBER(8,1),
  current_a  NUMBER(8,2),
  source     VARCHAR2(10)  NOT NULL DEFAULT 'OCPP' CHECK (source IN ('OCPP','SYNTHETIC')),
  ingested_at TIMESTAMP(6) NOT NULL DEFAULT SYSTIMESTAMP
)
```

### Billing

```
INVOICE(
  invoice_id    NUMBER(12)    PK,
  session_id    NUMBER(12)    NOT NULL UNIQUE FK -> CHARGING_SESSION(session_id),  -- 1:1
  tariff_plan_id NUMBER(9)    NOT NULL FK -> TARIFF_PLAN(plan_id),
  issued_at     TIMESTAMP(6)  NOT NULL,
  status        VARCHAR2(8)   NOT NULL CHECK (status IN ('DUE','PAID','FAILED','VOID')),
  total         NUMBER(12,2)  NOT NULL CHECK (total >= 0),   -- derived: sum(lines), frozen
  currency      CHAR(3)       NOT NULL
)

INVOICE_LINE(
  invoice_id  NUMBER(12)    FK -> INVOICE(invoice_id),   -- identifying
  line_no     NUMBER(3)     NOT NULL,                    -- partial key
  -- PK (invoice_id, line_no)
  kind        VARCHAR2(14)  NOT NULL CHECK (kind IN ('ENERGY','SESSION_FEE','IDLE_FEE','TAX','ADJUSTMENT')),
  description VARCHAR2(120) NOT NULL,
  quantity    NUMBER(12,4)  NOT NULL,
  unit        VARCHAR2(12),
  amount      NUMBER(12,2)  NOT NULL CHECK (amount >= 0)
)

PAYMENT(
  payment_id   NUMBER(12)    PK,
  invoice_id   NUMBER(12)    NOT NULL FK -> INVOICE(invoice_id),
  amount       NUMBER(12,2)  NOT NULL CHECK (amount > 0),
  method       VARCHAR2(10)  NOT NULL DEFAULT 'WALLET' CHECK (method IN ('WALLET')),  -- CARD_PAYMENT future
  status       VARCHAR2(8)   NOT NULL CHECK (status IN ('SUCCESS','FAILED')),
  attempted_at TIMESTAMP(6)  NOT NULL,
  reference    VARCHAR2(60)
)
```

### Operations, feedback, platform

```
FAULT(
  fault_id    NUMBER(9)     PK,
  connector_id VARCHAR2(72) FK -> CONNECTOR,
  cp_id       NUMBER(9)     FK -> CHARGE_POINT(cp_id),
  code        VARCHAR2(40)  NOT NULL,             -- OCPP StatusNotification error code or manual
  severity    VARCHAR2(8)   NOT NULL CHECK (severity IN ('INFO','WARN','CRITICAL')),
  source      VARCHAR2(8)   NOT NULL CHECK (source IN ('OCPP','MANUAL')),
  reported_at TIMESTAMP(6)  NOT NULL,
  cleared_at  TIMESTAMP(6),
  note        VARCHAR2(400),
  CHECK ( (connector_id IS NOT NULL AND cp_id IS NULL) OR (connector_id IS NULL AND cp_id IS NOT NULL) )
)

MAINTENANCE_RECORD(
  maint_id     NUMBER(9)     PK,
  connector_id VARCHAR2(72)  FK -> CONNECTOR,
  fault_id     NUMBER(9)     UNIQUE FK -> FAULT(fault_id),   -- 1:0..1
  type         VARCHAR2(14)  NOT NULL CHECK (type IN ('INSPECTION','REPAIR','REPLACEMENT')),
  description  VARCHAR2(400) NOT NULL,
  parts_cost   NUMBER(10,2)  CHECK (parts_cost >= 0),
  performed_by NUMBER(9)     NOT NULL FK -> APP_USER(user_id),
  started_at   TIMESTAMP(6)  NOT NULL,
  ended_at     TIMESTAMP(6),
  outcome      VARCHAR2(400)
)

REVIEW(
  review_id  NUMBER(9)    PK,
  session_id NUMBER(12)   NOT NULL UNIQUE FK -> CHARGING_SESSION(session_id),   -- CK: session_id
  user_id    NUMBER(9)    NOT NULL FK -> APP_USER(user_id),
  rating     NUMBER(1)    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    VARCHAR2(500),
  created_at TIMESTAMP(6) NOT NULL
)

NOTIFICATION(
  notification_id NUMBER(10)   PK,
  user_id         NUMBER(9)    NOT NULL FK -> APP_USER(user_id),
  kind            VARCHAR2(30) NOT NULL,
  payload         CLOB         NOT NULL CHECK (payload IS JSON),
  read_at         TIMESTAMP(6),
  created_at      TIMESTAMP(6) NOT NULL
)

AUDIT_LOG(
  audit_id      NUMBER(14)    PK,
  actor_user_id NUMBER(9)     FK -> APP_USER(user_id),      -- NULL = system/OCPP
  entity_name   VARCHAR2(40)  NOT NULL,
  entity_pk     VARCHAR2(72)  NOT NULL,
  action        VARCHAR2(20)  NOT NULL,
  old_values    CLOB          CHECK (old_values IS JSON OR old_values IS NULL),
  new_values    CLOB          CHECK (new_values IS JSON OR new_values IS NULL),
  occurred_at   TIMESTAMP(6)  NOT NULL DEFAULT SYSTIMESTAMP
)

OUTBOX_EVENT(
  event_id     NUMBER(16)   PK,
  kind         VARCHAR2(20) NOT NULL CHECK (kind IN ('METER_TICK','CONNECTOR_STATE','SESSION_EVENT')),
  payload      CLOB         NOT NULL CHECK (payload IS JSON),
  created_at   TIMESTAMP(6) NOT NULL DEFAULT SYSTIMESTAMP,
  processed_at TIMESTAMP(6)
)
```

---

## 10.3 Mapping decisions (ER pattern → relational pattern)

| ER construct | Mapped to | Why |
|---|---|---|
| Strong entity | table + surrogate PK + declared CK | surrogate keys avoid composite-FK cascades in URLs and child tables |
| Weak entity (CONNECTOR, METER_READING, INVOICE_LINE, WALLET_LEDGER) | composite PK (parent FK + partial key) | preserves identification dependency; surrogate dropped deliberately on these four |
| 1:1 (INVOICE-SESSION) | FK + UNIQUE | UNIQUE on FK enforces the "one" side |
| 1:1 partial (WALLET_ACCOUNT-USER) | FK as PK of child | child existence-dependent |
| M:N with attributes (reservations, sessions) | associative table with own PK | attributes need a home; own PK simplifies child FKs |
| Multivalued attribute | new relation with composite PK | the 1NF-safe form |
| Disjoint total specialization (USER) | single table + role CHECK | discriminator is a key, not a fact; avoids 2 joins per auth (Section 9.4) |
| Partial specialization (PAYMENT) | single table + method CHECK + extension note | no speculative CARD_PAYMENT table |
| Composite FK for CONNECTOR children | encoded `connector_id` VARCHAR2('cp:no') + FK | Oracle supports composite FKs, but an encoded single-column key keeps child tables (reservation, session, fault, telemetry outbox) uniform; trade-off documented, uniqueness still guaranteed by the parent's composite PK |
| Derived attributes | computed at read OR frozen at transition by owning package | Section 12.6 |

## 10.4 Candidate keys summary

| Table | Candidate keys | Chosen PK | Note |
|---|---|---|---|
| APP_USER | {email}, {user_id} | user_id | email kept UNIQUE |
| CONNECTOR | {cp_id, connector_no}, {connector_id encoded} | (cp_id, connector_no) | encoded column is the FK handle |
| TARIFF_PLAN | {group_id, version_no}, {plan_id} | plan_id | version pair UNIQUE |
| REVIEW | {session_id}, {review_id} | review_id | session_id UNIQUE enforces one-review rule |
| CHARGING_SESSION | {session_id}, {reservation_id} (partial) | session_id | reservation_id UNIQUE |
| WALLET_LEDGER | {user_id, seq_no}, {payment_id} (partial) | (user_id, seq_no) | payment_id UNIQUE-nullable |
| STATION | {user-chosen name+city}? rejected | station_id | names are not reliable identifiers (documented) |

## 10.5 Index plan (beyond PKs/UNIQUEs)

| Index | Table (columns) | Serves |
|---|---|---|
| IX_SESSION_USER_TIME | CHARGING_SESSION(user_id, started_at DESC) | driver history (FR-DRV-03) |
| IX_SESSION_CONN_STATE | CHARGING_SESSION(connector_id, state) | active-session lookups |
| IX_SESSION_STARTED | CHARGING_SESSION(started_at) | time-window analytics |
| IX_RES_CONN_START | RESERVATION(connector_id, start_at) | overlap check query |
| IX_RES_USER | RESERVATION(user_id, status) | "my bookings" |
| IX_READING_TAKEN | METER_READING(taken_at) | time-range scans (also DA3 pre-filter) |
| IX_FAULT_CONN_OPEN | FAULT(connector_id, cleared_at) | open-fault feed |
| IX_STATION_GEO | STATION(city, status) | search prefilter; true geo via bounding-box predicate on lat/lng |
| IX_OUTBOX_UNPROCESSED | OUTBOX_EVENT(processed_at, created_at) | relay cursor |
| IX_INVOICE_STATUS | INVOICE(status, issued_at) | "due invoices" worklist |

Rationale: every index maps to a named query in Section 17 — no speculative indexes. Composite orderings follow the equality-then-range rule (e.g., `connector_id` equality before `start_at` range).
