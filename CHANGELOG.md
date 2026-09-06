# Changelog

All notable changes. Format: Keep a Changelog, Semantic Versioning.

## [Unreleased]

### Fixed

- **BUG-025 (security middleware): the login-throttle bucket map leaked.** The
  BUG-015 idle sweep evicted stale buckets from the per-user/per-IP throttle map
  but never from the per-IP login map (`loginWindows`), so buckets for one-shot
  or scanner IPs accumulated forever on a long-lived process. The sweep now
  trims both maps. Regression-gated by `TEST-SEC-SWEEP-1` in
  `apps/api/test/security.js` (stale buckets in BOTH maps must be evicted).
- **BUG-024 (OCPP): a CSMS restart silently swallowed in-flight sessions' meter data.**
  The gateway's per-session MeterValues sequence counter (`seqByTx`) was memory-only
  while sessions are durable (Oracle + hydrate on boot). After a restart, the counter
  restarted at 1 and every replayed `seq_no` hit the store's idempotent dedupe
  (`{deduped:true}`) — ticks were dropped without error until the counter caught up
  with the pre-restart max, understating kWh and billing on stale meters. The gateway
  now recovers the cursor from the persisted readings on first sight of a session
  (logs `ocpp tick cursor recovered after restart`). Regression-gated by
  `gateway-close.js` test 3 (cursor cleared + socket recycled mid-session; validates
  all three ticks persist and the post-restart tick lands at the recovered seq).
- **Docs truth pass** — every count in prose now matches what the code ships:
  REST surface is **49 paths / 53 operations** (was written as 48/52 in the
  README, docs map, docs site and web KPI), the Oracle schema is
  **29 relations** (25 was stale since `refresh_token` + `idempotency_key`
  joined `V001`; masterplan §10.1 arithmetic reconciled), `V001` carries
  **12 indexes** (+2 FK-pair indexes from V006, now also listed in §10.5),
  `invariants.sql` defines **11 CI-gated checks** (was "7"), and the docs-site
  stat counts CI correctly at **6 jobs**. Masterplan §10.2 now documents the
  two previously missing relations (`IDEMPOTENCY_KEY`, `REFRESH_TOKEN`) in the
  same notation as the rest. `CITATION.cff` points at v1.4.0 (tag + commit)
  instead of v1.3.0. Note: `docs/architecture-hero.png` still renders the
  previous 25-relation diagram — re-render it from `diagrams/architecture.mmd`
  when an image toolchain is available.
- Web console homepage KPI now reads 29 relations / 7 PL/SQL packages (the
  "25 rel / 6 packages" card predates the SEC-012/B2G-014 schema additions).
