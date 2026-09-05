# ADR-0002: TimescaleDB for telemetry (score 4.90/5)

Per masterplan §§23–24. Meter ticks are append-heavy, time-ordered, immutable, read as aggregates: hypertables (1d chunks) + `tick_1m`/`tick_1h`/`state_1m` continuous aggregates + 7d compression + 90d retention.
Rejected: InfluxDB3 (weaker SQL/metadata joins + course continuity), Cassandra (no multi-DC need), Neo4j (topology fits FKs), ClickHouse (not on university list; outbox version is right-sized).
Oracle stays system of record; Timescale is a projection, never a duplicate.
