# Contributing

Short version: **conventional commits, CI green, evidence over claims.** This
document is the long version — the repo's whole review culture in one page.

VoltHub is a portfolio-grade CSMS, which means two things for contributors.
First, the bar for "done" is unusually explicit: every behaviour change carries a
test that would fail without it, and every claim in the docs names the receipt
that proves it. Second, the honest-limits section of the README is load-bearing:
PRs that add "production-ready" flair (retries without idempotency keys, card
payments, a Kubernetes chart nobody runs) will be asked to either carry the
operations evidence or wait. Neither rule is about process for its own sake —
both exist because audits B2G/B3G/HARDEN each caught real bugs that a looser
bar would have shipped.

## Project layout (60-second map)

| Path                     | What lives there                                                             |
| ------------------------ | ---------------------------------------------------------------------------- |
| `apps/api`               | Express 5 API + OCPP 1.6J WebSocket gateway, one port :4000                  |
| `apps/worker`            | Outbox → TimescaleDB relay (2 s loop, ack-after-COMMIT, effectively-once)    |
| `apps/simulator`         | OCPP charge-point fleet: `normal · race · fault · no-show · burst` scenarios |
| `apps/web`               | Next.js 16 operator console ("Grid Current" design system)                   |
| `packages/shared`        | Cross-app constants/errors                                                   |
| `packages/ocpp-messages` | OCPP 1.6J message shapes                                                     |
| `db/oracle`              | V001–V006 migrations, PL/SQL packages, invariants, seed                      |
| `db/timescale`           | T001–T002 hypertables + caggs, enrichment queries                            |
| `test/`                  | Cross-app suites: `api/`, `e2e/`, `load/` (k6), `sql/` (invariants runner)   |
| `bench/`                 | k6 contention/discovery scripts + measured results (feeds `docs/perf.md`)    |
| `docs/adr/`              | Decision records — every architectural change starts here                    |
| `docs/masterplan/`       | DA1→DA2→DA3 engineering masterplan (requirements → schema → architecture)    |
| `infra/`                 | docker-compose + Grafana provisioning                                        |
| `scripts/`               | seed, migrate, demo, OpenAPI drift check, screenshot capture                 |

## Development setup

Two profiles, by design (ADR-0005):

```bash
# 1) local profile — no Docker, in-process store mirroring package semantics.
#    Fast loop for API/console work; race suites run against in-process locks.
npm install
npm run dev:api            # API :4000, seeded demo data
cd apps/web && npm install && npm run dev   # console :3000

# 2) full profile — real Oracle 23ai + TimescaleDB containers.
docker compose -f infra/docker-compose.yml up --build
# provisioning goes through scripts/migrate.sh (V001–V006, T001–T002, seed)
```

Demo logins: `admin@volthub.in` / `Admin@123` · `arjun@volthub.in` /
`Operator@123` · any seeded driver / `Driver@123`. Node 20 or 22 (`.nvmrc` has
22); everything must keep working on both — CI enforces the matrix.

## The testing ladder (run what your change touches, CI runs it all)

| Rung                | Command                                 | Proves                                               |
| ------------------- | --------------------------------------- | ---------------------------------------------------- |
| Lint + format       | `npm run lint && npm run format:check`  | eslint 10 flat config, 0 warnings; prettier clean    |
| Contract tests      | `npm run test -w apps/api`              | REST lifecycle, RBAC, state machine, idempotency     |
| Race suite          | `npm run test:race -w apps/api`         | exactly one winner under parallel double-reserve/pay |
| Security suite      | `node apps/api/test/security.js`        | authn/authz regressions (SEC- register)              |
| Cross-layer         | `node apps/api/test/xlayer.js`          | store↔API parity (local vs Oracle semantics)         |
| Gateway close-race  | `node apps/api/test/gateway-close.js`   | stale-socket deregister bug stays dead (BUG-021)     |
| DB-backed suites    | `STORE=oracle npm run test -w apps/api` | real row locks, packages, guard trigger              |
| Invariants          | `node test/sql/run-invariants.js`       | 11 DB invariants — 0 rows or red                     |
| Coverage (optional) | `npm run coverage`                      | c8 line coverage over unit-tier suites               |
| Full stack          | `npm run test:e2e` (compose up first)   | compose boots, worker relays, health/docs/metrics    |

If you touched anything money-adjacent, run the race suite against Oracle too —
the in-process mutex and Oracle row locks are different engines, and the gap has
bitten before.

## Ground rules (enforced by review, not just CI)

- **Bind variables everywhere.** String-concatenated SQL fails review on sight;
  the invariants runner exists so the schema can also defend itself.
- **No `console.log` in shipped code.** `pino` with request IDs — grep-able,
  structured, and drain-safe under SIGTERM.
- **Writes belong to PL/SQL packages.** If your feature writes money-path state
  from app code or (worse) raw SQL, it also needs an argument for why the guard
  trigger allow-list should change.
- **Seeds stay deterministic** (fixed RNG `20260904`) — never commit `.env`,
  never invent data inside tests when a fixture can carry it.
- **Honest limits.** New README/docs claims need a receipt: what ran, where the
  output lives. `docs/verification.md` is the pattern to follow.

## Commits and PRs

Conventional commits, always: `feat:`, `fix:`, `docs:`, `test:`, `ci:`,
`perf:`, `refactor:` — with scope where it helps (`fix(oracle): …`,
`ci(e2e): …`). The CHANGELOG is assembled from these; release notes are
extracted from Keep-a-Changelog sections by `release.yml`, so a sloppy commit
title is a sloppy release note.

PR checklist (the CI gate mirrors it):

1. Branch from `main`; keep the PR single-purpose.
2. New behaviour → new test in the matching suite (races get extra credit).
3. `npm run lint && npm run format:check` clean — eslint 10 flat config with
   `--max-warnings 0` is stricter than it looks, on purpose.
4. `npm test` green locally; `npm run coverage` if you want the receipt early.
5. Schema/protocol/store-port change → draft an ADR in `docs/adr/` (template:
   context → decision → rejected alternatives → consequences). ADR-0002 shows
   the expected scoring honesty.
6. Docs updated **with the change**, not "in a follow-up".

A maintainer (currently the repo owner, per `CODEOWNERS`) reviews every PR;
one non-author approval and green CI are both required. Reviews focus on
correctness under concurrency, engine parity, and receipt quality — style
arguments belong to prettier.

## Raising issues and ideas

Use the YAML issue forms (`bug` / `feature`). Architecture questions and
"why is it built this way?" live in
[Discussions](https://github.com/humoge7502/VoltHub-CSMS/discussions) — the
Ideas template explicitly asks for the trade-off you would accept, and accepted
ideas graduate into an ADR. Security topics never go to public issues: see
[`SECURITY.md`](SECURITY.md) for the private disclosure path and the
compensation-free but fast-response promise.

## Releases

Tag-driven: cut `v1.x.y` from `main` after the pipeline is green →
`release.yml` re-verifies and publishes a GitHub Release with notes extracted
from `CHANGELOG.md`. Version bumps follow SemVer; breaking schema or OCPP
surface changes must call it out in the changelog's Unreleased section first.
If your change alters the CI pipeline itself, watch the first run on `main`
end-to-end — a green PR does not prove a green push (this exact gap produced
two real fixes already).

## Recognition

Meaningful contributions are credited in the release notes and, for
multi-PR contributors, in the README's roadmap notes. Keeping the review bar
explicit is how this repo stays worth contributing to.
