# Career Kit — Resume Bullets, Pitch, and Interview Soundbites

## 1. Resume bullets (pick 3–5; keep numbers honest and reproducible)

- Designed and built **VoltHub**, a two-engine EV charging station management system: **Oracle 23ai** as the ACID system of record (25 relations, 6 PL/SQL packages) and **TimescaleDB** for charger telemetry analytics (hypertables, continuous aggregates, 10x+ compression).
- Implemented a **race-condition-proof reservation core** using row-level locking inside PL/SQL packages; proved it with automated concurrency tests (two parallel bookings, exactly one succeeds) wired into CI.
- Built an **OCPP 1.6J charger simulator and WebSocket gateway** (BootNotification → StatusNotification → Authorize → StartTransaction → MeterValues → StopTransaction) that drives the database end-to-end like real hardware.
- Modeled **versioned time-of-use tariffs** and itemized invoicing entirely in Oracle (immutable plan versions, band lookups, double-entry wallet ledger with reconciliation invariants).
- Delivered an **outbox-based Oracle→TimescaleDB pipeline** with at-least-once delivery and idempotent sink loads; demonstrated crash-safe replay with zero duplicate ticks.
- Wrote a **SQL invariant test suite** (overlapping reservations, ledger reconciliation, billing completeness) that runs in GitHub Actions against live service containers.
- Designed **Grid Current**, a typography-led dark design system (Space Grotesk / IBM Plex Mono tabular numerals), and shipped a data-dense operator dashboard with live load curves and utilization heatmaps.

## 2. The 30-second pitch

> "I built a charging-station management system around a database argument: billing and reservations need ACID, meter telemetry needs time-series storage — so it uses Oracle for the money path and TimescaleDB for analytics, connected by an outbox pipeline. Every correctness claim is enforced _in the database_ — locking packages, constraints, triggers — and proven by tests that run in CI, including two concurrent bookings racing for the same charger. A simulator speaks real OCPP so the data behaves like a charging network, and the dashboard is a custom design system, not a template."

## 3. Interview soundbites (memorize the shape, not the words)

**"Why two databases?"** → "Different workloads want different mechanics. Our telemetry is 90% of rows, append-only, time-windowed; Oracle Free can't partition or incrementally refresh MVs, TimescaleDB chunks time and maintains aggregates incrementally. The industry literature describes exactly this split for charging platforms."

**"App logic vs database logic?"** → "Invariants that money depends on live next to the data: PL/SQL packages with grant-enforced ownership, so even a compromised API can't rewrite history. Orchestration lives in the app. It's a layering decision, not nostalgia."

**"Most interesting bug you prevented?"** → "The reservation TOCTOU race: two overlap checks pass, both insert. One `FOR UPDATE` on the connector row serializes writers per charger; the second transaction re-checks after the first commits. We test it with two parallel HTTP calls in CI."

**"What would you build next?"** → "Read-partitioned history tables, CDC instead of the outbox for lower latency, and usage-based cache decisions once we have real miss rates — each has a measurable trigger written in the docs."

## 4. LinkedIn/GitHub headline options

- "Building VoltHub — an EV charging platform where correctness lives in the database."
- "Oracle for ACID, TimescaleDB for telemetry, OCPP for truth: a two-engine CSMS."
- GitHub repo topics: `oracle`, `plsql`, `timescaledb`, `ocpp`, `nestjs`, `nextjs`, `csms`, `time-series`, `database-design`, `bcnf`
