# @volthub/ocpp-messages — typed OCPP 1.6J codec

JSON-WS framing (`[MessageTypeId, UniqueId, Action|Payload]`): `call()` /
`result()` / `callError()` builders plus `parse()` into `{CALL,RESULT,ERROR}`.
Used identically by the gateway (`apps/api`) and the fleet (`apps/simulator`),
so simulator and server can never drift on protocol shape.
