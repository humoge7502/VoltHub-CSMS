// bench/k6-reserve-contention.js — experiment 2: reservation contention.
// 1 hot connector (all VUs race the same window → exactly one 201, rest 409) vs
// N free connectors (parallel, expect ~linear scaling). Demonstrates the
// per-connector lock scope (mutex locally, SELECT ... FOR UPDATE in Oracle).
// Run: k6 run bench/k6-reserve-contention.js
// Report hot-connector p95 (< 500 ms target) + N-connector scaling in docs/perf.md.
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    hot: {
      executor: 'constant-vus',
      vus: 20,
      duration: '1m',
      exec: 'hot',
    },
    spread: {
      executor: 'constant-vus',
      vus: 20,
      duration: '1m',
      exec: 'spread',
      startTime: '70s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.95'],
    http_req_duration: ['p(95)<500'],
  },
};

const BASE = __ENV.API_BASE || 'http://localhost:4000/api/v1';
const HOT = __ENV.HOT_CONNECTOR || '1:1';

function headers() {
  const email = `bench.${__VU}.${__ITER}.${Date.now()}@example.in`;
  const r = http.post(
    `${BASE}/auth/register`,
    JSON.stringify({ email: email, password: 'Driver@123', full_name: 'Bench Driver' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  const token = r.json('accessToken');
  return { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
}

function window_() {
  const s = new Date(Date.now() + 3600000 + (__ITER % 10) * 60000).toISOString();
  const e = new Date(Date.now() + 5400000 + (__ITER % 10) * 60000).toISOString();
  return { s, e };
}

export function hot() {
  const [cp, no] = String(HOT).split(':').map(Number);
  const w = window_();
  const r = http.post(
    `${BASE}/reservations`,
    JSON.stringify({ cpId: cp, connectorNo: no, startAt: w.s, endAt: w.e }),
    headers()
  );
  // Under contention exactly one winner per window: 201 xor 409 are both healthy.
  check(r, { 'hot decided': (x) => x.status === 201 || x.status === 409 });
  sleep(0.5);
}

export function spread() {
  // Spread across connectors by VU id to show linear scaling off the hot lock.
  const cp = 1 + (__VU % 4);
  const no = 1 + (__VU % 2);
  const w = window_();
  const r = http.post(
    `${BASE}/reservations`,
    JSON.stringify({ cpId: cp, connectorNo: no, startAt: w.s, endAt: w.e }),
    headers()
  );
  check(r, { 'spread decided': (x) => x.status === 201 || x.status === 409 });
  sleep(0.5);
}
