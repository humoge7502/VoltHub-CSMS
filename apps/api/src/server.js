// VoltHub API entrypoint: Express REST + OCPP WS gateway on one port.
// Data layer: db/index.js seam — ORACLE_HOST set => Oracle write-through adapter over a
// hydrated local read-cache; otherwise the local test double (see ADR-0005).
'use strict';
const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const pino = require('pino');
const { createStore } = require('./db/store');
const { seedStore } = require('./db/seed');
const routes = require('./routes');
const extended = require('./extended');
const { mountOcpp } = require('./ocpp/gateway');
const { securityHeaders, throttle } = require('./middleware/security');

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const store = createStore();
global.__store = store; // legacy fallback for signAccess callers that don't inject (see TD-07)
store._mode = 'local';
if ((process.env.SEED_PROFILE || 'demo') !== 'empty') seedStore(store, process.env.SEED_PROFILE || 'demo');

// Background Oracle upgrade (non-blocking so require('../src/server') stays sync for tests).
// When ORACLE_HOST is set: hydrate Maps from Oracle, then wrap money-path methods with
// package calls (row locks enforced in the DB). Health reports the transition.
// B2G-007: sourced through db/index.js:upgradeStore() — the ADR-0005 seam, single truth.
if (process.env.ORACLE_HOST) {
  store._mode = 'oracle-connecting';
  (async () => {
    try {
      const { upgradeStore } = require('./db/index');
      await upgradeStore(store, log);
    } catch (e) {
      store._mode = 'local-fallback';
      store._oracleError = e.message;
      log.warn({ err: e.message }, 'oracle unavailable — running on local store');
    }
  })();
}

const app = express();
// SEC-010: no framework fingerprint on responses (Express sets X-Powered-By by default).
app.disable('x-powered-by');
// BUG-023: behind the documented Caddy deploy profile every request arrived with the
// proxy's IP, so the per-IP login throttle (10/min) collapsed into a platform-wide
// login outage. Trusting the proxy is OPT-IN (TRUST_PROXY=1 trusts one hop, or pass
// a value like `loopback` for Caddy on the same host); default stays untrusted.
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : process.env.TRUST_PROXY);
app.use(cors({ origin: (process.env.WEB_ORIGIN || 'http://localhost:3000').split(',') }));
app.use(securityHeaders);
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  req.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  res.setHeader('x-request-id', req.id);
  req.log = log;
  next();
});
// standard error envelope: every {error} payload carries requestId
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (b) => {
    if (b && b.error && !b.error.requestId) {
      try {
        b.error.requestId = req.id;
      } catch {
        /* frozen */
      }
    }
    return json(b);
  };
  next();
});
app.use(throttle);
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    req.log.info({ id: req.id, m: req.method, p: req.path, s: res.statusCode, ms: Date.now() - t0 }, 'req');
    try {
      require('./observability').observe(res.statusCode, Date.now() - t0);
    } catch {}
  });
  next();
});
app.use('/api/v1', routes(store));
app.use('/api/v1', extended(store));
app.get('/', (req, res) => res.json({ name: 'volthub-csms', health: '/api/v1/health', openapi: '/api/v1/docs' }));
// eslint-disable-next-line no-unused-vars
app.use((e, req, res, next) => {
  const status = e.status || 500;
  // §11: log stack for 5xx only (pino).
  if (status >= 500) log.error({ err: e.message, code: e.code, stack: e.stack }, 'unhandled');
  else log.error({ err: e.message, code: e.code }, 'unhandled');
  res
    .status(status)
    .json({ error: { code: e.code || 'INTERNAL', message: e.message || 'internal', requestId: req.id } });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  let path = '';
  try {
    path = new URL(req.url, 'http://localhost').pathname;
  } catch {
    /* keep */
  }
  if (/^\/ocpp\/.+/.test(path)) wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});
const __ocppRegistry = mountOcpp(wss, store, log);
global.__ocppRegistry = __ocppRegistry;

const PORT = Number(process.env.PORT || process.env.API_PORT || 4000);
if (require.main === module) {
  server.listen(PORT, () =>
    log.info(`volthub api on :${PORT} (mode: ${store._mode}, sessions: ${store.sessions.size})`)
  );
  // Graceful shutdown (BUG-022 companion): SIGTERM/SIGINT stop accepting new
  // connections, close OCPP charge-point sockets, drain in-flight requests, then
  // exit — compose's stop_grace_period (15 s) sits above the 10 s failsafe so a
  // hung request cannot turn `docker compose stop` into a mid-ack kill.
  const drain = (sig) => {
    log.info({ sig }, 'shutting down — draining in-flight requests');
    const failsafe = setTimeout(() => {
      log.warn('drain timeout — forcing exit');
      process.exit(0);
    }, 10000);
    failsafe.unref?.();
    try {
      for (const ws of global.__ocppRegistry?.values?.() || []) {
        try {
          ws.close(4401, 'server shutdown');
        } catch {}
      }
    } catch {}
    server.close(() => {
      log.info('drained — bye');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => drain('SIGTERM'));
  process.on('SIGINT', () => drain('SIGINT'));
}
module.exports = { app, server, store };
