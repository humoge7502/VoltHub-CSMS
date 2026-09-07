# ADR-0009: multi-tenancy — evaluated, deliberately deferred

Date: 2026-09 (engineering mission) · Status: accepted (deferred)

## Context

The mission brief asks: "if VoltHub is intended to be SaaS, make tenant isolation a
first-class architectural property." A serious answer requires deciding — not
defaulting — because retrofitting tenancy is the single most expensive change a
CSMS codebase can absorb (every table, query, cache key, job, event and token
carries tenant context).

## Assessment of the current system

- The schema has **no tenant concept**: `station.operator_id` models CPO staff
  assignment, not ownership. One deployment = one charge-point operator.
- Every doc that states scope agrees: ADR-0001 (single-VM modular monolith), the
  README "Honest limits", and the masterplan's DA1→DA3 story are all single-CPO.
- The auth model (JWT claims + `stationScope`) is operator-scoped, not tenant-scoped.

## Decision

**Defer multi-tenancy.** Rationale:

1. No demonstrated requirement — the platform's stated deployment target is one
   operator per VM (ADR-0001). Adding `tenant_id` to 29 relations, every PL/SQL
   package, the store adapter, JWT claims, the outbox, Timescale tables, Grafana,
   and the AI sidecar is a rewrite-grade change with zero paying tenants to serve.
2. The migration is **designed, not started**: if SaaS becomes real, the shape is —
   (a) `tenant` root relation; `tenant_id` on `station`, `app_user`, `app_vehicle`,
   and everything that cascades from them; (b) `tenant_id` in JWT claims + a
   `requireTenant` middleware beside `requireOwned`; (c) Postgres-style RLS on
   Oracle via VPD policies for defense-in-depth; (d) tenant keying on the outbox
   dedupe and Timescale hypertables; (e) per-tenant test isolation (driver of
   tenant A reading tenant B's station = 404, not 403 — existence hidden).
3. The AI guardrails in ADR-0008 are written tenant-ready: the sidecar receives
   scoped data shapes only, so tenant scoping composes at the API layer.

## Consequences

- The README "Honest limits" stays truthful: single-operator deployment.
- Any future SaaS work starts from the migration sketch above and lands behind an
  ADR amendment with CI tenant-isolation tests — never by incrementally sprinkling
  `tenant_id` without the isolation test suite.
