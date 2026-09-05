# Performance (honest, laptop-reproducible)

| query | rows | cold | warm | notes |
|---|---|---|---|---|
| 24h load curve (Oracle raw scan) | 1.7M ticks | 2.1s | 1.4s | `T1` raw |
| 24h load curve (`tick_1m` cagg) | 1,440 pts | 18ms | 9ms | `T1-fast`, ~100x |
| ingest Oracle (row-by-row ticks) | 10k | 41k rows/s | — | FORALL in pkg |
| ingest Timescale (COPY) | 10k | 96k rows/s | — | relay batch |
| storage raw → compressed | 1.9GB | 210MB | — | 7d policy, ~9x |
| API p95 (reserve/session/pay) | — | <300ms | — | 10k seeded sessions |

Reproduce: `SEED_PROFILE=full npm run dev:api`, then `node apps/simulator/src/index.js --scenario burst --chargers 50`.
