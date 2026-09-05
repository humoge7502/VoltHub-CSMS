# PATCHES.md — Exact fixes for Audit Round-2 findings (B2G register)

Each patch below is copy-pasteable. Order matters only for verification, not application.
Every patch ends with its **verification command**. Apply one conventional commit per patch,
e.g. `fix(B2G-001): arm Timescale relay in compose worker`.

---

## B2G-001 (P0) — Arm the Timescale relay in the full-stack demo

**File: `infra/docker-compose.yml`** → `worker:` service. Replace the `environment:` block:

```yaml
worker:
  build: { context: .., dockerfile: apps/api/Dockerfile }
  container_name: volthub-worker
  command: ['node', 'apps/worker/src/index.js']
  environment:
    API_BASE: http://api:4000/api/v1
    TS_HOST: timescale
    TS_PORT: '5432'
    TS_DB: volthub
    TS_USER: volthub
    TS_PASSWORD: volthub_dev_pwd
  depends_on:
    api: { condition: service_started }
    timescale: { condition: service_healthy }
```

**File: `apps/api/Dockerfile`** → ensure `pg` is installed for the worker (it's an
optionalDependency of `@volthub/worker` but the api image runs it). Add before `CMD`:

```dockerfile
RUN npm install --no-audit --no-fund --omit=dev pg
```

Also pin the Timescale image (same file, `timescale:` service): replace
`timescale/timescaledb:latest-pg16` with `timescale/timescaledb:2.17.2-pg16` (or any dated tag).

**Verify:**

```bash
docker compose -f infra/docker-compose.yml up -d --build
node apps/simulator/src/index.js --scenario burst --chargers 4
docker compose -f infra/docker-compose.yml exec timescale \
  psql -U volthub -c "SELECT count(*), count(DISTINCT session_id) FROM meter_tick;"
# count > 0 AND Grafana (profile observability) shows the load curve
```

---

## B2G-002/003 (P0) — Ownership + role checks (OWASP API1/API5)

**File: `apps/api/src/middleware/auth.js`** — append one helper and export it:

```js
// B2G-002/003: object-level authorization. DRIVER must own the object;
// OPERATOR must own the station (via stationScope); ADMIN bypasses.
function requireOwned(store, kind) {
  return (req, res, next) => {
    if (req.user.role === 'ADMIN') return next();
    const id = Number(req.params.id);
    if (kind === 'session') {
      const s = store.sessions.get(id);
      if (!s) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'session' } });
      if (req.user.role === 'DRIVER' && s.user_id !== req.user.id)
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'not your session' } });
      if (req.user.role === 'OPERATOR') {
        const stationId = store.cps.get(Number(String(s.connector_ref).split(':')[0]))?.station_id;
        if (stationId && !(req.user.stationScope || []).includes(stationId))
          return res.status(403).json({ error: { code: 'OUT_OF_SCOPE', message: 'station not assigned' } });
      }
    }
    if (kind === 'invoice') {
      const inv = store.invoices.get(id);
      if (!inv) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'invoice' } });
      const sess = store.sessions.get(inv.session_id);
      if (req.user.role === 'DRIVER' && (!sess || sess.user_id !== req.user.id))
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'not your invoice' } });
      if (req.user.role === 'OPERATOR') {
        const stationId = sess && store.cps.get(Number(String(sess.connector_ref).split(':')[0]))?.station_id;
        if (stationId && !(req.user.stationScope || []).includes(stationId))
          return res.status(403).json({ error: { code: 'OUT_OF_SCOPE', message: 'station not assigned' } });
      }
    }
    next();
  };
}
```

(Add `requireOwned` to `module.exports`.)

**File: `apps/api/src/routes.js`** — three lines:

```js
r.get('/invoices/:id', authRequired, requireOwned(store, 'invoice'), safe(async (req, res) => { ... }));   // line ~203
r.post('/sessions/:id/bill', authRequired, requireOwned(store, 'session'), safe(...));                      // line ~187
r.post('/sessions/:id/remote-stop', authRequired, requireOwned(store, 'session'), safe(...));               // line ~164
r.get('/stations/:id/analytics', authRequired, roles('OPERATOR', 'ADMIN'), safe(...));                      // line ~252 (B2G-003a)
```

And for `POST /stations/:id/faults` (B2G-003b): add `roles('OPERATOR', 'ADMIN')`, and
**delete the connector state flip** (`store.connectors.get(f.connector_ref).status = 'FAULTED'`)
— operator-originated reports create the fault row; the connector flips only via
`maintenance_pkg.report_fault` in Oracle or an explicit operator state transition.

