// Minimal in-process metrics ring (§11.4): 6 gauges for /metrics + Grafana.
// No exporter zoo — Prometheus text exposition only.
'use strict';
const N = 500;
const lat = [];
let reqs = 0,
  errs = 0;
function observe(status, ms) {
  reqs++;
  if (status >= 500) errs++;
  lat.push(ms);
  if (lat.length > N) lat.shift();
}
function p95() {
  if (!lat.length) return 0;
  const s = [...lat].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}
function render(store) {
  const outbox = store ? store.outbox.filter((e) => !e.processed_at).length : 0;
  const cps = (() => {
    try {
      return [...store.cps.values()].filter((c) => c.status === 'ONLINE').length;
    } catch {
      return 0;
    }
  })();
  const sessions = (() => {
    try {
      return store.sessions.size;
    } catch {
      return 0;
    }
  })();
  const pool = store?._pool ? 1 : 0;
  return (
    [
      '# HELP volthub_requests_total Total API requests since boot',
      '# TYPE volthub_requests_total counter',
      `volthub_requests_total ${reqs}`,
      '# HELP volthub_errors_total Total 5xx since boot',
      '# TYPE volthub_errors_total counter',
      `volthub_errors_total ${errs}`,
      '# HELP volthub_latency_p95_ms Rolling p95 latency (ms, last 500 reqs)',
      '# TYPE volthub_latency_p95_ms gauge',
      `volthub_latency_p95_ms ${p95()}`,
      '# HELP volthub_outbox_depth Unacked outbox events',
      '# TYPE volthub_outbox_depth gauge',
      `volthub_outbox_depth ${outbox}`,
      '# HELP volthub_ocpp_online Connected charge points (local view)',
      '# TYPE volthub_ocpp_online gauge',
      `volthub_ocpp_online ${cps}`,
      '# HELP volthub_sessions_total Sessions in store',
      '# TYPE volthub_sessions_total gauge',
      `volthub_sessions_total ${sessions}`,
      '# HELP volthub_oracle_connected 1 when Oracle pool is up',
      '# TYPE volthub_oracle_connected gauge',
      `volthub_oracle_connected ${pool}`,
    ].join('\n') + '\n'
  );
}
module.exports = { observe, render };
