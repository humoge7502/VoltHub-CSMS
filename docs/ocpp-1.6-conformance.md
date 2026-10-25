# OCPP 1.6J conformance statement

Scope: the VoltHub CSMS acts as a **Central System** for OCPP 1.6J charge points
(JSON over WebSocket, subprotocol `ocpp1.6`). This document states what is implemented,
what is deliberately not, and which tests prove it. It is a conformance statement for the
profiles we ship — not a claim of certification.

Last verified: 2026-10-25 · Gateway: `apps/api/src/ocpp/gateway.js` · Simulator:
`apps/simulator/src/index.js`

## Transport and session

| Requirement                                                                 | Status | Evidence                                     |
| --------------------------------------------------------------------------- | ------ | -------------------------------------------- |
| WebSocket upgrade at `GET /ocpp/:cpId`, subprotocol `ocpp1.6`               | ✅     | `gateway.js`, `apps/api/test/ocpp-remote.js` |
| Charge point identity bound to a known CP record; unknown identity rejected | ✅     | `mountOcpp`, gateway tests                   |
| `BootNotification` accepted, heartbeat interval returned                    | ✅     | simulator flow, `apps/api/test/run.js`       |
| `Heartbeat` liveness and last-seen tracking                                 | ✅     | gateway tests                                |
| Server-initiated `Ping` / stale-socket reaping                              | ✅     | `apps/api/test/gateway-close.js`             |
| JSON array framing (`[2, uid, action, payload]`, `[3, …]`, `[4, …]`)        | ✅     | gateway, simulator tests                     |
| Unknown action → `CALLERROR NotImplemented`                                 | ✅     | gateway                                      |
| Strict inbound rate limit (10 msg/s per CP) with disconnect on abuse        | ✅     | `apps/api/test/ratelimit.js`                 |
| CALLRESULT for a pending CSMS CALL exempt from the inbound budget           | ✅     | `apps/api/test/ocpp-commands.js`, ADR-0018   |

## Core profile — charge point → CSMS

| Message                         | Status | Behaviour                                                                                                      |
| ------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| `BootNotification`              | ✅     | Accepts and records model/vendor/firmware; updates CP heartbeat interval.                                      |
| `Heartbeat`                     | ✅     | Updates last-seen; reply carries current time.                                                                 |
| `StatusNotification`            | ✅     | Mirrors connector status; rejects unknown connector; drives availability and fault state.                      |
| `Authorize`                     | ✅     | IdTag allow-list / driver lookup; `Accepted`, `Blocked`, `Expired`, `Invalid`.                                 |
| `StartTransaction`              | ✅     | Validates connector availability, opens session, returns `transactionId` and `idTagInfo`. Idempotent on retry. |
| `MeterValues`                   | ✅     | Persists readings (energy, power, SoC where present); rejects non-monotonic transaction ids.                   |
| `StopTransaction`               | ✅     | Closes session, computes energy delta, triggers billing/outbox. `Accepted`/`Invalid`.                          |
| `DataTransfer` (CP→CSMS)        | ⚠️     | Not implemented; returns `NotImplemented`. Vendor data is CSMS→CP only (see below).                            |
| `DiagnosticsStatusNotification` | ❌     | Not implemented (no diagnostics rail).                                                                         |
| `FirmwareStatusNotification`    | ❌     | Not implemented (no firmware rail).                                                                            |

## Core profile — CSMS → charge point

| Message                  | Status | Notes                                                                                              |
| ------------------------ | ------ | -------------------------------------------------------------------------------------------------- |
| `RemoteStartTransaction` | ✅     | Operator console; allow-listed idTag; awaited reply.                                               |
| `RemoteStopTransaction`  | ✅     | `POST /sessions/:id/remote-stop`; awaited reply.                                                   |
| `Reset`                  | ✅     | `type` = `Soft`/`Hard`; admin only.                                                                |
| `UnlockConnector`        | ✅     | Recover a physically hung connector; admin only.                                                   |
| `ChangeAvailability`     | ✅     | `connectorId` 0 = whole CP; `Operative`/`Inoperative`; admin only.                                 |
| `GetConfiguration`       | ✅     | Optional key filter; returns `configurationKey` and `unknownKey` verbatim.                         |
| `ChangeConfiguration`    | ✅     | Key/value allow-listed lengths; `Accepted` or `RebootRequired`.                                    |
| `ClearCache`             | ✅     | Empty payload only.                                                                                |
| `ReserveNow`             | ✅     | Connector, expiry (ISO-8601), idTag, optional parent idTag/reservation id.                         |
| `CancelReservation`      | ✅     | Reservation id 1..2^31-1.                                                                          |
| `TriggerMessage`         | ✅     | Requests `BootNotification`, `Heartbeat`, `MeterValues`, `StatusNotification`; optional connector. |
| `DataTransfer`           | ✅     | `vendorId` required; optional `messageId`/`data` bounded; CP reply surfaced.                       |
| `GetDiagnostics`         | ❌     | Out of scope (no file storage/upload contract).                                                    |
| `UpdateFirmware`         | ❌     | Out of scope (no signed-image or rollback contract).                                               |

