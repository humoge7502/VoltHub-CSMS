# ADR-0004: Plain-JS Express instead of NestJS/TypeScript

Date: 2026-09-05 · Status: accepted (documents a pre-existing divergence from masterplan §10).

## Context

The masterplan prescribes NestJS + TypeScript. The shipped codebase is plain-JS Express
(6-workspace npm monorepo, zero build step) with hand-rolled validation in
`packages/shared` and a hand-maintained OpenAPI spec (`apps/api/src/docs.js`).

## Decision

Keep Express + plain JS. Do not rewrite to NestJS/TS retroactively.

## Reasons

- Velocity: the team is fluent; a rewrite buys zero database marks (DA2/DA3 grade SQL/PLSQL
  - demonstrations, not framework choice).
- Zero-build monorepo: `node --check` + contract tests are the entire toolchain; NestJS
  would add compile/di complexity with no academic payoff.
- Contracts already exist without types: OpenAPI hand-spec + `TEST-SEC`/`TEST-XLAYER`
  suites + `scripts/check-openapi.js` drift gate.

## Trade-offs

- No compile-time contracts (accepted; mitigated by the drift gate + contract tests).
- DI is by convention (routes take `store`), not enforced.

## Consequences

- `docs/masterplan/10-backend-and-api.md` stays as the design rationale; this ADR records
  the implemented divergence honestly.