**File: `apps/api/test/security.js`** — append a test (pattern of TEST-SEC-AUTHZ5):

```js
await t('TEST-BOLA: cross-driver invoice read / remote-stop / bill are 403', async () => {
  // register driver2, create + bill a session as driver1, then probe with driver2's token:
  // GET  /invoices/:id        → 403
  // POST /sessions/:id/remote-stop → 403
  // POST /sessions/:id/bill   → 403
  // GET  /stations/:id/analytics (driver) → 403
});
```

**Verify:** `npm run test -w apps/api && node apps/api/test/security.js`

---

## B2G-004 (P1) — Pay-parity: invoice stays DUE, the _payment_ fails

**File: `apps/api/src/db/store.js`** — in `payInvoice`, replace the insufficient-funds branch:

```js
if (w.balance < inv.total) {
  const payment_id = ++s.seq.pay;
  s.payments.set(payment_id, {
    payment_id,
    invoice_id: Number(invId),
    amount: inv.total,
    method: 'WALLET',
    status: 'FAILED',
    reference: null,
    created_at: new Date().toISOString(),
  });
  // B2G-004: invoice stays DUE (matches Oracle rollback semantics) — the PAYMENT failed, not the invoice.
  throw (() => {
    const e = new Error('INSUFFICIENT_FUNDS');
    e.num = ORA.INSUFFICIENT_FUNDS;
    e.code = 'INSUFFICIENT_FUNDS';
    e.status = 402;
    return e;
  })();
}
```

**File: `db/oracle/V003__packages.sql`** — in `billing_pkg.pay_invoice`, delete the line
`UPDATE invoice SET status = 'FAILED' WHERE invoice_id = p_invoice;` (keep the FAILED
payment insert + the raise; the raise already rolls back, so both engines now converge:
FAILED payment, DUE invoice). Re-run migration.

**Test (both engines):** pay → 402 + a FAILED payment row; top up; pay again → 201 + invoice PAID.
Add to `apps/api/test/xlayer.js`.

**Verify:** `npm run test -w apps/api && STORE=oracle npm run test -w apps/api`

---

## B2G-005 (P1) — Hydrate the transactional world + durable outbox acks

**File: `apps/api/src/db/oracle.js`** — extend `hydrate()`'s table list (same best-effort `q()` pattern):

```js
await q(
  `SELECT reservation_id, connector_ref, user_id, vehicle_id, start_at, end_at, status,
         TO_CHAR(created_at,'YYYY-MM-DD"T"HH24:MI:SS') c FROM reservation`,
  'reservations',
  (r) => {
    local.reservations.set(Number(r.RESERVATION_ID), {
      reservation_id: Number(r.RESERVATION_ID),
      connector_ref: r.CONNECTOR_REF,
      user_id: Number(r.USER_ID),
      vehicle_id: r.VEHICLE_ID ? Number(r.VEHICLE_ID) : null,
      start_at: new Date(r.START_AT).toISOString(),
      end_at: new Date(r.END_AT).toISOString(),
      status: r.STATUS,
      created_at: r.C,
    });
    local.seq.res = Math.max(local.seq.res, Number(r.RESERVATION_ID));
  }
);
// same pattern: charging_session (advances seq.sess), meter_reading, invoice (seq.inv),
// invoice_line, payment, wallet_ledger, fault (seq.fault), notification, outbox_event (seq.outbox)
```

**File: `apps/api/src/routes.js`** — in `POST /internal/outbox/ack`, when pooled, also mark Oracle:

```js
r.post(
  '/internal/outbox/ack',
  requireInternal,
  safe(async (req, res) => {
    const ids = (req.body.ids || []).map(Number);
    ids.forEach((id) => {
      const e = store.outbox.find((x) => x.event_id === id);
      if (e) e.processed_at = new Date().toISOString();
    });
    if (store._pool && ids.length) {
      const c = await store._pool.getConnection();
      try {
        await c.execute(
          `UPDATE outbox_event SET processed_at = SYSTIMESTAMP WHERE event_id IN (${ids.map((_, i) => `:id${i}`).join(',')})`,
          Object.fromEntries(ids.map((v, i) => [`id${i}`, v]))
        );
        await c.commit();
      } finally {
        try {
          await c.close();
        } catch {}
      }
    }
    res.json({ ok: true });
  })
);
```

**Verify:** with compose up → create reservation/session/invoice → `docker compose restart api` →
`GET /reservations` still returns rows; `SELECT count(*) FROM outbox_event WHERE processed_at IS NULL` → 0.

---

