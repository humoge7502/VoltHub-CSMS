# Part VI — Functional Dependencies, Normalization, and BCNF

> Masterplan sections 11–12. This part does not _claim_ the schema is normalized; it _proves_ it for the non-trivial relations and demonstrates the decompositions that produced it. Four worked examples use deliberately naive "first draft" EV relations of the kind students actually write, and normalize them into the final schema.

---

## 11. Functional Dependencies

### 11.1 Method

For each relation we list: the meaningful FDs, then derive the candidate keys (attribute closure), then state the highest normal form and why. FDs come from business rules (Section 9.5), not from data samples — a data sample can never prove an FD, only falsify one (a point worth saying out loud in the viva).

### 11.2 FDs for the core relations

**CHARGING_SESSION** — `session_id` single-attribute key. FDs: `session_id -> {connector_id, user_id, vehicle_id, reservation_id, tariff_plan_id, id_tag, state, billing_state, started_at, ended_at, start_meter_kwh, end_meter_kwh, energy_kwh, stop_reason}`; `reservation_id -> session_id` (UNIQUE, partial: only for converted reservations); `session_id -> energy_kwh` is _derived_ (meter delta) and stored by BILLING_PKG at the freeze point. Candidate key: {session_id} (verify: closure of session_id covers all attributes — yes). Second CK: {reservation_id} on the subset of rows where it is non-null (partial key — documented). Since every nontrivial FD has a superkey determinant (session_id), **CHARGING_SESSION is in BCNF trivially**.

**METER_READING(session_id, seq_no)** — FDs: `{session_id, seq_no} -> {taken_at, meter_kwh, power_kw, voltage_v, current_a, source, ingested_at}`. Also `seq_no` alone determines nothing (readings from different sessions collide). CK: {(session_id, seq_no)}. No partial dependencies (nothing depends on seq_no alone) → **2NF; no transitive deps among non-key attrs (source/taken_at do not determine meter values) → 3NF; single CK with all FDs from the whole key → BCNF**.

**CONNECTOR(cp_id, connector_no)** — FDs: `{cp_id, connector_no} -> {standard_id, max_power_kw, status, last_state_change_at, created_at}`; `{cp_id, connector_no} -> connector_id` (the encoded handle); `connector_id -> {cp_id, connector_no}` (bijective). Two CKs: {(cp_id, connector_no)} and {connector_id}. Every determinant is a superkey → **BCNF despite two candidate keys** — the exact situation where students often wrongly cry "not BCNF".

**TARIFF_BAND(band_id, plan_id, day_scope, start_time, end_time, price_per_kwh)** — FDs: `band_id -> all`; `{plan_id, day_scope, start_time} -> {band_id, end_time, price_per_kwh}` (the business key identifies the band). CKs: {band_id}, {plan_id, day_scope, start_time}. Both determinants are superkeys → **BCNF**. Non-overlap of intervals is _not_ an FD — it is a temporal constraint (BR-08), which FDs cannot express; it is enforced procedurally. Being able to say "this invariant is beyond FDs, so it lives in the package" is exactly the kind of precision BCNF grading rewards.

