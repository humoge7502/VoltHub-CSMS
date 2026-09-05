// VoltHub API entrypoint: Express REST + OCPP WS gateway on one port.
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
global.__store = store;
seedStore(store, process.env.SEED_PROFILE || 'demo');

const app = express();
app.use(cors({ origin: (process.env.WEB_ORIGIN || 'http://localhost:3000').split(',') }));
app.use(securityHeaders);
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => { req.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; res.setHeader('x-request-id', req.id); next(); });
// standard error envelope: every {error} payload carries requestId
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (b) => {
    if (b && b.error && !b.error.requestId) { try { b.error.requestId = req.id; } catch { /* frozen */ } }
    return json(b);
  };
  next();
});
app.use(throttle);
app.use((req, res, next) => { log.info({ id: req.id, m: req.method, p: req.path }, 'req'); next(); });
app.use('/api/v1', routes(store));
app.use('/api/v1', extended(store));
app.get('/', (req, res) => res.json({ name: 'volthub-csms', health: '/api/v1/health', openapi: '/api/v1/docs' }));
// eslint-disable-next-line no-unused-vars
app.use((e, req, res, next) => {
  const status = e.status || 500;
  log.error({ err: e.message, code: e.code }, 'unhandled');
  res.status(status).json({ error: { code: e.code || 'INTERNAL', message: e.message || 'internal', requestId: req.id } });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  let path = '';
  try { path = new URL(req.url, 'http://localhost').pathname; } catch { /* keep */ }
  if (/^\/ocpp\/.+/.test(path)) wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  else { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); }
});
mountOcpp(wss, store, log);

const PORT = Number(process.env.PORT || process.env.API_PORT || 4000);
if (require.main === module) {
  server.listen(PORT, () => log.info(`volthub api on :${PORT} (seed: ${store.sessions.size} sessions)`));
}
module.exports = { app, server, store };
