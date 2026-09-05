# ADR-0005: Hexagonal store — one port, two adapters

Date: 2026-09-05 · Status: accepted (implements §7.2 wiring plan).

## Context

`apps/api/src/db/store.js` mirrors the Oracle packages 1:1 (same method names, same
`ORA-20xxx` bands, same state machines) but holds data in process Maps. Routes were
built against that surface, so the surface _is_ the port.

## Decision

- Port: the `createStore()` method surface
  (`createReservation/cancelReservation/expireStale/startSession/transition/recordTick/`
  `stopSession/resolveBandPrice/billSession/payInvoice` + Maps for reads).
- Adapters: `store.js` (local test double, documented as such) and `db/oracle.js`
  (write-through Oracle package calls over a hydrated local read-cache).
- Seam: `db/index.js:getStore()` + background upgrade in `server.js`
  (`store._mode`: `local` → `oracle-connecting` → `oracle` | `local-fallback`).
- Error contract unchanged: `db/errors.js:oraStatus/fromDriver` maps driver
  `ORA-xxxxx` to the same HTTP statuses, so `201/409/402` behavior is identical.

## Reasons

- Replacement, not rewrite: ~all route code is untouched; only the data layer changes.
- Tests stay hermetic: contract/race/e2e/security/xlayer suites run on `local` always
  and additionally with `STORE=oracle` in the `db-tests` CI job.
- Durability without a flag-day: hydrate-on-boot restores Maps; writes commit to Oracle
  first (row locks enforced there), then apply locally.

## Trade-offs / limits

- Reads serve from the hydrated Maps (single-VM read-cache). Multi-instance read-through
  is explicitly out of scope (single-VM compose topology, ADR-0001).
- `resolveBandPrice` stays sync from the cached bands (tariff versions refresh the cache
  on write); half-open `[start, end)` matches `TARIFF_PKG` post-V005.
- B3G-004: durable idempotency replay is read-then-insert. On two concurrent same-key
  requests _on different instances_, both could miss the SELECT and both execute;
  correctness then rests on the reservation overlap constraint (second attempt → 409
  `OVERLAP`) and the `key_value` PK (second INSERT fails, Map path continues). Under the
  documented single-instance deployment this window is unreachable. No code needed.

## Consequences

- `store.js` header now says "test double"; `README.md` honest-limits describe both profiles.
- DA2 demo: same API, same 409 codes — now from `RAISE_APPLICATION_ERROR` in the package.
