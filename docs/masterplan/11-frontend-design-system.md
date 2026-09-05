# Part XI — Frontend Architecture and the Grid Current Design System

> Masterplan sections 20–21. The frontend's mission: a data-dense engineering product that looks *authored*. This file defines the architecture and a complete, opinionated design system — and an explicit list of the "vibe-coded" patterns it refuses.

---

## 20. Frontend Architecture

### 20.1 Stack and structure (decision record)

**Decision:** Next.js 15 (App Router, TypeScript), Tailwind CSS v4, lucide-react icons, Recharts for charts, MapLibre GL JS with the free CARTO Positron/Dark Matter style for maps, TanStack Query for client-side live data.

**Alternatives:** Vite+React SPA (no SSR; fine but loses streaming/metadata); Astro (what acmvit.in uses — excellent for content sites, wrong for a live application with auth-boundary complexity); MUI/AntD (would make it look like a template instantly); Mapbox (API-key cost); Leaflet (raster tiles, no smooth dark basemap).

**Evaluation:** the app is auth-gated, data-heavy, and chart/map-intense. App Router gives server components for cheap first paints of read-heavy pages (station discovery, dashboards) and clean secret-keeping; TanStack Query handles the live session and connector polling with cache coherence. Tailwind v4's tokens map 1:1 to the design system below. MapLibre + CARTO's free style gives a genuinely dark map without keys.

**Reason:** matches the team's fluency (Section: user chose Fluent), minimizes glue code, and every choice is defensible as a fit — not a fashion choice.

```
apps/web/src/
  app/
    (marketing)/page.tsx           # public landing: hero, live network stats (RSC)
    (driver)/
      discover/page.tsx            # map + list, server-rendered initial viewport
      stations/[id]/page.tsx       # station detail, RSC + client availability strip
      reservations/page.tsx        # my bookings
      session/[id]/page.tsx        # LIVE charging view (client island)
      history/page.tsx  invoices/page.tsx  profile/page.tsx
    (operator)/
      dashboard/page.tsx           # station home: KPI cards + connector grid
      analytics/page.tsx           # revenue/energy/utilization (charts)
      faults/page.tsx  maintenance/page.tsx
      telemetry/page.tsx           # DA3 live load curves + heatmap
    (admin)/
      overview/page.tsx  users/page.tsx  stations/page.tsx
      tariffs/page.tsx  audit/page.tsx
  components/ui/                   # design-system primitives (button, card, table, pill, input...)
  components/charts/  components/map/
  lib/                             # api client, query keys, formatters (INR, kWh, tabular)
```

### 20.2 Rendering boundaries (the rule)

Server components own everything that is a **read of current truth** (station lists, invoice tables, audit logs). Client islands own only **live or interactive** surfaces: the session view (5s polling), connector availability strip (15s polling), charts with brush/filter, the map. This keeps the JS bundle small and — a point for the viva — mirrors OLTP/OLAP separation: RSC fetches via server pool; live islands hit thin aggregate endpoints backed by materialized views (DA2) or Timescale caggs (DA3).

### 20.3 Data fetching contract

- RSC: direct calls to typed server clients (`lib/api/server.ts`) with `revalidate` tuned per route (discovery 15s, history 0 = dynamic with cookies).
- Client: TanStack Query with query-key factories (`['connector-live', stationId]`), staleTime matching poll cadence, and optimistic updates only for reservation cancel.
- Real-time options: polling first (honest, zero infra); SSE endpoint (`/sessions/:id/stream`) as a stretch — do not claim WebSocket-to-browser unless built.

---

## 21. UI/UX Design System — "Grid Current"

### 21.1 Identity statement

Grid Current is the interface of electrical infrastructure: precise, instrument-like, calm. It borrows acmvit.in's *discipline* — typography carries the design, near-monochrome with one warm accent, hairline structure, scale through size not ornament [25] — and re-expresses it for an operations product. Where ACM VIT is a poster, VoltHub is a control room.

### 21.2 Design tokens

**Palette (dark-only for operator/admin; driver app shares tokens with light variants deferred):**

| Token | Value | Use |
|---|---|---|
| `bg` | `#0B0E11` | app background (carbon) |
| `surface-1` | `#11151A` | cards, panels |
| `surface-2` | `#171C23` | raised: dropdowns, popovers |
| `surface-3` | `#1F2630` | highest: modals, tooltips |
| `border-hairline` | `rgba(255,255,255,0.08)` | default 1px borders |
| `border-strong` | `rgba(255,255,255,0.16)` | interactive borders/hover |
| `text-primary` | `#E8EAED` | body text (never pure white) |
| `text-secondary` | `#9AA3AD` | labels, meta |
| `text-muted` | `#5C6670` | disabled, timestamps |
| `accent-cream` | `#FFFDD0` | brand: display headings, primary CTA fill w/ carbon text (the acmvit nod) |
| `accent-lime` | `#C6F24E` | live data highlights: active session kWh, "charging now" |
| `status-available` | `#3ECF8E` | connector AVAILABLE |
| `status-occupied` | `#E8A13C` | OCCUPIED/CHARGING |
| `status-reserved` | `#7B8CFF` | RESERVED |
| `status-fault` | `#E5484D` | FAULTED/FAILED |
| `status-offline` | `#5C6670` | OFFLINE/UNAVAILABLE |

