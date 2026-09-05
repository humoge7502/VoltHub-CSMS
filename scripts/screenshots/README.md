# Screenshot evidence capture (re-record anytime)

`capture.js` produces the README's screenshot strip + live-session GIF from the
**real running stack** — no mocks: a genuine OCPP 1.6J WebSocket charge point
drives `MeterValues` through the gateway into the store, and the browser polls
the same API you would. Ticks you see in `demo-live.gif` travelled that path.

## Prereqs

- API on `:4000` with the demo seed + CORS for the web origin:

  ```bash
  WEB_ORIGIN='http://localhost:3120,http://localhost:3000' npm run dev:api
  ```

- Web console on `:3120` (dev or prod both work — CSP is env-aware):

  ```bash
  cd apps/web && npx next dev -p 3120
  ```

- Tool deps (isolated from the monorepo — not part of root `npm ci`):

  ```bash
  cd scripts/screenshots && npm install
  ```

## Run

```bash
node scripts/screenshots/capture.js    # → ../docs/screenshots/{dashboard,telemetry,invoice,live-session}.png + gif-frames/
node scripts/screenshots/make-gif.js   # → ../docs/screenshots/demo-live.gif (8 frames, 1.1 s each)
```

Needs a Playwright browser once: `npx playwright install chromium` (uses
`~/.cache/ms-playwright`, shared with the workspace default).

## Notes / gotchas (learned the hard way)

- The second demo session must run on a **different charge point** than the
  first. Two sockets under one OCPP identity trip the gateway's
  duplicate-connection guard (`OCPP 1.6J §4`), which closes the first socket —
  symptom: `ocpp timeout MeterValues`.
- CSP lives in `apps/web/next.config.js`; it must keep `script-src 'unsafe-inline'`
  (Next inlines its RSC bootstrap) or the console never hydrates — verify with a
  real browser after touching it.