- CHANGELOG: `[1.3.0]` date corrected to 2026-09-05 (the tag's actual date).

## [1.4.0] — 2026-09-05

### Added

- **httpOnly refresh cookie + logout (SEC-012, closes the tracked P2)**: login/register/
  refresh set `vh_rt` as an **httpOnly, SameSite=Lax cookie scoped to `/api/v1/auth`**
  (`Secure` in production); `POST /auth/logout` revokes the refresh **family** server-side
  and clears the cookie (audited as `LOGOUT`). The JSON body field remains for non-browser
  clients. CORS upgraded to explicit-origin allow-list + `credentials: true`. Web logout now
  calls the API (best-effort) before dropping the local token. Regression-gated by
  `TEST-SEC-COOKIE-1..4` (13 security tests total, all green).
- **Flagship cross-link**: README footer now points to [Q-Trust](https://github.com/humoge7502/q-trust)
  — the two projects share one receipts-first discipline.
- Benchmarks re-run post-SEC-012 (same hardware): race invariant intact (exactly 1×201 +
  19×409), auth-path overhead unchanged. Raw: `bench/results-local.json`; tables in `docs/perf.md`.

## [1.3.1] — 2026-09-05

### Added

- **Publishable REST contract**: `docs/openapi.json` — the full OpenAPI 3.0 spec
  (48 paths / 52 operations) captured from the live `/api/v1/docs` endpoint and
  committed as a static artifact, so the API surface is reviewable without
  booting the stack; the CI drift gate keeps it honest against routes.js.
- **Community-health complete**: `CODE_OF_CONDUCT.md` (precise, honest, useful —
  receipts bar applies to conduct too), `SUPPORT.md` (routing table with honest
  response expectations), `CITATION.cff` (repo is now citable; GitHub renders a
  **Cite this repository** button), and `.vscode/extensions.json` recommending
  the actual toolchain (eslint/prettier/mermaid/Oracle dev tools/rest-client).
- README docs map + `docs/README.md` index the new contract artifact.

## [1.3.0] — 2026-09-05

### Added

- **Coverage receipts**: `npm run coverage` (c8, V8 instrumentation, `--all`
  over `apps/*/src` + `packages/*/src`) and a 6th CI job publishing line
  coverage to Codecov. Informational by policy (`codecov.yml`) — the badge is
  a receipt, not a target; DB-backed suites stay in `db-tests` on purpose.
  Local: `npm install` then `npm run coverage` (text + lcov + json-summary).
- **Pages via Actions**: `pages.yml` deploys `docs/` as a Pages artifact
  (Settings → Pages → Source: GitHub Actions), with a lean-site budget check.
- **Community kit**: full `CONTRIBUTING.md` (project map, two dev profiles,
  the 10-rung testing ladder, ground rules, ADR-first changes, release path);
  `greetings.yml` first-contact replies routed to the docs that matter;
  Discussions templates for `ideas` (trade-off required) and `q&a`
  (what-you-already-read required).
- **Visual identity refresh** (electric indigo): README header banner,
  re-rendered `architecture-hero.png` (now shows the 6-job CI pipeline) and
  `social-preview.png` — all real renders, no third-party banner services.

### Changed

- **oracledb 6.10.0 → 7.0.1** (the last deliberately-deferred upgrade): merged
  after a fully-green db-tests run against real Oracle 23ai — the exact gate the
  hardening report set (no blind driver bumps without DB-backed CI).
- `ci.yml` push trigger scoped to `main` so `v*` tag pushes don't re-run the
  whole 6-job matrix (the tag-driven `release.yml` already re-verifies).
- README: image-first header, Codecov badge, stats row and CI row updated to
  6 jobs; Quickstart gains the coverage rung.

## [1.2.0] — 2026-09-05

### Repo / presentation (GitHub pack)

- **README v2**: badge row (ci · release · OpenSSF Scorecard · Ask DeepWiki ·
  node 20|22 · Oracle · TimescaleDB · license · docs site), "New here?" reading
  paths, route/engine/package/ADR/CI/CVE stats row, "Stack, and why" trade-off
  table, mermaid system diagram, and a docs map.
- **GitHub Pages one-pager** at `docs/index.html` (deploys from `main` + `/docs`)
  and a 1280×640 **social preview** `docs/social-preview.png`.
- **YAML issue forms** (bug / feature / security-routing `config.yml`) replace the
  old markdown templates; `.gitattributes` keeps the language bar honest.
- **Tag-driven `release.yml`** (verify → GitHub Release with CHANGELOG notes) and
  **OpenSSF `scorecard.yml`** (weekly + on push, SARIF → Code Scanning).
- Profile README published at `humoge7502/humoge7502`.

### Security (HARDEN-2026-09)

- **Zero known CVEs across both lockfiles**: express 4.19 → 5.2.1 (DoS CVE
  chain GHSA-4mjr-xmp4-gh2g closed), Next 14.2.5 → 16.3.4 + React 19 (framework
  CVE cluster + postcss chain closed). `npm audit` is now a CI gate on both
  lockfiles (`security` job, 5-job pipeline).
- SEC-011: login no longer leaks account existence by timing — unknown emails
  are verified against a fixed dummy scrypt hash (measured ≈42 ms both paths,
  gap 0 ms across 3 sample pairs). Regression-gated in `apps/api/test/security.js`.
- SEC-010: `x-powered-by` framework fingerprint removed; proxy trust is now
  opt-in via `TRUST_PROXY` (BUG-023) so the documented Caddy deploy profile
  cannot collapse the per-IP login throttle into a platform-wide outage.

### Changed

- **Platform toolchain**: eslint 8 `.eslintrc` → eslint 10 flat config
  (`eslint.config.js`; stricter gate immediately caught an unused catch binding
  and a never-read assignment); pino 9 → 10.3.1; Node 22 LTS images with a
  Node 20/22 CI matrix keeping `engines >=20` honest; checkout/setup-node v7;
  concurrency `cancel-in-progress`.
- **Web**: Next 16 + React 19 — dynamic-route pages migrated from sync `params`
  props to `useParams()` (the `/stations/:id` + `/session/:id` routes were
  verified in a real browser, zero page errors).
- `scripts/check-openapi.js` uses the `app.router` getter (Express 5 removed
  `app._router`) — the OpenAPI drift gate would otherwise have silently zeroed.
  Re-verified: spec=48 routes~52, no missing paths.

### Fixed

- BUG-021: a reconnecting charge point's stale socket deregistered its live
  successor and marked the charger OFFLINE — the gateway close handler now only
  clears the registration it owns. Regression suite `apps/api/test/gateway-close.js`
  was validated to catch the bug (unguarded handler → red, re-applied → green).
- BUG-022: worker/relay HTTP calls were unbounded — a hung API could freeze the
  telemetry pipeline. Every call now carries `AbortSignal.timeout(5s)`.
- No graceful shutdown anywhere: the API now drains on SIGTERM/SIGINT (stop
  accepting, close OCPP sockets, 10 s failsafe) and the worker stops between 2 s
  cycles; compose services gained `stop_grace_period` above the failsafes and
  `restart: unless-stopped`.

### Added

- Worker now syncs Timescale `station_map` from `GET /internal/station-map` on
  every loop (masterplan §26.5, previously unimplemented): Oracle-owned station
  metadata denormalized for query-time cagg enrichment, so `v_tick_1m_enriched` /
  `v_tick_1h_enriched` and the Grafana per-station dashboard have data in prod.
  Relay unit tests (`apps/worker/test/relay.test.js`) wired into `npm test` and
  CI; e2e verifies `station_map` is populated by the live worker.
- The API Dockerfile never copied `apps/worker` (compose runs the worker from the
  same image), so the worker silently exited in the compose stack — B2G-001's
  relay was never live in e2e. The image now ships `apps/worker`.
- (Superseded in HARDEN-2026-09 below: actions are now at v7 with a Node 20/22
  matrix — see the Security/Changed sections above.)

### Fixed (migrations were never run end-to-end — "CI partly theater" closed)

- `db/oracle`: V001 now owns the `cp_id`/`connector_no` FK pair so V002/V003
  compile on a fresh DB (V005's guarded ALTERs no-op for fresh runs, still
  repair legacy DBs).
- `db/oracle`: `audit_log.old_value/new_value` dropped their `CHECK (IS JSON)`
  — `audit_pkg.log` writes plain text/NULL diffs, so the seed's tariff and
  package audits raised ORA-02290; V006 drops the constraint on legacy DBs.
- `db/oracle`: `maintenance_pkg` now sets the `pkg:` `CLIENT_IDENTIFIER` the
  V004 connector guard allow-list requires (seed fault story raised ORA-20801).
- `db/oracle/seed`: COMMIT per story (autonomous audits self-deadlocked a
  single giant transaction with ORA-00060); fixed an illegal scalar subquery
  in the fault story's procedure argument.
- `db/oracle/V004`: least-privilege role bootstrap now guards for the missing
  `CREATE ROLE` privilege on the schema-owner migrate account — one note
  instead of 90 ORA lines when skipped; full grants when run privileged.
- `db/timescale/T002`: continuous aggregates can only query one hypertable —
  rewritten join-free (P2V-01) with `MODE()` replaced by per-state `FILTER`
  counts + `v_state_1m` (P2V-02); enrichment moved to query-time views
  `v_tick_1m_enriched`/`v_tick_1h_enriched`.
- `scripts/migrate.sh`: Oracle migrations exec sqlplus inside the running
  container (never a silent skip via `docker run`), and both Oracle and
  Timescale paths now fail loudly when a migration errors.
- CI: the local-store suites (contract/race/security/xlayer) blank
  `ORACLE_HOST` so they can't nondeterministically attach the Oracle adapter
  mid-run; `db-tests` adds a Timescale cagg-refresh smoke (closes P2V-01/02 on
  every push); the e2e job provisions DBs via `scripts/migrate.sh` (initdb
  mounts hid the Timescale image's setup scripts and ran `queries.sql`) and
  waits for stable Oracle connects before migrating.

## [1.1.0] — 2026-09-05

### Added & fixed (Audit Round 3 — B3G register + verification kit)

- ADR-0006 implemented via `V006__fk_native.sql`: connector linkage is now
  FK-native (`cp_id`, `connector_no` pair written by the packages, trigger
  derivation retired); D-02 `start_minute`/`end_minute` VIRTUAL columns +
  `uq_band_slot_minute`; invariant 11 gates the pair (NULL/dangling) on both
  engines; local store + Oracle hydrate write the pair natively.
- B3G-001: operator `RemoteStartTransaction` (allow-listed `TAG-<uid>`) with
  RemoteStop parity; gateway pino log call fixed (method-bound `this`).
- B3G-005: orphaned-invoice total guard — non-admins get 403 when an invoice's
  session no longer exists.
- OCPP remote-command contract suite (`apps/api/test/ocpp-remote.js`, 2 tests)
  wired into `npm test` and CI `quality` + `db-tests` jobs.
- Bench harness (`bench/run-local.js`, k6 contention/discovery scripts) + measured
  tables in `docs/perf.md`; `docs/verification.md` receipt discipline added.
- Fix (web): CSP hydration bug — `default-src 'self'` blocked Next's inline RSC
  bootstrap so the console never hydrated in dev **or** prod (verified via
  Playwright, React #423). `script-src` is now env-aware: `'unsafe-inline'`
  always, `'unsafe-eval'` dev-only.
- Evidence: real-pixel README strip + live OCPP GIF under `docs/screenshots/`
  with re-recordable tooling in `scripts/screenshots/` (self-contained deps).
- OpenAPI: service index `/` documented — drift gate reports zero notes.

### Fixed (Audit Round 2 — B2G register)

- B2G-001 (P0): full-stack compose demo now actually relays outbox events into TimescaleDB (worker `TS_HOST` env + `pg` in image + pinned Timescale tag).
- B2G-002 (P0): object-level authorization on `GET /invoices/:id`, `POST /sessions/:id/bill`, `POST /sessions/:id/remote-stop` (OWASP API1:2023).
- B2G-003 (P0): role gate on station analytics; manual fault reports no longer flip connector state.
- B2G-004 (P1): pay-parity — a failed wallet payment leaves the invoice DUE on BOTH engines (was: local mode bricked the invoice as FAILED).
- B2G-005 (P1): Oracle hydrate covers transactional tables; outbox acks now durable in Oracle.
- B2G-006 (P1): Timescale sink dedupe key aligned with the outbox (same-second ticks no longer dropped).
- B2G-013 (P1): session start verifies reservation ownership + connector match.
- B2G-010 (P1): JWT algorithm pinned; login-tier rate limit; scope-check NaN fixed.
- B2G-014 (P1): Idempotency-Key backed by the `idempotency_key` table under `STORE=oracle`.
- B2G-007/008/011/012 (P2): dead code removed; docs truth pass (SECURITY/README/ADR-0003); sargable view joins; band resolver determinism; lint + community files.

## [1.0.0] — initial two-engine build

- Oracle 23ai OLTP: 25-relation schema, 7 PL/SQL packages, connector guard, least-privilege role.
- OCPP 1.6J gateway (Security Profile 1) + 5-scenario simulator fleet.
- TimescaleDB telemetry: hypertables, hierarchical caggs, compression, retention; outbox relay.
- Next.js "Grid Current" console; 3-job CI with Oracle + Timescale service containers.
