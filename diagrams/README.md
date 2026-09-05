# diagrams — Mermaid sources (render with `mmdc`)

- `system-architecture.mmd` — clients → monolith → Oracle/Timescale
- `er-model.mmd` — 25 entities, weak/EER/multivalued/derived annotated
- `reservation-race.mmd` — R1 sequence: FOR UPDATE serializes A/B → 201+409
- `session-lifecycle.mmd` — OCPP × billing × connector state machines
- `da3-pipeline.mmd` — outbox → relay → hypertables → caggs
- `da3-schema.mmd` — raw tables, cagg hierarchy, station_map enrichment
