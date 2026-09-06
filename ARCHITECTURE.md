# VoltHub CSMS — Architecture (1 page)

## The shape

A **modular monolith + one worker** (ADR-0001). Express API and the OCPP WebSocket gateway share one port; a 2-second relay worker moves telemetry events from the OLTP engine to the time-series engine. No microservices, no brokers, no cache tier — every simplification is a documented decision, not an omission.

```mermaid
flowchart TB
  W["Next.js web (Grid Current)"] --> REST
  SIM["OCPP simulator fleet<br/>normal · race · fault · no-show · burst"] --> GW
  SIM --> REST
  subgraph API["apps/api — one port :4000"]
    REST["REST /api/v1 (49 routes)"]
    GW["OCPP 1.6J gateway (WS, Basic auth)"]
  end
  REST --> ST
  GW --> ST
  subgraph ENGINES["the two engines"]
    ST["store surface<br/>(port, ADR-0005)"]
    ORA[("Oracle 23ai<br/>29 relations · 7 packages<br/>money path")]
    TS[("TimescaleDB<br/>hypertables · caggs 1m/1h<br/>analytics path")]
  end
  ST -- "write-through (pkg calls)" --> ORA
  ORA -- "hydrate on boot" --> ST
  ST --> OB["outbox (in-transaction)"]
  ORA --> OBO["outbox_event table"]
  OB --> REL["apps/worker · 2s · batch 500<br/>ack-after-COMMIT · ON CONFLICT DO NOTHING"]
  OBO -.-> REL
  REL --> TS
  TS --> GF["Grafana (profile: observability)"]
  REST --> MX["/metrics · /health/deep"] --> GF
```

## The three seams that hold it together

1. **Store port (ADR-0005):** every route is written against `createStore()`'s method surface. `store.js` is the documented local test double; `db/oracle.js` wraps the same object with write-through PL/SQL package calls. Tests run hermetic locally and against real Oracle in CI (`STORE=oracle`).
2. **Outbox pipeline (ADR-0003):** `meter_reading` + `outbox_event` commit atomically inside one package call; the relay delivers at-least-once and the sink dedupes (idempotent replay), so billing never depends on TimescaleDB being up.
3. **Error-band contract (`src/errors.js`):** `ORA-20501…209xx` → HTTP `422/409/402/…` mapped once; identical bands raised by `RAISE_APPLICATION_ERROR` in PL/SQL and mirrored in JS.

## Key decisions (ADR index)

| ADR  | Decision                  | One-line reason                                                                            |
| ---- | ------------------------- | ------------------------------------------------------------------------------------------ |
| 0001 | Modular monolith          | Money invariants stay in one transaction boundary; sagas would hide the graded correctness |
| 0002 | TimescaleDB for telemetry | Ticks are append-heavy/immutable/window-read; matrix score 4.90 vs InfluxDB 3.95           |
| 0003 | Outbox + relay            | Atomic-with-write publication; dual-write diverges on crash; CDC too heavy for scope       |
| 0004 | Plain JS + Express        | Zero-build velocity; contracts carried by OpenAPI drift gate + tests, not types            |
| 0005 | Hexagonal store           | Replacement, not rewrite: routes unchanged between engines; hermetic tests preserved       |

## Where it deliberately stops (scale exits, not features)

- Multi-VM ⇒ the Maps read-cache becomes read-through (and Redis becomes justified).
- > 50 charge points/VM ⇒ shard the OCPP gateway by identity hash.
- Any of these is measurable first (`bench/`), decided second.
