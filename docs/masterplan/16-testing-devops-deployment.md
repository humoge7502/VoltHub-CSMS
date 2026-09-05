# Part XVI — Testing, Docker/DevOps, and Deployment

> Masterplan sections 33–35. Tests are prioritized by *portfolio value per hour written*; DevOps items are labeled MUST/SHOULD/OPTIONAL; deployment stays on free tiers with a demo-day runbook.

---

## 33. Testing

### 33.1 Priorities (the pyramid, re-weighted for a database course)

| Tier | What | Count | Value |
|---|---|---|---|
| 1. DB constraint tests (SQL) | assert CHECKs/UNIQUEs/PKs reject violations; Q25-style invariant queries return zero rows | ~25 | **highest** — this is the course's heart |
| 2. Race/transaction tests (Node + 2 connections) | R1–R8 from Section 31.1 | 8 | highest interview signal |
| 3. API integration tests | supertest against a live Oracle+schema: auth, reservation flow, billing flow | ~30 | high |
| 4. Package unit tests | resolve_band_price edge cases (midnight boundary, weekend, no-band) via PL/SQL unit harness | ~15 | high for viva |
| 5. Frontend component tests | Vitest + Testing Library: connector tile states, form validation | ~10 | medium |
| 6. E2E happy path | Playwright: register → reserve → simulate session → pay | 2–3 | demo insurance |
| 7. Load smoke | k6: 50 VUs on discovery endpoint; simulator ingest 10-min soak | 2 | honest numbers for perf.md |
| 8. Security checks | lint rules, dependency audit, headers probe | CI steps | cheap |

Explicitly **not** built (and why, in the docs): mutation testing, visual regression, chaos engineering — effort outruns signal at this scale.

### 33.2 Signature tests (the ones to talk about)

```ts
// test/races/r1-double-reservation.spec.ts (abridged)
it('rejects the second of two concurrent reservations', async () => {
  const window = { cpId: 17, connectorNo: 2, startAt: t(+26), endAt: t(+86) };
  const [a, b] = await Promise.allSettled([
    api.createReservation(userA, window),      // separate pools/connections
    api.createReservation(userB, window),
  ]);
  expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
  expect(countReservations(window)).toBe(1);   // and Q25 returns zero rows
});
```

```sql
-- test/sql/invariants.sql: run after every seed & migration
-- invariant: no overlapping reservations (Q25)
-- invariant: wallet ledger reconciles (Q19)
-- invariant: no BILLED session without COMPLETED state
SELECT COUNT(*) FROM charging_session
WHERE billing_state <> 'UNBILLED' AND state <> 'COMPLETED';  -- must be 0
-- invariant: every PAID invoice total = sum(lines)
SELECT i.invoice_id FROM invoice i
WHERE i.status = 'PAID'
  AND i.total <> (SELECT SUM(amount) FROM invoice_line l WHERE l.invoice_id = i.invoice_id);
```

CI fails red if any invariant query returns a row — "the database tests itself" is a sentence worth rehearsing.

---

## 34. Docker / DevOps

### 34.1 Labeled decisions

| Item | Label | Choice |
|---|---|---|
| Docker Compose (oracle-free, timescaledb, api, worker, web) | **MUST** | one `docker compose up` = full seeded system (NFR-08) |
| Versioned SQL migrations (oracle + timescale, runner script) | **MUST** | `db/oracle/V001..V0NN`, `db/timescale/T001..` — applied in order, recorded in `schema_migrations` |
| Seed scripts with fixed RNG seed | **MUST** | Section 16 |
| GitHub Actions CI (lint, typecheck, unit, DB tests on service containers) | **MUST** | green badge on README |
| Health checks (compose + `/health`) | **MUST** | depends_on conditions gate app start |
| Structured JSON logs w/ request IDs | **SHOULD** | pino (18.6) |
| OpenAPI docs route | **SHOULD** | /docs from decorators |
| Image build + GHCR push in CI | **SHOULD** | `docker compose pull` deploy path |
| k6 soak script | **SHOULD** | feeds perf.md |
| Grafana sidecar over Timescale | **OPTIONAL** | 1-hour add, big visual payoff |
| Kubernetes / Terraform / vault | **REJECT** | Section 45 |

### 34.2 Compose topology (the file's shape)

```yaml
services:
  oracle:   { image: gvenzl/oracle-free:23-slim, ports: ["1521:1521"],
              env: [ORACLE_PWD, APP_USER, APP_USER_PASSWORD],
              healthcheck: { test: ["CMD-SHELL", "healthcheck.sh"], interval: 10s,
                             retries: 30 } }
  timescale:{ image: timescale/timescaledb:latest-pg16, ports: ["5432:5432"],
              healthcheck: { test: ["CMD-SHELL", "pg_isready -U volthub"] } }
  api:      { build: apps/api, depends_on: {oracle: {condition: service_healthy},
                                            timescale: {condition: service_healthy}} }
  worker:   { build: apps/worker, depends_on: [api] }
  web:      { build: apps/web, ports: ["3000:3000"], depends_on: [api] }
```

### 34.3 CI pipeline (GitHub Actions, single workflow)

```
jobs:
  quality:  pnpm lint && pnpm typecheck && pnpm unit
  db-tests: services: [oracle, timescale] -> migrate -> seed(sample) ->
            pnpm test:sql && pnpm test:races && pnpm test:api
  e2e:      needs db-tests -> compose up -> pnpm test:e2e (Playwright)
  images:   needs quality -> build/push GHCR on main
```

---

## 35. Deployment

### 35.1 Environments

| Env | Purpose | Shape |
|---|---|---|
| dev | daily work | compose on laptop |
| ci | PR verification | service containers in Actions |
| demo | the public portfolio link | **one** cheap VM or free-tier PaaS hosting: web on Vercel/Netlify (Next), api+worker on a small VM (Fly.io/Railway/OCI Always-Free), databases as Docker on the same VM with a nightly `pg_dump`-equivalent + Oracle Data Pump export |

Oracle hosting reality-check: the free path for Oracle is self-hosting on the demo VM (oracle-free container) — honest, zero-cost, and it keeps Oracle native features intact; Oracle Cloud Always-Free Autonomous DB is a documented alternative with its wallet/ACL quirks noted.

### 35.2 Operations a 3-person team actually does

Nightly backups (cron: Oracle Data Pump export + `pg_dump` to object storage with 7-day rotation); uptime monitor (UptimeRobot pinging `/health`); log tail via `docker logs` + pino file rotation; **restore drill rehearsed once** (a bullet on the README: "backup restore tested on <date>" separates professionals from tourists).

### 35.3 Demo-day runbook (compressed)

`T-30min`: compose up on demo laptop + cloud demo already warm; seed `--profile demo` (deterministic). `T-10`: run `test:race` live (green CI on screen). `T-0`: follow the Section 38 storyline. Fallbacks: recorded demo GIF set + `docs/demo-script.md` printed; if Wi-Fi dies, localhost runs everything (compose was the point all along).
