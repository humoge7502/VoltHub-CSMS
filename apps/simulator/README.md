# @volthub/simulator — scripted OCPP 1.6J fleet

N virtual chargers speaking real 1.6J JSON-WS (`BootNotification`,
`StatusNotification`, `Authorize`, `Start/StopTransaction`, `MeterValues`).

```bash
node src/index.js --scenario normal --chargers 2   # happy path
node src/index.js --scenario race                  # R1: expect exactly 1×201 + 1×409
node src/index.js --scenario fault-mid-session     # GroundFailure at tick 5
node src/index.js --scenario no-show               # books, never plugs in (expiry job)
node src/index.js --scenario burst --chargers 50   # DA3 ingest burst, watch lag <30s
```
