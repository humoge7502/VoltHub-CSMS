# test:load — k6 smoke + soak (`k6-smoke.js`)

10→50 VUs over 10 min against discovery + contended reserves; gates NFR-03
(p95 <300ms) and NFR-04 (outbox lag bounded). `npm run test:load` skips
gracefully when k6 is not installed.
