# ADR-0007: CSMS→CP remote commands (RemoteStop/RemoteStart) — scope and shape

Date: 2026-09 (post Audit Round 2, B2G-009) · Status: proposed

## Context

The OCPP 1.6J gateway is currently a pure listener: it answers Boot/Heartbeat/Status/
Authorize/Start/Meter/Stop but never issues a CALL to a charge point. Consequence:
`POST /sessions/:id/remote-stop` mutates CSMS state only — the charger keeps metering
because nothing told it to stop. A CSMS that cannot command chargers is a dashboard.

## Decision

Add exactly two CSMS→CP CALLs, no more:

- `RemoteStopTransaction { transactionId }` — fired by `POST /sessions/:id/remote-stop`
  after the store transition (fire-and-forget with logged outcome).
- `RemoteStartTransaction { connectorId, idTag }` — fired by the operator console;
  gated by the same allow-list `Authorize` logic.

Registry plumbing: `mountOcpp` already owns `identity → ws`; expose
`send(identity, action, payload)` and a pending-CALL resolver (uid → promise, 8 s timeout,
mirroring the simulator's own helper).

## Explicitly out of scope (unchanged)

DataTransfer, GetDiagnostics, Firmware/Configuration management, reserve-now over OCPP.
The 2.0.1 migration story (ADR note in README) is documentation, not code.

## Consequences

- The gateway becomes genuinely bidirectional — "management system" is now literally true.
- Simulator gains an inbound-CALL handler; a WS test asserts the CP receives the CALL.
- Failure mode is honest and visible: an offline CP yields a logged, unanswered CALL —
  the store transition already happened (CSMS state remains authoritative, as in real CSMSs).
