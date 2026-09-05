# Demo script (12 min — slides bookend, live middle)

1. **0–1 problem**: idle dashboard — "certainty is a DB property".
2. **1–2 arch**: monolith + two engines + outbox diagram.
3. **2–3.5 ER**: `CONNECTOR_SLOT` naive → BCNF decomposition (accept the join-implied FD cost).
4. **3.5–5 RACE** (two terminals): `node apps/simulator/src/index.js --scenario race` → `201 + 409`. "The DB locked the row."
5. **5–7 session**: reserve → plug-in (`/reservations` → simulator normal) → live kWh/kW/cost → invoice → wallet pay.
6. **7–8.5 packages**: `create_reservation` / `pay_invoice` + double-pay `409` (invoice lock, `balance_after` ledger).
7. **8.5–10 telemetry**: burst → curve moves; cagg + compression numbers.
8. **10–11 hygiene**: CI green, OpenAPI-shaped REST, audit log browser.
9. **11–12 limits + roadmap**: simulated chargers, wallet-not-cards, next (read-partition history, CDC, measured cache).

Fallbacks: GIFs for beats 5/7, printed SQL (`db/oracle/queries.sql Q10/Q25`), timekeeper ≤90s/beat.
