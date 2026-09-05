// bench/k6-discovery.js — experiment 1: /stations discovery latency (50 VUs).
// Compares JS-aggregation discovery vs the SQL v_station_summary path header.
// Gate: p95 < 300 ms @ 50 VUs (local profile). Run: k6 run bench/k6-discovery.js
// Report p50/p95/p99 + error rate for both paths in docs/perf.md.
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 50 },
    { duration: '1m', target: 50 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<300'],
  },
};

const BASE = __ENV.API_BASE || 'http://localhost:4000/api/v1';

export default function () {
  let r = http.get(`${BASE}/stations?lat=12.97&lng=80.06&radius=60`);
  check(r, {
    'discover 200': (x) => x.status === 200,
    'discover fast': (x) => x.timings.duration < 300,
    'has stations': (x) => (x.json('stations') || []).length > 0,
  });
  r = http.get(`${BASE}/tariffs/active`);
  check(r, { 'tariffs 200': (x) => x.status === 200 });
  sleep(0.5);
}
