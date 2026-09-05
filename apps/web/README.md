# @volthub/web — Next.js 14 + Grid Current design system

App Router, dark-only ops surfaces. Tokens in `src/app/globals.css`
(`#0B0E11` carbon, `#FFFDD0` cream, `#C6F24E` lime; Space Grotesk / Inter /
IBM Plex Mono tabular numerals). RSC-style reads with client islands: session
live view polls 5s, availability 15s, telemetry 10s; keyset pagination on history;
inline-SVG charts + schematic corridor map (zero paid tile keys).

Routes: `/` `/login` `/signup` `/discover` `/stations/[id]` `/reservations`
`/session/[id]` `/history` `/invoices` `/profile` `/notifications`
`/dashboard` `/analytics` `/faults` `/telemetry` `/admin`.

```bash
npm install && NEXT_PUBLIC_API_BASE=http://localhost:4000/api/v1 npm run dev
npm run build   # 18 routes, must stay green
```