*The three surface steps are deliberate: dark data-dense UIs bleed when panels share one background [26]. Charts use status colors only for status; data series use lime + cream + a desaturated blue `#6E96B8` — never rainbow.*

**Typography:**

| Role | Font | Specs |
|---|---|---|
| Display (page heroes, section titles) | Space Grotesk 700 | uppercase, `tracking-tight (-0.02em)`, clamp(2rem, 6vw, 5.5rem), leading 0.95 — the acmvit-style scale move, applied sparingly |
| UI (body, controls) | Inter 400/500/600 | 14px base, 1.5 line-height, sentence case |
| Data numerals | IBM Plex Mono 500 | `font-variant-numeric: tabular-nums`, used for kWh, INR, kW, timestamps — every number in the product is monospaced |
| Micro-labels | Inter 600 | 11px, uppercase, `tracking-widest (0.08em)`, `text-secondary` — the instrument-label voice |

**Spacing & shape:** 4px base grid; component padding 12/16/24; section rhythm 48/64. **Radius:** 4px controls, 8px cards, 12px modals — *never* pill-shaped cards or `rounded-3xl`. **Borders:** 1px hairline as the primary structural device; shadows only on `surface-2+` (`0 8px 24px rgba(0,0,0,.35)`). **Focus:** 2px `accent-cream` outline offset 2px on all interactives (accessibility is design, not decoration).

### 21.3 Core component specs

**KPI stat block:** micro-label (e.g. `ENERGY TODAY`), IBM Plex Mono 28px value with unit in 14px secondary, delta line (`+12.4% vs yesterday` with status-color arrow icon). Border hairline, `surface-1`, radius 8.

**Status pill:** 6px dot + 11px uppercase label; colors from the status tokens; pill background is the status color at 12% opacity, text at full — readable on any surface, never a filled candy chip.

**Connector grid (operator dashboard's signature):** dense grid of connector tiles (min 120px): connector ref in mono, standard code badge, power kW, status pill, last-change timestamp in `text-muted`. Selected tile gets `border-strong` + left 2px accent. This one component, done well, is the anti-generic proof.

**Data table:** sticky header, 40px rows, hairline row separators (no zebra), right-aligned tabular numerals, hover row `surface-2`, empty state = one-line message + primary action button. Sorting: chevron in header, aria-sort set.

**Charts (Recharts):** background transparent; grid = horizontal hairlines only; axis text 11px `text-muted` mono; series stroke 2px, no dots below 50 points; area fills at 10% opacity max; tooltips on `surface-3` with hairline border. Time axes in IST with explicit tz label.

**Map pins:** station pin = 24px circle, `surface-3` fill, hairline border, inner dot colored by *best available* connector status; selected pin scales 1.15 with cream ring. Cluster counts in mono. Popup = `surface-3` card: name, distance, connectors available count in mono, "Reserve" ghost button.

**Forms:** labels above inputs (11px micro-label style), inputs `surface-1` + hairline, error text `status-fault` with the input border tinted — never color-only signaling (a11y). **Buttons:** primary = cream fill/carbon text (the brand move); secondary = hairline; destructive = fault color ghost. All 36px height, radius 4.

**States:** skeletons *match the final layout exactly* (no generic pulse-blocks); loading charts show the axes with a single 10%-opacity series; error states use a two-line pattern (what failed + retry action); empty states never show artwork-for-artwork's-sake.

**Motion:** 150–200ms, `ease-out`, only `opacity`/`transform`; status changes get a single 300ms background fade; **no** parallax, no entrance choreography, no floating blobs. Motion budget per screen: <= 2 animated properties.

### 21.4 Anti-vibe-coded checklist (enforced in code review)

| Refuse | Because | Instead |
|---|---|---|
| Glassmorphism / `backdrop-blur` panels | decoration cosplaying as depth; unreadable over maps | solid surface steps (21.2) |
| Gradient buttons/banners | "AI default" tell | flat cream CTA |
| Rounded-3xl everything | template look | 4/8/12 token radii |
| Emoji as icons | unprofessional in ops tooling | lucide, 1.5px stroke |
| Random shadows + glows | muddy dark UI | hairline borders, one shadow token |
| Inter-only typography with 3 fonts' vibes | no identity | Space Grotesk display + Plex Mono data |
| Numbers in proportional font | columns jitter, data feels fake | mono + tabular-nums everywhere |
| Centered-max-width "dashboard" | SaaS-on-rails look | 12-col dense grid, 1440 max, full-bleed map |
| 12 animations per screen | vibe-coded tell | motion budget (21.3) |
| Placeholder names ("Acme Charging") | instantly generic | VoltHub + Chennai-real seed data |

### 21.5 Accessibility & responsiveness

WCAG 2.1 AA targets: contrast >= 4.5:1 body / 3:1 large text and UI borders (token set verified); full keyboard nav with visible focus; aria-live on session cost updates; map has a list-mode fallback (also the mobile pattern). Mobile: driver flows are the priority (discovery map full-bleed, bottom sheet station detail, session view one-thumb); operator/admin desktop-first with a functional 768px collapse (connector grid to 2-col, tables to card-lists). The marketing landing page (public) carries the big-type acmvit energy: 8rem clamp display headline, live network counters in mono, one full-bleed map section.
