# LinkedIn showcase kit (HARDEN-2026-09)

Posting kit for the VoltHub CSMS portfolio repo — text, assets, and the honest
answers that survive a follow-up DM. **Attachments:** `docs/architecture-hero.png`
(thesis in one image) + `docs/screenshots/demo-live.gif` (motion proof). Screenshot
`dashboard.png`/`invoice.png` make a natural follow-up post a few days later.

## Post body

I built an EV charging management system where the _race demo_ is the shortest
honest proof of the whole architecture:

> Two parallel bookings hit the same connector and the same time window. Exactly
> one returns `201 BOOKED`. The other returns `409 OVERLAP`.

That's Oracle `SELECT … FOR UPDATE` doing its job — money-path logic in PL/SQL
packages, not app code, and CI fires that exact race on every push, against the
in-process store **and** against a real Oracle 23ai container.

Why two databases instead of one?

- **Oracle 23ai** owns the ACID money path: reservations, sessions, billing, a
  wallet ledger, 7 PL/SQL packages, a guard trigger that blocks direct
  `connector.status` writes, least-privilege grants with no DELETE anywhere.
- **TimescaleDB** owns the telemetry path: 90 %+ of rows are immutable,
  time-ordered meter ticks. Hypertables + 1m/1h continuous aggregates +
  compression + retention — plus continuous aggregates taught me their real
  limitation (one hypertable only), so enrichment lives in query-time views and
  the relay keeps a denormalized `station_map`.
- They meet through an **outbox + relay** (in-transaction on the Oracle side,
  `ack-after-COMMIT` + idempotent replay on the worker side) = effectively-once
  delivery. Crash anywhere and replay dedupes.

The OCPP 1.6J gateway speaks WebSocket with per-charger credentials (Security
Profile 1), and the worker/API drain gracefully on SIGTERM — no mid-ack kills
when the compose stack stops.

The details people actually ask about are in the repo, documented as decisions
(`docs/adr/`), receipts (`docs/verification.md`), and honest limits — chargers
are simulated, payments are a prepaid wallet, deployment is single-VM compose.
Here is the repo: <https://github.com/humoge7502/VoltHub-CSMS>

## First comment (reading path)

> For anyone reading the repo: start at the README's 30-second demo, then
> `ARCHITECTURE.md` (one page + diagram), then `docs/adr/` 0001→0007 (each
> decision has a rejected-alternative), then `docker compose up` for the real
> thing. The "why two databases" README section is 4 lines and is the whole
> thesis.

## Pre-written answers (never claim more than this)

**"Is this production?"**
No — and the repo says so in `README.md` → Honest limits. Chargers are simulated
(SteVe precedent), payments are a prepaid wallet with no card data, and the
deployment target is one VM with `docker compose` + Caddy (ADR-0001). What _is_
real: the databases run in CI on every push, the races are executed, and every
receipt in `docs/verification.md` names exactly what ran.

**"Why Oracle, not Postgres?"**
For a _portfolio_, Postgres would be the lazy choice. The interesting constraint
is the money path: row-lock semantics, PL/SQL packages owning write paths, and a
guard trigger — that is where the race safety lives. TimescaleDB covers the
telemetry shape Postgres would handle poorly. Two engines make the store-port
decision (ADR-0005) load-bearing instead of decorative.

**"How do I know the CI isn't theater?"**
`db-tests` boots real Oracle 23ai + TimescaleDB service containers, applies
V001–V006/T001–T002 + seed, and runs the contract/race/security suites against
them. A regression suite for the OCPP stale-socket bug was validated _to catch
the bug_ (reverted fix → red, re-applied → green). `npm audit` is a CI gate on
both lockfiles — currently zero findings.

**"What would you do next?"**
Full-profile benchmarks from `bench/` (methodology in `docs/perf.md`), OCPP
Security Profile 2 TLS per charger, httpOnly refresh cookies, and pacing the
commit graph — a living repo beats a burst.

## Do not claim

Production deployment · real users · uptime · throughput numbers absent from
`docs/perf.md` · OCPP 2.0.1 · card payments · multi-region anything.
