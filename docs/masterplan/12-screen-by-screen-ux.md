# Part XII — Screen-by-Screen UX

> Masterplan section 22. Each screen: purpose, primary components (from the 21.3 library), data sources, and states. The cut-list at the end defines what drops first when time runs short — decided _now_, not at 2 AM before the demo.

---

## 22.1 Driver screens

**D1 — Login / Signup.** Purpose: frictionless entry. Components: split layout — left = Space Grotesk display headline + live network counters (mono, from `/health`-adjacent public stats), right = form card. States: field-level validation errors, auth error line, disabled submit while pending. _Essential._

**D2 — Discover (map + list).** Purpose: find a station now. Components: full-bleed MapLibre map (dark CARTO style), search input with debounced query, filter chips (connector standard, min kW, available-only), station list synchronized with map bounds; pin = 21.3 spec. Data: `GET /stations` RSC for first paint, client refetch on pan. States: empty radius ("No stations here — widen the filter"), location-permission prompt, map tile failure fallback to list mode. _Essential._

**D3 — Station detail.** Purpose: decide and book. Components: header (name, distance, avg rating), connector availability strip — one tile per connector with live status (15s poll), amenities row, tariff preview ("₹12.50/kWh peak · ₹9.00 off-peak" from active bands), mini map, Reserve CTA opening the booking sheet (connector picker + 15/30/45/60/90/120-min slots + vehicle picker, validation messages inline). States: sold-out connector tiles disabled with timestamps of next known reservation; station offline banner. _Essential._

**D4 — Reservations (my bookings).** Purpose: manage upcoming holds. Components: table/cards with status pill, countdown to window start, cancel action (optimistic), convert-context hint ("plug in at the station to start"). States: empty ("No upcoming reservations" + CTA), expired shown in muted history section. _Essential._

**D5 — Live session view (signature screen).** Purpose: make charging feel real and informative. Components: big mono readouts — current kW (updates per meter tick), session kWh, elapsed time, running cost (computed client-side from band price + session fee for display; server invoice remains truth), a 60-point rolling power chart (Recharts line, lime), connector + station line, Stop charging (remote-stop) with confirm dialog. States: preparing (plug-in prompt), suspended (EV full/paused), failed (reason + "what now" guidance), completed (invoice card + pay action). Polls 5s; `aria-live` announces cost every minute. _Essential — the demo's emotional peak._

**D6 — History.** Purpose: trust and expense tracking. Components: keyset-paginated table (Q15): date, station, kWh (mono), duration, cost, invoice status; row click → invoice detail (itemized lines). Filters: date range, station. States: skeleton rows matching table shape. _Essential._

**D7 — Invoices & wallet.** Purpose: pay and top up. Components: due-invoices worklist, invoice detail with line items, Pay button (disabled reasons shown), wallet card (balance mono + top-up modal with preset amounts). States: insufficient-funds path with top-up CTA (the -20705 story made humane), payment-failed banner with retry. _Essential._

**D8 — Profile & vehicles.** Purpose: manage vehicles (make/model/battery/connector standards multi-select) and default vehicle. _Build minimal; essential only because reservations need vehicles._

**D9 — Station reviews.** Folded into D3 (review composer on completed sessions) — _not a separate screen_ (scope discipline).

## 22.2 Operator screens

**O1 — Operator dashboard (home).** Purpose: 10-second situational awareness per station. Layout: KPI row (Active sessions, Available now, Energy today, Revenue today — Q26 in one round-trip), connector grid (the signature component), active-sessions table (station, connector, driver masked, started, kW), open-faults feed. DA3 addition: live load-curve strip (5-min buckets from caggs) pinned top-right. _Essential._

**O2 — Station analytics.** Purpose: trends and comparison. Components: date-range picker (7/30/90d), revenue + energy dual chart (from `mv_station_daily`), utilization table with rank (Q10), connector reliability league (Q17), peak-hours bar (Q9). _Essential for DA2 viva; DA3 chart section upgrade optional._

**O3 — Faults & maintenance.** Purpose: run the repair loop. Components: open-fault queue (age-sorted, response-SLA tint), fault detail (connector, code, recent sessions at that connector), create-maintenance form (type, description, parts cost), complete action → connector restore preview ("will set AVAILABLE"). States: guard against completing without resolution notes. _Essential._

**O4 — Live telemetry (DA3 showcase).** Purpose: prove the TimescaleDB slice. Components: network load curve (1-min buckets, gap-filled), station selector, utilization heatmap (day x hour, 3-color ramp: carbon → cream → lime), per-connector power traces with LTTB downsampling, "today vs 7-day-average" overlay. _Essential for DA3 demo; build against caggs from day one._

## 22.3 Admin screens

**A1 — System overview.** Network KPIs (users, stations, sessions 30d, revenue MTD), growth chart. _Essential (single screen)._
**A2 — Users & operators.** Table with role filter, suspend/activate actions (audit-logged), operator assignment to stations. _Essential._
**A3 — Stations & hardware.** CRUD with map picker, charge point + connector management, OCPP identity provisioning for the simulator. _Essential._
**A4 — Tariff management.** Version list per plan group with timeline, band editor (day-scope + time ranges + price), create-new-version flow (never edit-active — BR-09 enforced in UI), validity preview. _Essential — one of the strongest viva screens._
**A5 — Audit log browser.** Filterable (entity, actor, action), JSON diff viewer old→new. _Essential (single screen)._

## 22.4 Information architecture rules

Driver nav: Discover / Reservations / Session / History / Wallet / Profile (6 items, bottom-tab on mobile). Operator nav: Dashboard / Analytics / Faults / Telemetry. Admin nav: Overview / Users / Stations / Tariffs / Audit. Role switch is re-auth (cleaner RBAC story).

## 22.5 Cut-list (in order, when time is short)

1. Drop: SSE live push (keep polling) — invisible to graders.
2. Drop: D9 reviews UI (keep schema + API — report can show data).
3. Drop: analytics date-picker beyond presets; keep 7/30/90d.
4. Simplify: admin station CRUD to forms-only (map picker last).
5. Keep to the end: D5 live session, O1 connector grid, O4 telemetry, A4 tariff versioning, and the race-condition demo — these carry the wow-moments (Section 37).