**APP_USER** — `user_id -> all`; `email -> all` (email is a natural key: it determines the person's record). CKs: {user_id}, {email}. Both superkeys → **BCNF**.

**RESERVATION** — `reservation_id -> all`; no other determinants (start_at/end_at do not determine status: the same window can be booked, cancelled, or converted). CK: {reservation_id} → **BCNF**. The _interesting_ constraint (no two overlapping windows per connector) is again non-FD, handled in Section 31.

**INVOICE / INVOICE_LINE / PAYMENT / WALLET_LEDGER / FAULT / MAINTENANCE_RECORD / REVIEW / NOTIFICATION / AUDIT_LOG / OUTBOX_EVENT** — each has a single-attribute surrogate key (or a whole-key composite for the identifying pairs) and no nontrivial FDs beyond key -> attributes. All are **BCNF trivially**; the interesting analyses are the four worked examples below.

---

## 12. Normalization and BCNF — worked proofs

### 12.1 Example 1 — 1NF violation: multivalued attributes as lists

Naive draft (as students actually write it):

```
VEHICLE_FLAT(vehicle_id, make, model, battery_kwh, supported_standards, amenities_of_home_station)
V1 | Tata | Nexon EV | 40.5 | "TYPE2,CCS2" | ...
```

`supported_standards = "TYPE2,CCS2"` is a repeating group inside one column. 1NF requires atomic values: queries like "find vehicles supporting CCS2" need substring matching (`LIKE '%CCS2%'`), which is wrong the moment a standard named "CCS2x" appears, and the DBMS cannot enforce referential integrity on a CSV.

**Decomposition (lossless, dependency-preserving):**

```
VEHICLE(vehicle_id, make, model, battery_kwh)
VEHICLE_STANDARD(vehicle_id, standard_id)   -- FK to CONNECTOR_STANDARD
```

This is exactly E24 in the final schema. The same argument applies to `STATION.amenities` -> STATION_AMENITY (E25). **Why not a separate row per standard with a sequence column?** Because the pair (vehicle, standard) is itself all-key — no ordering information exists — which also makes the result trivially **4NF** (the only MVDs are trivial).

### 12.2 Example 2 — 2NF violation: partial dependencies on a composite key

Naive draft of the metering table:

```
READING_FLAT(session_id, seq_no, session_started_at, driver_email, meter_kwh, power_kw)
PK (session_id, seq_no)
```

FDs: `{session_id, seq_no} -> {meter_kwh, power_kw}` (full-key — fine), but also `session_id -> {session_started_at, driver_email}` — **partial dependencies**: non-key attributes determined by _part_ of the key. Consequences: the session start time is repeated once per meter tick (10–40 rows), update anomalies (correct it in one row, not the others), and deletion anomalies (delete the last reading of a session and you lose the session's start time).

**Decomposition:**

```
CHARGING_SESSION(session_id, ..., started_at, driver/user_id, ...)   -- session facts, keyed by session_id
METER_READING(session_id, seq_no, taken_at, meter_kwh, power_kw, ...) -- tick facts, keyed by (session, seq)
```

Lossless: R1 ∩ R2 = {session_id}, and session_id -> R1 (key of R1) — the classic split condition. Dependency-preserving: every FD is enforced inside one fragment. This is exactly the E11/E12 pair in the final schema. **2NF is about the composite key here — an important contrast with Example 3, where the single-attribute key makes 2NF automatic but 3NF is not.**

### 12.3 Example 3 — 3NF violation: transitive dependency in the "one big session table"

Naive draft (the classic "flat report table"):

```
SESSION_FLAT(session_id, connector_id, cp_id, station_name, driver_email, driver_name,
             tariff_name, price_per_kwh, energy_kwh, invoice_total)
```

FDs beyond the key:

```
session_id    -> connector_id, driver_email, tariff_plan_used, ...
connector_id  -> cp_id                    (a connector belongs to one charge point)
cp_id         -> station_name             (a charge point belongs to one station)
driver_email  -> driver_name              (a user's record determines their name)
tariff_plan_used -> tariff_name, price_per_kwh (plan record determines its facts)
session_id    -> invoice_total            (billing determines the total)
```

Transitive chains: `session_id -> connector_id -> cp_id -> station_name` and `session_id -> driver_email -> driver_name`. Every rename of a station or user would need to rewrite thousands of session rows — the update-anomaly argument, concretely.

**3NF decomposition (each non-key attribute moves to the table keyed by its determinant):**

```
CHARGING_SESSION(session_id, connector_id, user_id, tariff_plan_id, energy_kwh, ...)
CHARGE_POINT(cp_id, station_id, ocpp_identity, ...)
STATION(station_id, name, ...)
APP_USER(user_id, email, full_name, ...)         -- email UNIQUE
TARIFF_PLAN(plan_id, name, ...)
TARIFF_BAND(plan_id, day_scope, start_time, end_time, price_per_kwh)
INVOICE(invoice_id, session_id UNIQUE, total, ...)
```

Lossless by construction (each join returns to the original on keys). Note `session_id -> invoice_total` is _not_ an anomaly once INVOICE is 1:1 with session via UNIQUE — the total lives with its own key.

### 12.4 Example 4 — BCNF violation: overlapping candidate keys (the best viva story)

Naive draft of connector numbering "per station" (which sounds reasonable — stations number their sockets 1..n):

```
CONNECTOR_SLOT(station_id, connector_no, cp_id)
-- business rules:
--   (station_id, connector_no) -> cp_id     (socket #2 of station S1 is on exactly one cabinet)
--   cp_id -> station_id                     (a cabinet sits at exactly one station)
```

Candidate keys: {(station_id, connector_no)} and {(cp_id, connector_no)}. Now check BCNF: FD `cp_id -> station_id` has determinant `cp_id`, which is **not a superkey** (it does not determine connector_no) → **BCNF violated** (3NF survives only because station_id is _prime_ — it belongs to a candidate key; this R↔BCNF distinction is the sharpest thing a student can say about normal forms).

Update anomaly: a cabinet physically moved from station S1 to S2 forces rewriting every connector row of that cabinet. Redundancy: station_id is stored once per connector instead of once per cabinet.

**BCNF decomposition:** project out the violating FD:

```
CHARGE_POINT(cp_id PK, station_id NOT NULL)      -- cp_id -> station_id
CONNECTOR(cp_id, connector_no, standard_id, max_power_kw, status, ...)  -- PK (cp_id, connector_no)
```

Lossless check: R1 ∩ R2 = {cp_id}; cp_id -> R1's key → lossless join. Dependency-preservation check: FD1 `(station_id, connector_no) -> cp_id` is **no longer enforceable by a key in any fragment** — it is only implied by the join. This is the textbook BCNF cost, and we accept it _consciously_: the constraint "socket numbering is unique per station" is business decoration, not money-path correctness; the real integrity rules (connector belongs to exactly one cabinet; cabinet belongs to one station; (cp, no) unique) are all key-enforced. **The final schema in Part V is precisely this decomposition** — which is why CONNECTOR's PK is (cp_id, connector_no) and not (station_id, connector_no).

### 12.5 4NF and 5NF — brief honesty

After the decompositions above, no nontrivial multivalued dependencies remain (VEHICLE_STANDARD and STATION_AMENITY are all-key). Join dependencies across three or more relations (5NF) do not arise because no business rule decomposes a fact into three independent projections. We state 4NF/5NF as "checked, trivially satisfied" rather than claiming depth we do not have — interviewers respect the boundary.

### 12.6 Controlled denormalization (where we deliberately stop)

| Denormalization                              | Justification                                                                                               | Guard                                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| WALLET_ACCOUNT.balance (derived from ledger) | O(1) affordability check inside the payment transaction; recompute from ledger would scan history per debit | maintained only inside BILLING_PKG's ledger transaction; ledger is append-only; audit can recompute and reconcile |
| CHARGING_SESSION.energy_kwh (end - start)    | frozen business fact at billing time (BR-10), not a live value                                              | written once by BILLING_PKG when billing_state flips; CHECK end >= start                                          |
| INVOICE.total (sum of lines)                 | invoice is a legal document; its total must not drift if lines were (hypothetically) amended                | written at issue time by BILLING_PKG; lines are insert-only afterwards                                            |
| STATION.available_connector_count            | NOT stored — computed on read via view                                                                      | demonstrates the restraint half of the rule                                                                       |

The principle: **store a derived value only at the instant its precondition is transactionally locked, and say who owns it.** Each row of this table names the owning package — that is the difference between denormalization and carelessness.

### 12.7 Normalization of the temporal dimension (tariff versioning)

Tariffs exhibit temporal FDs: `plan(group_id) -> price` holds _at a time_, not absolutely. The naive design (mutable price column) creates update anomalies across history — changing a price would retroactively alter old invoices' meaning. The version-chain design (TARIFF_PLAN rows immutable, supersedes self-FK, sessions FK to the exact plan_id used) is **row versioning**: the "relation" is effectively `TARIFF(group_id, version_no, ...)` with a temporal key. This is 6NF-thinking (anchor + timeline) applied pragmatically without full 6NF machinery — worth one slide in the DA1 presentation.

### 12.8 Normal-form summary table

| Relation                                    | 1NF          | 2NF       | 3NF             | BCNF                        | Note                                                 |
| ------------------------------------------- | ------------ | --------- | --------------- | --------------------------- | ---------------------------------------------------- |
| VEHICLE + VEHICLE_STANDARD                  | after de-CSV | -         | -               | yes                         | Example 1                                            |
| CHARGING_SESSION + METER_READING            | yes          | Example 2 | Example 3 chain | yes                         | weak-entity split                                    |
| CONNECTOR + CHARGE_POINT                    | yes          | yes       | yes             | via Example 4               | overlapping-CK decomposition                         |
| TARIFF_PLAN + TARIFF_BAND                   | yes          | yes       | yes             | yes (2 CKs, both superkeys) | temporal BR-08 non-FD                                |
| all remaining relations                     | yes          | yes       | yes             | trivially                   | single-key, key -> attrs                             |
| WALLET_ACCOUNT / INVOICE.total / energy_kwh | yes          | yes       | yes             | yes                         | controlled denormalization, owned by packages (12.6) |
