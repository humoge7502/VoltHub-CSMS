// bench/run-local.js — local-profile measurement harness (no k6/Docker needed).
// Boots an ephemeral API and measures experiments 1 (discovery), 2 (reservation
// contention), 3 (tick ingest throughput) and 5 (read step-load). Results print as
// Markdown tables for docs/perf.md and save to bench/results-local.json.
// Run: node bench/run-local.js
'use strict';
process.env.RATE_LIMIT_OFF = '1';
const fs = require('fs');
const path = require('path');

function pct(arr, p) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
}
const stats = (arr) => ({
  n: arr.length,
  p50: +pct(arr, 50).toFixed(1),
  p95: +pct(arr, 95).toFixed(1),
  p99: +pct(arr, 99).toFixed(1),
});

async function main() {
  process.env.PORT = '4113';
  const { server, store } = require('../apps/api/src/server');
  await new Promise((r) => server.listen(4113, r));
  const B = 'http://localhost:4113/api/v1';
  const api = async (p, o = {}) => {
    const t0 = Date.now();
    const { headers, ...rest } = o;
    const r = await fetch(B + p, {
      ...rest,
      headers: { 'content-type': 'application/json', ...(headers || {}) },
    });
    const ms = Date.now() - t0;
    return { status: r.status, j: await r.json().catch(() => ({})), ms };
  };
  const out = { hw: {}, exp1: null, exp2: null, exp3: null, exp5: null };
  try {
    const os = require('os');
    out.hw = {
      node: process.version,
      cpus: os.cpus().length,
      cpu: os.cpus()[0]?.model || 'unknown',
      mem_gb: +(os.totalmem() / 1073741824).toFixed(1),
      platform: `${os.platform()} ${os.release()}`,
      profile: 'local (in-process store, no Docker)',
      at: new Date().toISOString(),
    };
    // Seed a driver.
    const reg = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: `bench${Date.now()}@example.in`,
        password: 'Driver@123',
        full_name: 'Bench Driver',
      }),
    });
    const H = { Authorization: `Bearer ${reg.j.accessToken}` };
    const { j: disc } = await api('/stations');
    const avail = disc.stations.flatMap((s) => s.connectors || []).filter((c) => c.status === 'AVAILABLE');
    if (!avail.length) throw new Error('no AVAILABLE connector for bench');

    // Exp 1: discovery latency, 200 sequential samples.
    {
      const lat = [];
      for (let i = 0; i < 200; i++) {
        const r = await api('/stations?lat=12.97&lng=80.06&radius=50');
        if (r.status !== 200) throw new Error(`discovery ${r.status}`);
        lat.push(r.ms);
      }
      out.exp1 = { ...stats(lat), errors: 0, note: '200 sequential GET /stations (local profile)' };
    }
    // Exp 2: hot-connector contention — 20 parallel same-window reserves.
    {
      const [cp, no] = avail[0].connector_ref.split(':').map(Number);
      const s = new Date(Date.now() + 20 * 60000).toISOString();
      const e = new Date(Date.now() + 60 * 60000).toISOString();
      const t0 = Date.now();
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          api('/reservations', {
            method: 'POST',
            headers: { ...H, 'Idempotency-Key': `bench-hot-${Date.now()}-${i}` },
            body: JSON.stringify({ cpId: cp, connectorNo: no, startAt: s, endAt: e }),
          })
        )
      );
      const lat = results.map((r) => r.ms);
      const wins = results.filter((r) => r.status === 201).length;
      const conflicts = results.filter((r) => r.status === 409).length;
      out.exp2 = {
        ...stats(lat),
        winners: wins,
        conflicts,
        wall_ms: Date.now() - t0,
        note: '20 parallel same-window reserves on 1 hot connector (expect exactly 1x201)',
      };
    }
    // Exp 3: tick ingest throughput via store.recordTick (billing-grade path).
    {
      const [cp, no] = avail[1 % avail.length].connector_ref.split(':').map(Number);
      await api(`/reservations`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
      const st = await api('/sessions/start', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ cpId: cp, connectorNo: no }),
      });
      const sid = st.j.session.session_id;
      const N = 2000;
      const t0 = Date.now();
      for (let i = 1; i <= N; i++) {
        await store.recordTick(sid, i, new Date().toISOString(), i * 0.01, 30, 400, 75);
      }
      const wall = Date.now() - t0;
      const lag = (await api('/health')).j.outbox_lag;
      out.exp3 = {
        ticks: N,
        wall_ms: wall,
        ticks_per_s: +(N / (wall / 1000)).toFixed(0),
        outbox_lag_after: lag,
        note: '2000 sequential recordTick on one session (local profile; relay drains via worker JSONL mirror)',
      };
    }
    // Exp 5: read step-load 10 -> 50 -> 100 concurrent GET /stations.
    {
      out.exp5 = {};
      for (const vus of [10, 50, 100]) {
        const lat = [];
        let errors = 0;
        const batch = async () => {
          const r = await api('/stations');
          lat.push(r.ms);
          if (r.status !== 200) errors++;
        };
        await Promise.all(Array.from({ length: vus }, batch));
        out.exp5[`vu${vus}`] = { ...stats(lat), errors };
      }
      out.exp5.note = 'single concurrent batch per level (local profile, poolMax n/a)';
    }
    console.log(JSON.stringify(out, null, 2));
    fs.writeFileSync(path.join(__dirname, 'results-local.json'), JSON.stringify(out, null, 2));
    console.log('\nWrote bench/results-local.json');
  } finally {
    server.close();
  }
  process.exit(0);
}
main().catch((e) => {
  console.error('BENCH FAIL', e);
  process.exit(1);
});
