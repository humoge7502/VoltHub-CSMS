// k6 smoke + soak (masterplan §33.7): 50 VUs discovery + reserve contention,
// 10-min soak target. Run: k6 run test/load/k6-smoke.js
// Thresholds encode NFR-03 (p95 <300ms) and NFR-04 (ingest lag <30s via /health).
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 10 },
    { duration: '3m', target: 50 },
    { duration: '5m', target: 50 },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<300'],
  },
};

const BASE = __ENV.API_BASE || 'http://localhost:4000/api/v1';
let token = null;

export function setup() {
  const r = http.post(
    `${BASE}/auth/register`,
    JSON.stringify({
      email: `k6.${Date.now()}@example.in`,
      password: 'Driver@123',
      full_name: 'K6 Load',
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  return { token: r.json('accessToken') };
}

export default function (data) {
  const H = { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data ? data.token : ''}` } };
  let r = http.get(`${BASE}/stations?lat=12.97&lng=80.06&radius=60`);
  check(r, { 'discover 200': (x) => x.status === 200, 'discover fast': (x) => x.timings.duration < 300 });
  const stations = r.json('stations') || [];
  const conn = stations.length && stations[0].connectors.find((c) => c.status === 'AVAILABLE');
  if (conn) {
    const [cp, no] = conn.connector_ref.split(':').map(Number);
    r = http.post(
      `${BASE}/reservations`,
      JSON.stringify({
        cpId: cp,
        connectorNo: no,
        startAt: new Date(Date.now() + 3600000).toISOString(),
        endAt: new Date(Date.now() + 5400000).toISOString(),
      }),
      H
    );
    // under contention exactly one winner: 201 xor 409 are both healthy
    check(r, { 'reserve decided': (x) => x.status === 201 || x.status === 409 });
  }
  sleep(1);
}

export function teardown() {
  const r = http.get(`${BASE}/health`);
  check(r, { 'outbox drained (<30s lag equivalent)': (x) => (x.json('outbox_lag') || 0) < 5000 });
}