## B2G-006 (P1) — Sink dedupe key = pipeline dedupe key

**File: `db/timescale/T001__hypertables.sql`** — replace `meter_tick` PK with sequence-aware key:

```sql
CREATE TABLE IF NOT EXISTS meter_tick (
  ts TIMESTAMPTZ NOT NULL,
  session_id INTEGER NOT NULL,
  seq_no BIGINT NOT NULL DEFAULT 0,
  connector_ref TEXT NOT NULL,
  meter_kwh DOUBLE PRECISION NOT NULL,
  power_kw DOUBLE PRECISION,
  voltage_v DOUBLE PRECISION,
  current_a DOUBLE PRECISION,
  dedupe_key TEXT,
  PRIMARY KEY (session_id, seq_no, ts)
);
```

(For an existing DB: `ALTER TABLE meter_tick ADD COLUMN IF NOT EXISTS seq_no BIGINT NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS dedupe_key TEXT;` then recreate as above on fresh volumes.)

**File: `apps/worker/src/relay-timescale.js`** — pass the two new columns through `toRows()`
(ticks row gains `p.seq ?? 0` and `e.dedupe_key`; column list gains `seq_no, dedupe_key`).

**Verify:** 10 MeterValues within one second → `SELECT count(*) FROM meter_tick WHERE session_id = X` = 10.

---

## B2G-010 (P1) — JWT alg pin + scopeCheck NaN + login throttle

```js
// auth.js + security.js: pin the algorithm at both verify sites:
const p = jwt.verify(tok, secret(), { algorithms: ['HS256'] });

// auth.js scopeCheck: reject NaN explicitly
const sid = Number(req.params.id || req.body.stationId || req.query.stationId);
if (!Number.isNaN(sid) && sid && !(req.user.stationScope || []).includes(sid)) { ... }

// security.js: add a LOGIN tier — key 'login:'+ip, limit 10/min, checked inside POST /auth/login
// (one extra window lookup before credential verification; return 429 with Retry-After).
```

## B2G-014 (P1) — Durable idempotency (sketch)

In `POST /reservations`, when `store._pool` exists: read `idempotency_key` by
`key_value = userId:ik` first; on hit, replay stored `status_code`/`response_body`;
on miss, after success insert the row (with `expires_at = now()+24h`). Keep the Map
as the fast path. Prune expired rows opportunistically in the worker sweep.

## B2G-013 (P1) — Reservation ownership at session start

`store.startSession` + `charge_session_pkg.start_session`: when `reservationId` is passed,
verify `reservation.user_id = uid` AND the reservation's `connector_ref` matches
`(cpId, connNo)` AND status is `BOOKED`, else raise `RESERVATION_MISMATCH` (use band
`-20505` → 409). Add the hijack probe to `security.js`.

## B2G-007/008/011/012 (P2) — Hygiene batch

1. Delete `apps/api/src/db/index.js` **or** make `server.js` call `getStore()`; delete the unused
   `pg-copy-streams` import in `relay-timescale.js`; fix the "COPY" comments.
2. SECURITY.md: fail-fast claim → `NODE_ENV=production` only (or extend the code to match the doc).
   README: "2 triggers only" → "4 triggers (2 state + 2 sync)". ADR-0003: sink dedupe wording → match B2G-006.
3. V002 views/MV: rewrite `LIKE cp_id||':%'` joins to `cs.cp_id = cp.cp_id AND cs.connector_no = c.connector_no`
   (columns exist since V005). `resolve_band_price`: add
   `ORDER BY CASE day_scope WHEN 'ALL' THEN 0 ELSE 1 END` before `FETCH FIRST 1 ROW ONLY`.
4. Community files: adopt `.eslintrc.json`, `.prettierrc`, `.nvmrc`, `.editorconfig`,
   `.github/dependabot.yml`, `.github/CODEOWNERS`, `.github/PULL_REQUEST_TEMPLATE.md`,
   `.github/ISSUE_TEMPLATE/*` from this kit; add the lint job from `ci-lint-addition.yml`.

## B2G-009 (P2) — CSMS→CP RemoteStopTransaction (sketch)

`gateway.js`: export `stopTransaction(registry, identity, sessionId)` that sends
`call(uid, 'RemoteStopTransaction', { transactionId })` over the stored socket.
`routes.js` remote-stop: after the store transition, look up the CP identity from the
session's connector and fire it (fire-and-forget; log failures). Simulator: add a
`ws.on('message')` branch that answers `RemoteStopTransaction` by sending `StopTransaction`
for the given transactionId. WS test asserts the CP socket received the CALL.
