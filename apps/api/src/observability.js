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
  // One measured snapshot instead of three separate O(depth) filters per scrape.
  const lag = store && store.outboxLag ? store.outboxLag() : { pending: 0, oldest_age_s: 0, dead_letters_open: 0 };
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
      `volthub_outbox_depth ${lag.pending}`,
      // Age of the oldest unacked event: the difference between "the relay is busy"
      // and "the relay stopped and nobody noticed". Alert on this, not on depth.
      '# HELP volthub_outbox_oldest_age_seconds Age of the oldest unacked event',
      '# TYPE volthub_outbox_oldest_age_seconds gauge',
      `volthub_outbox_oldest_age_seconds ${lag.oldest_age_s}`,
      '# HELP volthub_dead_letter_depth Poison events parked for operator triage',
      '# TYPE volthub_dead_letter_depth gauge',
      `volthub_dead_letter_depth ${lag.dead_letters_open}`,
      // -1 means no relay has polled this process since boot: the queue is growing
      // and nothing is draining it. Pair with outbox_oldest_age for the paging rule.
      '# HELP volthub_relay_last_poll_seconds Age of the last worker outbox poll (-1 = never)',
      '# TYPE volthub_relay_last_poll_seconds gauge',
      `volthub_relay_last_poll_seconds ${
        store && store._relayLastPollAt ? Math.round((Date.now() - store._relayLastPollAt) / 1000) : -1
      }`,
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
