# @volthub/web — Next.js 16 + Grid Current design system

App Router, dark-only ops surfaces. Tokens in `src/app/globals.css`
(`#0B0E11` carbon, `#FFFDD0` cream, `#C6F24E` lime; Space Grotesk / Inter /
IBM Plex Mono tabular numerals; spacing/type/motion scales). Home and login
are server-rendered; client islands poll: session live view 5s, availability
15s, telemetry 10s; keyset pagination on history; inline-SVG charts +
schematic corridor map (zero paid tile keys); native `<dialog>` replaces
`window.confirm`/`prompt`; navigation groups driver vs operator routes with a
keyboard-friendly mobile drawer.

Routes: `/` `/login` `/signup` `/discover` `/stations/[id]` `/reservations`
`/session/[id]` `/history` `/invoices` `/profile` `/notifications`
`/dashboard` `/analytics` `/faults` `/telemetry` `/admin`.

```bash
npm install && NEXT_PUBLIC_API_BASE=http://localhost:4000/api/v1 npm run dev
npm run build   # 19 routes, must stay green
```
