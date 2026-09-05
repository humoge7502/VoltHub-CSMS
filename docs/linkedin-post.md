# LinkedIn showcase kit (v1.3.0 refresh)

Posting kit for the VoltHub CSMS portfolio repo — three posts, assets, and the
honest answers that survive a follow-up DM. **Attachments for post 1:**
`docs/architecture-hero.png` (thesis in one image) + `docs/screenshots/demo-live.gif`
(motion proof). **New in this kit:** `docs/social-preview.png` doubles as a
16:8 card, and the fresh `docs/readme-header.png` works as a banner crop.
Screenshot `dashboard.png`/`invoice.png` make a natural follow-up post a few
days later.

**Cadence that works:** Post 1 (launch, Tue–Thu 8–10 am IST) → Post 2 (deep-dive,
+3–4 days) → Post 3 (CI receipts, +3–4 days). Reply to every comment inside the
first 90 minutes; the algorithm and the recruiters both watch that window.

---

## Post 1 — Launch (the race is the proof)

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
v1.3.0 adds line coverage to the 6-job pipeline (c8 → Codecov — informational,
because badges are receipts, not targets).

Here is the repo: <https://github.com/humoge7502/VoltHub-CSMS>

**First comment (reading path):**

> For anyone reading the repo: start at the README's 30-second demo, then
> `ARCHITECTURE.md` (one page + diagram), then `docs/adr/` 0001→0007 (each
> decision has a rejected-alternative), then `docker compose up` for the real
> thing. The "why two databases" README section is 4 lines and is the whole
> thesis.

---

## Post 2 — Deep-dive (the store-port is load-bearing)

The second post goes one level down, for the engineers watching:

> Everyone asks "why two databases?" The better question is: what breaks if the
> answer is wrong?

Three decisions that make the architecture more than a diagram:

1. **One store port, two engines** (ADR-0005). The API talks to a store
   interface; Oracle and the in-process store are interchangeable behind it.
   That's why the race suite runs the same scenarios against mutex semantics
   _and_ real row locks — engine parity is a test target, not a hope.
2. **The outbox is in the same transaction as billing** (ADR-0003). No dual-write
   window: a paid invoice and its telemetry event commit together or not at all.
   The relay's ack-after-COMMIT + `ON CONFLICT DO NOTHING` replay closes the
   remaining at-least-once gap to effectively-once.
3. **Continuous aggregates taught me their limit** — one hypertable per cagg.
   The fix shaped the whole telemetry design: join-free caggs, enrichment in
   query-time views, station metadata denormalized by the worker into
   `station_map`.

Trade-offs I accepted, stated plainly: single-writer relay (not a fan-out bus),
single-VM compose (not Kubernetes), simulated chargers (SteVe precedent). The
rejected alternatives are written down in `docs/adr/` — that's the part I'd
want a reviewer to attack.

Repo: <https://github.com/humoge7502/VoltHub-CSMS>
(`ARCHITECTURE.md` is the one-pager; the diagram in the comments is the
6-job pipeline.)

**Attachment:** `docs/architecture-hero.png`.

---

## Post 3 — "CI isn't theater" (receipts, incl. coverage)

> A green badge proves nothing. A pipeline that re-proves your claims on every
> push proves everything.

What actually runs on every push to `main` (6 jobs):

- **lint** on Node 20 _and_ 22 — eslint 10 flat config, `--max-warnings 0`, plus
  prettier (the stricter gate caught two latent issues the day it landed)
- **security** — `npm audit` gates on both lockfiles; zero known CVEs, and the
  job stays red if that changes
- **quality** — contract + race + security + cross-layer suites in-process
- **coverage** — c8 V8 instrumentation over the unit-tier suites, published to
  Codecov. Informational by policy: the badge is a receipt, not a target — the
  race suites are the gate.
- **db-tests** — real Oracle 23ai + TimescaleDB service containers; migrations
  V001–V006 + T001–T002 applied; the same suites re-run with `STORE=oracle`;
  11 SQL invariants assert 0 rows or red
- **e2e** — full compose: stack boots, worker relays, health/docs/metrics
  asserted, `station_map` verified populated

The discipline that made this valuable: when a bug escaped (stale OCPP socket
deregistered its live successor), the fix landed together with a regression
suite that was proven to catch it — reverted fix → red, re-applied → green.
`docs/verification.md` names what ran for every claim in the README.

Repo: <https://github.com/humoge7502/VoltHub-CSMS>
What would you gate your CI on that this pipeline still doesn't? (Genuine
question — the roadmap in `ARCHITECTURE.md` already lists OCPP Security
Profile 2 and httpOnly refresh cookies.)

---

## Pre-written answers (never claim more than this)

**"Is this production?"**
No — and the repo says so in `README.md` → Honest limits. Chargers are simulated
(SteVe precedent), payments are a prepaid wallet with no card data, and the
deployment target is one VM with `docker compose` + Caddy (ADR-0001). What _is_
real: the databases run in CI on every push, the races are executed, coverage is
published, and every receipt in `docs/verification.md` names exactly what ran.

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
both lockfiles — currently zero findings. Coverage is published to Codecov from
the same suites, informationally.

**"What would you do next?"**
Full-profile benchmarks from `bench/` (methodology in `docs/perf.md`), OCPP
Security Profile 2 TLS per charger, httpOnly refresh cookies, and pacing the
commit graph — a living repo beats a burst.

## Do not claim

Production deployment · real users · uptime · throughput numbers absent from
`docs/perf.md` · OCPP 2.0.1 · card payments · multi-region anything.

## Posting checklist

- [ ] Repo is green on `main` (CI badge + Codecov badge live) before post 1
- [ ] GitHub About line + topics set (see PACK-README) — the link preview is what people tap
- [ ] Social preview uploaded (Settings → Social preview) so link cards show the new palette
- [ ] Post 1 attaches `architecture-hero.png` + `demo-live.gif` (GIF first in the carousel)
- [ ] First comment posted within 1 minute (reading path)
- [ ] Pin the comment; reply to every question in the first 90 minutes
- [ ] Profile README (humoge7502/humoge7502) refreshed to the same palette before posting
- [ ] Post 2 drops the architecture-hero image; Post 3 screenshots the Actions run page (real logs)
- [ ] Featured section on LinkedIn profile: pin post 1 + the repo link
