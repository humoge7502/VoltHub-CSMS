# VoltHub CSMS

**Two-engine EV charging management: Oracle for ACID billing/reservations, TimescaleDB for telemetry — driven by an OCPP 1.6J simulator, race-proof core, typography-led Next.js dashboard.**

![ci](https://github.com/humoge7502/VoltHub-CSMS/actions/workflows/ci.yml/badge.svg) `oracle-23ai` `timescaledb` `modular-monolith-express` `ocpp-1.6j` `nextjs`

> 30-second GIF: two terminals reserve the same connector → one `201 BOOKED`, one `409 OVERLAP` → plug-in → live kWh/kW/cost → itemized invoice → wallet pay. (Record with `scripts/demo.sh`.)

## Why two databases (4 lines)

- Sessions/billing are ACID-relational (money-path, overlap exclusion, ledger) → **Oracle 23ai**.
- 90%+ of rows are immutable time-ordered meter ticks read as window aggregates → wrong shape for a row-store → **TimescaleDB** hypertables + continuous aggregates + compression + retention.
- Same event, two resolutions: every `MeterValues` writes `METER_READING` (billing record, Oracle) + `meter_tick` (analytics record, Timescale) via an **outbox + relay** (at-least-once, idempotent replay = effectively-once).
- Diagram: `diagrams/system-architecture.mmd`.

## Screenshots

| Health grid | Live session | Load curve | Invoice |
|---|---|---|---|
| `apps/web/src/app/dashboard/page.js` | `apps/web/src/app/session/[id]/page.js` | `apps/web/src/app/telemetry/page.js` | `apps/web/src/app/invoices/page.js` |

Run it and click through — every number below is reproducible on a laptop.

## DB highlights (show me)

- **BCNF-honest model + 2 justified denormalizations** → `db/oracle/V001__core_schema.sql`, proofs in `docs/masterplan/06-normalization-bcnf.md`.
- **Race-proof reservations** (`SELECT … FOR UPDATE` + overlap check, ORA-20503 → 409) → `db/oracle/V003__packages.sql` (`RESERVATION_PKG`), live demo `npm run test:race -w apps/api`.
- **Money in packages, not app code** (`BILLING_PKG.bill_session/pay_invoice`, `CHARGE_SESSION_PKG` state machine, 2 triggers only) → `db/oracle/V003__packages.sql`, `V004__triggers_grants.sql`.
- **Outbox → hypertables → 1m/1h caggs** → `db/timescale/T001__hypertables.sql`, `T002__caggs.sql`, relay `apps/worker/src/index.js`.
- **26-query portfolio + invariants that gate CI (0 rows = pass)** → `db/oracle/queries.sql`, `db/oracle/invariants.sql`, `test/sql/run-invariants.js`, `db/timescale/queries.sql`.

## Honest limits (NFR-11)

- Local profile runs on an in-process store (no DB) for fast iteration; set `ORACLE_HOST`/
  `TS_HOST` (full compose profile) for the durable two-engine path — see `apps/api/src/db/index.js`.
- Chargers are **simulated** (SteVe precedent); payments are a **prepaid wallet** (no card data, ever); single-VM Compose, not K8s.
- No performance numbers are claimed here — see `docs/perf.md` (methodology + reproduce steps; measured tables land after the benchmark suite runs).

## Quickstart

```bash
# 1) local, no Docker: API :4000 + web :3000
npm install
npm run dev:api &                      # seeded demo data, /api/v1/health
cd apps/web && npm install && npm run dev

# 2) full stack (Oracle + TimescaleDB containers)
docker compose -f infra/docker-compose.yml up --build

# 3) races + tests
npm run test -w apps/api && npm run test:race -w apps/api
node apps/simulator/src/index.js --scenario race   # expect 201+409
```

Demo logins: `admin@volthub.in` / `Admin@123` · `arjun@volthub.in` / `Operator@123` · any seeded driver / `Driver@123`.

## Docs map

Masterplan (DA1→DA2→DA3): docs/masterplan/ + polished PDF docs/VoltHub-CSMS-Engineering-Masterplan.pdf · ADRs: `docs/adr/` · perf: `docs/perf.md` · demo beats: `docs/demo-script.md`.

## License

MIT.
