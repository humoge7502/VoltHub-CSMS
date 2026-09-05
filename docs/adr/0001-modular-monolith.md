# ADR-0001: Modular monolith (not microservices)

Decision: one NestJS-style modular monolith (auth/users/stations/reservations/sessions/billing/ocpp/telemetry/admin/health) + worker + simulator, per masterplan §8.
Reservation/billing split into services would force sagas and obscure the DB correctness being graded. Monolith keeps money invariants in Oracle packages behind one transaction boundary. Exit: extract telemetry reads if/when Timescale load dominates.