All CSMS→CP commands follow one path: `POST /api/v1/control/cp/:cpId/commands/:action`
(role `ADMIN`), allow-listed payload, awaited `CALLRESULT` with a per-command accepted-status
set, audit record, and `GET /api/v1/control/commands` for the catalog. See ADR-0018.

## Smart Charging profile

| Message                                        | Status | Notes                                                                                                                       |
| ---------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `SetChargingProfile`                           | ✅     | Sends a TxProfile/TxDefaultProfile derived from the certified schedule; awaited reply; profile id and payload SHA recorded. |
| `ClearChargingProfile`                         | ✅     | By profile id and/or connector.                                                                                             |
| `GetCompositeSchedule`                         | ✅     | Requests a bounded duration and returns the CP's composite view.                                                            |
| `ChargingProfile` in `StartTransaction`        | ❌     | Not sent; profiles are set after start.                                                                                     |
| `RemoteStartTransaction` with charging profile | ❌     | Not sent; an operator starts, then the controller applies the schedule.                                                     |

## Reservation profile

| Requirement                                                       | Status | Notes                                                                                                        |
| ----------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `ReserveNow` / `CancelReservation` CSMS→CP                        | ✅     | ADR-0018 catalog.                                                                                            |
| CSMS-side reservation lifecycle and connector booking             | ✅     | `POST /reservations`, expiry sweeper, store transition.                                                      |
| `ReserveNow` in `StartTransaction` authorization                  | ⚠️     | CSMS validates its own reservation before authorizing; it does not rely on the CP's local reservation state. |
| Local Authorization List (`SendLocalList`, `GetLocalListVersion`) | ❌     | Authorization is online-only; an offline CP cannot authorize a new driver.                                   |

## Remote Trigger profile

| Requirement                                                        | Status                            |
| ------------------------------------------------------------------ | --------------------------------- |
| `TriggerMessage` for Boot/Heartbeat/MeterValues/StatusNotification | ✅                                |
| `TriggerMessage` for Diagnostics/FirmwareStatus                    | ❌ (no diagnostics/firmware rail) |

## Known deviations and constraints

1. **Online authorization only.** There is no local auth list cache; a CP that loses
   connectivity cannot start a new session unless its own offline policy allows it. This is
   a documented product decision, not an accident.
2. **No firmware or diagnostics management.** We do not ship a file store, signature
   verification or rollback path, so we refuse the operations rather than pretend.
3. **Reservation authority is the CSMS.** The CP receives `ReserveNow`, but the CSMS
   re-checks its own reservation before `StartTransaction`; a stale CP reservation cannot
   override a cancelled booking.
4. **Command retries are manual.** No automatic replay: a timeout is returned to the
   operator and a retry is a new audited operation. This avoids double-actuation after an
   ambiguous network failure.
5. **1.6J only.** OCPP 2.0.1 is a documented migration story, not implemented. Message
   names, security profiles and the device model differ enough that a shim would be a lie.

## How to verify

```bash
node apps/api/test/ocpp-remote.js     # RemoteStart/RemoteStop over a real WS
node apps/api/test/ocpp-commands.js   # 10 management commands, accept/reject/timeout/RBAC
node apps/api/test/gateway-close.js   # disconnect, pending-call cancellation, cleanup
node apps/api/test/ratelimit.js       # inbound budget and pending-result exemption
node apps/api/test/control.js         # smart-charging profiles and certification
node apps/simulator/test/twin.test.js # digital-twin profile compliance
```

The simulator implements every CSMS→CP message listed above, so these tests exercise the
wire protocol (JSON arrays, unique ids, CALLERROR) rather than stubbed functions.
