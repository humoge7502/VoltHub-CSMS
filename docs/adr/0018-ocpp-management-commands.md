# ADR-0018: OCPP 1.6 management commands — allow-listed, awaited, audited

Date: 2026-10 · Status: accepted · Supersedes the "out of scope" list in ADR-0007

## Context

ADR-0007 added exactly two CSMS→CP calls (`RemoteStartTransaction`,
`RemoteStopTransaction`) and explicitly deferred configuration, reservation, reset,
availability and `DataTransfer`. That was the right call for a first bidirectional step:
a command path that fires and forgets cannot tell an operator whether the charger obeyed.

The control plane now needs day-2 operations: recover a hung connector, take a bay out of
service, rotate a key, force a status upload, reserve a bay for a fleet customer. Returning
`202 Accepted` without the charge point's status is not an answer. A charger that replies
`Rejected` must surface as a rejected operation, not as success.

## Decision

Implement a **fixed catalog of ten OCPP 1.6J management commands** in
`apps/api/src/ocpp/commands.js`, dispatched through the existing gateway correlation:

| API action (`POST /control/cp/:cpId/commands/:action`) | OCPP action           | Payload (allow-listed)                                                              | Reads reply                  |
| ------------------------------------------------------ | --------------------- | ----------------------------------------------------------------------------------- | ---------------------------- |
| `reset`                                                | `Reset`               | `type` = Soft \| Hard                                                               | status                       |
| `unlockconnector`                                      | `UnlockConnector`     | `connectorId`                                                                       | status                       |
| `changeavailability`                                   | `ChangeAvailability`  | `connectorId` (0 = whole CP), `type` = Operative/Inoperative                        | status                       |
| `getconfiguration`                                     | `GetConfiguration`    | optional `key` (≤ 50 chars)                                                         | configurationKey, unknownKey |
| `changeconfiguration`                                  | `ChangeConfiguration` | `key` (≤ 50), `value` (≤ 500)                                                       | status                       |
| `triggermessage`                                       | `TriggerMessage`      | `requestedMessage`, optional `connectorId`                                          | status                       |
| `reservenow`                                           | `ReserveNow`          | `connectorId`, `expiryDate` (ISO), `idTag`, optional `parentIdTag`, `reservationId` | status                       |
| `cancelreservation`                                    | `CancelReservation`   | `reservationId` (1..2^31-1)                                                         | status                       |
| `clearcache`                                           | `ClearCache`          | `{}` only                                                                           | status                       |
| `datatransfer`                                         | `DataTransfer`        | `vendorId` (≤ 255), optional `messageId` (≤ 50), `data` (≤ 4096)                    | status                       |

Rules that make the path safe:

1. **Allow-list, not pass-through.** Unknown actions and unknown fields are rejected with
   `400`. A caller cannot smuggle arbitrary JSON into a charger.
2. **Await the CALLRESULT.** The command promise resolves with the CP's payload or rejects
   on `CALLERROR`, timeout (`OCPP_ACK_TIMEOUT_MS`, default 8 s) or offline CP. The route
   returns the actual charger outcome; `accepted:false` lists the CP's reason.
3. **Status vocabulary is per command.** `Accepted` is not universal: `ChangeConfiguration`
   accepts `Accepted | RebootRequired`; `TriggerMessage` accepts `Accepted | Rejected |
NotImplemented`; `DataTransfer` accepts `Accepted | Rejected | UnknownMessageId |
UnknownVendorId`. Anything else is surfaced as rejected, not coerced to success.
4. **Admin-only actuation.** Every command requires role `ADMIN`. `GET /control/commands`
   is read-only for operators and documents the catalog; `GET /admin/charge-points` supplies
   the admin console's inventory (never the `auth_secret`); there is no bulk/script endpoint.
5. **Audited with the result.** Each dispatch writes an audit record naming the actor, CP,
   action, request id, outcome and duration. The command is not retried automatically; a
   retry is a new audited operation.
6. **Rate-limit fairness.** A CALLRESULT answering a pending CSMS CALL does not consume the
   charge point's inbound 10 msg/s budget — otherwise a burst of command replies would get
   a compliant charger disconnected.

## Consequences

- The gateway is genuinely bidirectional for day-2 operations, with an honest failure mode:
  offline CP → `409 CP_OFFLINE`, timeout → `504`, CALLERROR → `502`, rejected →
  `409 OCPP_REJECTED`, never a silent `202`.
- The catalog is deliberately closed. Firmware update, diagnostics and 2.0.1 device-model
  operations remain out of scope until their safety and storage contracts exist.
- Simulator parity is mandatory: `apps/simulator/src/index.js` implements all ten handlers,
  so the tests exercise the real wire protocol rather than a mock.
- `POST /control/cp/:cpId/commands/:action` is not a general RPC tunnel. New commands require
  a new allow-list entry, a simulator handler and a test.

## Tests

`node apps/api/test/ocpp-commands.js` — 10 cases: catalog shape + admin inventory hiding
secrets, each command's payload and reply, `GetConfiguration` response passthrough, rejected
status, `CALLERROR`, timeout, validation/unknown fields, RBAC (operator → 403), offline CP
(409 `CP_OFFLINE`), audit record. Runs on port 4115 with `OCPP_ACK_TIMEOUT_MS=1200`.
