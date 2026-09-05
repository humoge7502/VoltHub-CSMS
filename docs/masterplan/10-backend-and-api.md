# Part X — Backend Architecture and API Design

> Masterplan sections 18–19. The backend's job is to be _boring in the right way_: thin over the database, strict about validation, and transparent about errors — so the database remains the star.

---

## 18. Backend Architecture

### 18.1 Why Node + TypeScript (decision record)

**Decision:** NestJS 11 (Node 22 LTS) + `node-oracledb` + Zod, in a pnpm/Turborepo monorepo shared with the frontend.

**Alternatives:** Python/FastAPI (fastest to prototype, best data ecosystem); Java/Spring (enterprise credibility); Go (performance signal).

**Evaluation:** The backend is (1) a REST API whose real logic is PL/SQL, (2) a WebSocket OCPP server, (3) a small telemetry relay. Node excels at (2) — WebSocket is first-class — and the OCPP simulator is also Node, so one language covers API + gateway + simulator + relay. Shared TypeScript types between frontend and backend eliminate a whole class of drift bugs. `node-oracledb` is Oracle's own maintained driver with the thick-mode performance path. Python would be fine, but would fork the team's types and tooling; Spring's boilerplate-to-logic ratio is poor for a 3-person team.

**Reason:** fewest moving parts for exactly these three workloads, one language end-to-end, and the SQL/PL-SQL — which is the graded substance — lives in the database either way. The backend stays deliberately thin.

### 18.2 Module map (NestJS)

```
apps/api/src/
  app.module.ts
  modules/
    auth/          # Argon2 hashing, JWT issue/refresh, guards, RBAC decorator
    users/         # registration, profile, wallet endpoints
    stations/      # search, detail, availability (v_connector_live)
    reservations/  # calls RESERVATION_PKG; error -205xx mapped to 409/422
    sessions/      # live session view, history, remote-stop trigger
    billing/       # invoices, payments (calls BILLING_PKG), wallet topup
    ocpp/          # WebSocket gateway + charger registry + simulator control
    telemetry/     # DA3: TimescaleDB read endpoints for analytics
    admin/         # user/operator/station/tariff management, audit browser
    health/        # /health probing Oracle + TimescaleDB
packages/
  shared/          # zod schemas + TS types shared with Next.js
  ocpp-messages/   # typed OCPP 1.6J message models
apps/worker/       # outbox relay, expiry sweeper, notification dispatch
apps/simulator/    # charger fleet simulator CLI
```

### 18.3 The data-access pattern (database-first, deliberately)

```ts
// modules/reservations/reservations.service.ts
@Injectable()
export class ReservationsService {
  constructor(private readonly db: OracleService) {}

  async create(userId: number, dto: CreateReservationDto) {
    return this.db.callProcedure(
      `BEGIN reservation_pkg.create_reservation(
         :user_id, :vehicle_id, :cp_id, :connector_no, :start_at, :end_at, :res_id); END;`,
      {
        user_id: userId,
        vehicle_id: dto.vehicleId,
        cp_id: dto.cpId,
        connector_no: dto.connectorNo,
        start_at: dto.startAt,
        end_at: dto.endAt,
        res_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );
  }
}
```

Rules enforced across the codebase: **bind variables everywhere** (no string interpolation, ever — the SQLi posture is structural); reads use plain SQL with `FETCH FIRST` + bind pagination; writes go through packages; connections come only from the pool (`poolMin: 2, poolMax: 10`); every service method that spans multiple statements uses an explicit transaction object (`connection.executeMany` inside one commit) — though most writes are single package calls, which is the point.

### 18.4 Transaction boundaries and the OCPP gateway

The gateway (`ws` library) keeps one socket per charge point with a heartbeat; inbound OCPP calls map to package calls:

| OCPP message (charger → CSMS) | Handler → database effect                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| BootNotification              | upsert charge_point status ONLINE, last_boot_at                                                              |
| StatusNotification            | connector state update (guarded trigger path) + FAULT creation on error codes + outbox CONNECTOR_STATE event |
| Authorize                     | lookup id_tag (user's), respond Accepted/Invalid                                                             |
| StartTransaction              | CHARGE_SESSION_PKG opens session (state PREPARING→CHARGING on first meter)                                   |
| MeterValues                   | CHARGE_SESSION_PKG.record_meter_tick (billing row + outbox event)                                            |
| StopTransaction               | CHARGE_SESSION_PKG.transition COMPLETED, end meter frozen                                                    |
| Heartbeat                     | refresh last_seen                                                                                            |

The gateway sets `CLIENT_IDENTIFIER = 'ocpp-gw'` on its pooled connections — the connector-guard trigger (15.5) distinguishes protocol-driven state changes from any other path. A malicious or buggy client cannot set connector states by calling the REST API; the API has no endpoint that does.

### 18.5 Error handling contract

Business errors surface as numbered ORA errors from packages; the API maps them deterministically:

| Package code  | HTTP | Client meaning                          |
| ------------- | ---- | --------------------------------------- |
| -20501        | 422  | invalid reservation window              |
| -20502        | 409  | connector not bookable                  |
| -20503        | 409  | window overlaps an existing reservation |
| -20601        | 409  | illegal session transition              |
| -20703/-20704 | 409  | billing state conflict                  |
| -20705        | 402  | insufficient wallet balance             |

Unknown ORA errors log with request ID and return a 500 envelope without internals. The error envelope is uniform:

```json
{
  "error": {
    "code": "RESERVATION_OVERLAP",
    "message": "Connector already reserved for the requested window",
    "detail": { "connectorRef": "17:2", "window": ["2026-11-02T18:00+05:30", "2026-11-02T18:45+05:30"] }
  },
  "requestId": "req_9f3a"
}
```

### 18.6 Cross-cutting

**Logging:** pino JSON logs; every request gets `requestId` (also sent to Oracle as `CLIENT_IDENTIFIER` info via DBMS_APPLICATION_INFO — module/action set per service call, visible in `V$SESSION`; a nice observability-to-database bridge worth a demo aside). **Validation:** Zod schemas shared with the frontend; DTOs never trusted. **Idempotency:** mutating POSTs accept an `Idempotency-Key` header stored in an `idempotency_keys` table with the response hash for 24h — duplicate retries replay the recorded response. **Rate limiting:** token-bucket at the gateway (60 req/min per user, 120 for operator dashboards) via `nestjs-throttler`; the OCPP gateway limits 10 msg/s per charge point. **Documentation:** NestJS OpenAPI plugin emits `/docs` from decorators.

---

## 19. API Design

### 19.1 REST vs GraphQL (decision record)

**Decision:** REST + OpenAPI.

**Alternatives:** GraphQL; gRPC.

**Evaluation:** GraphQL would ease dashboard over-fetching, but every resolver would still call the same views; it adds an unfamiliar failure surface (N+1 into Oracle) and weakens the "SQL is the contract" story. gRPC solves a cross-team problem we do not have.

**Reason:** REST keeps resource boundaries aligned with tables/views, OpenAPI gives free docs, and the frontend's data needs are predictable. GraphQL is listed as a stretch add-on only if time remains (Section 6.3).

### 19.2 Endpoint catalog (representative, RBAC in parentheses)

```
POST   /auth/register                    (public)      POST /auth/login                    (public)
POST   /auth/refresh                     (public)      GET  /me                            (any)
GET    /me/wallet                        (driver)      POST /me/wallet/topup               (driver)
GET    /me/vehicles  POST /me/vehicles   (driver)      PATCH /me/vehicles/:id              (owner)
GET    /stations?q&std&minKw&lat&lng&radius&page       (any)
GET    /stations/:id                     (any)         GET  /stations/:id/connectors/live  (any)
POST   /reservations                     (driver)      GET  /reservations?status=          (owner/operator)
POST   /reservations/:id/cancel          (owner)       GET  /sessions/active/:connectorRef (any)
GET    /sessions/:id/live                (owner)       POST /sessions/:id/remote-stop      (owner/operator)
GET    /sessions?userId&from&to&cursor   (owner/op)    GET  /invoices/:id                  (owner)
POST   /invoices/:id/pay                 (driver)      GET  /invoices?status=DUE           (driver)
POST   /stations/:id/faults              (operator)    POST /faults/:id/maintenance        (operator)
PATCH  /maintenance/:id/complete         (operator)    GET  /stations/:id/analytics        (operator)
GET    /telemetry/load-curve?station&from&to&bucket=5m   (operator, DA3)
GET    /telemetry/utilization-heatmap?day&station        (operator, DA3)
POST   /admin/users  PATCH /admin/users/:id            (admin)
POST   /admin/tariff-plans               (admin)       GET  /admin/audit-logs              (admin)
GET    /health                           (public)
```

### 19.3 Conventions

**Pagination:** cursor-based (`?cursor=<opaque>` returning `nextCursor`), built on the keyset pattern of Q15; OFFSET exists only on admin tables <= 1k rows. **Filtering:** allow-listed params mapped to bind variables — never dynamic SQL. **Sorting:** allow-listed (`sort=started_at`, `order=desc`); arbitrary sort columns are rejected by the same Zod schema. **Versioning:** `/api/v1` prefix; additive-change policy documented. **Errors:** Section 18.5 envelope.

### 19.4 Representative endpoint spec — POST /reservations

```yaml
POST /api/v1/reservations
security: [ bearerAuth: [] ]        # role: DRIVER
request:
  body:
    cpId: 17
    connectorNo: 2
    vehicleId: 304
    startAt: "2026-11-02T18:00:00+05:30"
    endAt:   "2026-11-02T18:45:00+05:30"
  headers: { Idempotency-Key: "8f6c1a" }
responses:
  201:
    body: { reservationId: 5012, status: "BOOKED",
            connector: { ref: "17:2", standard: "CCS2", maxPowerKw: 60 },
            expiresContext: "converts on plug-in, or EXPIRED after end_at" }
  409: { error: { code: "RESERVATION_OVERLAP", ... } }
  409: { error: { code: "CONNECTOR_NOT_BOOKABLE", ... } }
  422: { error: { code: "INVALID_WINDOW", ... } }
notes:
  - validation: Zod (shape) -> DB CHECKs (range) -> package (business)
  - the 409 overlap case is THE demo moment (Section 38)
```

### 19.5 Rate limits, security headers, CORS

Helmet sets HSTS/CSP frame-ancestors/no-sniff; CORS allow-lists the web origin; API rate limits per Section 18.6; JWTs expire in 15 min with rotating refresh (hashed in Oracle). Full security design: Section 30 (file `15-security-concurrency-performance.md`).
