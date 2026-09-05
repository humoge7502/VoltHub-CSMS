# test:api — 16 supertest-style journey tests (`apps/api/test/run.js`)

Register → discover → reserve → overlap-409 → idempotency replay →
lifecycle → meter-guard → bill-once → pay (+double-pay 409) → RBAC →
health → docs/tariffs → state-matrix guard → reviews → notifications →
vehicle-default → admin hardware RBAC. Ephemeral port 4101, no Docker needed.
