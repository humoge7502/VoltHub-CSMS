// Control-plane integration test against a LIVE, DB-backed API (compose stack).
//
// Why it exists: `apps/api/test/control.js` proves the FC-HCC properties against the
// local store, and `test/e2e/run.js` proves the money-path journey against an in-process
// API. Neither exercises the control plane through HTTP **and** the Oracle write-through
// mirrors at once — which is precisely where certification, planning and dead-lettering
// can diverge between engines (ADR-0005/0014). This script closes that gap and runs in the
// CI e2e job, after the stack is healthy.
//
// Usage: node test/e2e/control-plane.js [--base http://localhost:4000/api/v1]
// Asserts (any throw = red):
//   1. ADMIN can define a SITE grid asset; a child cap above its parent is REJECTED (-20902)
//      — the electrical invariant holds through HTTP + the Oracle trigger, not just in JS.
//   2. ADVISORY plan: certification runs, compiles profiles, and touches no wire.
//   3. Certificate rows are readable with the promise they made (floor, deadline, status).
//   4. ENFORCED plan: actuation is attempted and every push is either acked-for-dispatch or
//      reports a TYPED error (a CP with no socket is CP_OFFLINE — never a 500).
//   5. The decision is persisted with provenance (bounds_hash + solver + runtime).
//   6. Dead-letter triage is reachable to ADMIN.
//   7. Control actions leave a DURABLE audit trail (a review found GRID_ASSET /
//      CONTROL_MODE rows were never mirrored into Oracle at all — see ADR-0014), and the
//      mirror-divergence counter reported by /health is zero.
//   8. The trail is also READ BACK from Oracle on boot: `/admin/audit-logs` used to serve
//      a process-local buffer, so every pre-restart row (and the security evidence it
//      carried) disappeared from the endpoint. Asserted with a row whose creation time
//      predates this API process — migration seeds a fault report through audit_pkg
//      before the container starts, so that row exists on a clean CI database too.
'use strict';
process.env.RATE_LIMIT_OFF = process.env.RATE_LIMIT_OFF || '1';

const BASE = (() => {
  const i = process.argv.indexOf('--base');
  return (i > -1 && process.argv[i + 1]) || process.env.E2E_BASE || 'http://localhost:4000/api/v1';
})();

let pass = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) throw new Error(`${name}${detail ? ` — ${detail}` : ''}`);
  pass++;
  console.log(`  control-e2e ${pass} - ${name}`);
};

async function main() {
  const api = async (p, o = {}) => {
    const { headers, ...rest } = o;
    const r = await fetch(BASE + p, {
      ...rest,
      headers: { 'content-type': 'application/json', ...(headers || {}) },
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, j };
  };

  // ---- 0. the stack is the durable profile (a local-store API would make this vacuous) ----
  const health = await api('/health');
  ok('API is up and reports its data mode', health.status === 200, `status ${health.status}`);
  // Require the DURABLE engine explicitly: 'local' would make every assertion below
  // pass without ever touching Oracle, which is the whole point of this suite.
  ok(
    'API is running the durable engine (Oracle attached)',
    health.j.mode === 'oracle',
    `mode=${health.j.mode} oracle=${health.j.oracle} (run against the compose stack: infra/docker-compose.yml)`
  );

  // ---- 1. admin, station, electrical model ----
  const adm = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@volthub.in', password: 'Admin@123' }),
  });
  ok('admin login', adm.status === 200 && !!adm.j.accessToken);
  const AH = { Authorization: `Bearer ${adm.j.accessToken}` };

  const stations = await api('/admin/stations', { headers: AH });
  ok('station inventory readable', stations.status === 200 && stations.j.stations.length > 0);
  const station = stations.j.stations[0];
  const siteId = station.station_id;

  // Idempotent by design: CI runs this against a persistent database, and a second SITE
  // root is (correctly) rejected by the electrical model — so reuse an existing root
  // instead of failing on the second run.
  const existing = await api(`/stations/${siteId}/grid-assets`, { headers: AH });
  ok('grid-asset inventory readable', existing.status === 200 && Array.isArray(existing.j.assets));
  let assetId = (existing.j.assets || []).find((a) => a.kind === 'SITE')?.asset_id;
  let siteCapKw = 60;
  if (assetId == null) {
    const site = await api(`/stations/${siteId}/grid-assets`, {
      method: 'POST',
      headers: AH,
      body: JSON.stringify({ kind: 'SITE', label: 'e2e-root', cap_kw: 60 }),
    });
    ok('SITE grid asset defined', site.status === 201 || site.status === 200, JSON.stringify(site.j).slice(0, 160));
    assetId = site.j.asset?.asset_id;
  } else {
    ok('SITE grid asset reused from the previous run', true);
    siteCapKw = Number(existing.j.site_cap_kw) || 60;
  }

  const over = await api(`/stations/${siteId}/grid-assets`, {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({ kind: 'PANEL', parent_id: assetId, label: 'e2e-panel', cap_kw: siteCapKw + 1 }),
  });
  ok(
    'child cap above its parent is rejected with the monotonicity band',
    over.status === 409 && over.j.error?.code === 'GRID_CAP_MONOTONIC',
    `status ${over.status} code ${over.j.error?.code}`
  );

  // A grid edit that actually happens on THIS run. The SITE root is reused above for
  // idempotency, so it is never rewritten — asserting its audit row would test the
  // previous run's mutation, not this one. A unique-labelled child gives the audit
  // assertion (step 7) a real subject and keeps the suite re-runnable.
  const child = await api(`/stations/${siteId}/grid-assets`, {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({
      kind: 'PANEL',
      parent_id: assetId,
      label: `e2e-panel-${Date.now()}`,
      cap_kw: Math.max(1, Math.min(10, siteCapKw)),
    }),
  });
  ok(
    'a child grid asset is created under the site root',
    child.status === 201 && child.j.asset?.asset_id != null,
    JSON.stringify(child.j).slice(0, 180)
  );
  const childId = child.j.asset?.asset_id;

  // ---- 2. an active session to certify ----
  const drv = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `cp.e2e.${Date.now()}@example.in`,
      password: 'Driver@123',
      full_name: 'Control E2E Driver',
    }),
  });
  ok('driver registered', drv.status === 201);
  const DH = { Authorization: `Bearer ${drv.j.accessToken}` };

  const detail = await api(`/stations/${siteId}`, { headers: DH });
  const candidates = (detail.j.station?.charge_points || [])
    .flatMap((cp) => cp.connectors || [])
    .filter((c) => c.status === 'AVAILABLE');
  ok('an available connector exists on the site', candidates.length > 0, 'seed/provision a connector first');

  // Find a window that is genuinely free. A CONVERTED reservation KEEPS its window (the
  // money path holds the booking until it expires), so on a re-run the connector an
  // earlier run used still refuses the same slot with OVERLAP. Walk a ladder of future
  // offsets across the site's free connectors and take the first slot that books — the
  // deadline the certificate is judged against is therefore always in the future and
  // never contested. `start_session` converts a BOOKED reservation regardless of how far
  // off its window is (no early-start gate), so the ladder costs the test nothing.
  const WINDOW_MIN = 60;
  const OFFSETS_MIN = [20, 100, 180, 260, 340];
  let conn = null;
  let resv = null;
  let lastErr = null;
  for (const offset of OFFSETS_MIN) {
    for (const c of candidates) {
      const [cp, no] = c.connector_ref.split(':').map(Number);
      const attempt = await api('/reservations', {
        method: 'POST',
        headers: DH,
        body: JSON.stringify({
          cpId: cp,
          connectorNo: no,
          startAt: new Date(Date.now() + offset * 60000).toISOString(),
          endAt: new Date(Date.now() + (offset + WINDOW_MIN) * 60000).toISOString(),
        }),
      });
      if (attempt.status === 201) {
        conn = c;
        resv = attempt;
        break;
      }
      lastErr = `${c.connector_ref}@+${offset}m ${attempt.j.error?.code}`;
      // OVERLAP is the expected collision on a re-run; anything else is a real defect.
      if (attempt.j.error?.code !== 'OVERLAP') {
        throw new Error(`reservation failed on ${c.connector_ref}: ${JSON.stringify(attempt.j).slice(0, 180)}`);
      }
    }
    if (resv) break;
  }
  ok(
    'connector reserved (deadline source for the certificate)',
    resv != null && resv.status === 201,
    `every ladder slot was booked — reset the demo database (last: ${lastErr})`
  );
  const [cpId, connNo] = conn.connector_ref.split(':').map(Number);

  const start = await api('/sessions/start', {
    method: 'POST',
    headers: DH,
    body: JSON.stringify({ cpId, connectorNo: connNo, reservationId: resv.j.reservation.reservation_id, planId: 2 }),
  });
  ok('session started (PREPARING)', start.status === 201, JSON.stringify(start.j).slice(0, 160));
  const sessionId = start.j.session.session_id;

  // Move the session into CHARGING so the estimator sees a live charging vehicle
  // (`body.to` is the transition target; a legal transition returns 200, an illegal one
  // 409 — both leave the session in an active state, which is all the plan needs).
  const ticks = await api(`/sessions/${sessionId}/state`, {
    method: 'PATCH',
    headers: DH,
    body: JSON.stringify({ to: 'CHARGING' }),
  });
  ok('session is active for planning', [200, 409].includes(ticks.status), `status ${ticks.status}`);

  // ---- 3. ADVISORY plan: certify + compile, no wire ----
  const adv = await api('/control/mode', {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({ siteId, mode: 'ADVISORY' }),
  });
  ok('control mode ADVISORY set', adv.status === 200 && adv.j.mode === 'ADVISORY', JSON.stringify(adv.j).slice(0, 160));

  const plan1 = await api(`/control/plan/${siteId}`, { method: 'POST', headers: AH, body: JSON.stringify({}) });
  ok('ADVISORY plan cycle succeeded', plan1.status === 200, JSON.stringify(plan1.j).slice(0, 200));
  ok(
    'plan persisted a decision with provenance (bounds_hash + solver + runtime)',
    !!plan1.j.decision?.bounds_hash && !!plan1.j.decision?.solver && typeof plan1.j.decision?.runtime_ms === 'number',
    JSON.stringify(plan1.j.decision || {}).slice(0, 200)
  );
  ok('the plan reports metrics', typeof plan1.j.metrics?.peak_kw === 'number');
  ok(
    'ADVISORY never touches the wire',
    Array.isArray(plan1.j.actuated) && plan1.j.actuated.length === 0,
    `actuated=${JSON.stringify(plan1.j.actuated)}`
  );
  ok(
    'the active session was certified in the plan cycle',
    Array.isArray(plan1.j.certifications) && plan1.j.certifications.some((c) => c.session_id === sessionId),
    JSON.stringify(plan1.j.certifications || []).slice(0, 200)
  );
  ok(
    'the plan schedules within the reserved site cap',
    plan1.j.metrics.peak_kw <= siteCapKw * (1 - 0.1) + 1e-6,
    `peak ${plan1.j.metrics.peak_kw} kW vs usable cap ${(siteCapKw * 0.9).toFixed(2)} kW`
  );

  const certs = await api(`/control/certificates?siteId=${siteId}`, { headers: AH });
  ok('certificates are readable', certs.status === 200 && Array.isArray(certs.j.certificates));
  const mine = certs.j.certificates.find((c) => c.session_id === sessionId);
  ok('the session has a certificate row', !!mine);
  ok(
    'the certificate carries the deadline it was judged against',
    !!mine.deadline_at,
    JSON.stringify(mine).slice(0, 220)
  );
  ok(
    'the certificate is in a legal state',
    ['ISSUED', 'ACTIVE', 'FAILED', 'ERODED', 'MET'].includes(mine.status),
    `status ${mine.status}`
  );
  // The invariant is NOT "always admitted": the site is shared, so an over-subscribed
  // site must refuse. What must never happen is a SILENT promise — a row that says
  // ACTIVE while committing no power (floor 0), or a refusal with no stated reason.
  // A clean CI volume admits (the connector is free); a re-run against a site still
  // busy with earlier sessions legitimately refuses.
  const admitted = ['ACTIVE', 'ERODED', 'MET'].includes(mine.status);
  ok(
    'an admission commits real power and a refusal states why (never a silent promise)',
    admitted ? mine.floor_kw > 0 : !!mine.reason,
    JSON.stringify(mine).slice(0, 240)
  );

  // ---- 4. ENFORCED plan: typed actuation outcome, never a 500 ----
  const enf = await api('/control/mode', {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({ siteId, mode: 'ENFORCED' }),
  });
  ok('control mode ENFORCED accepted (an ACTIVE site cap exists)', enf.status === 200 && enf.j.mode === 'ENFORCED');

  const plan2 = await api(`/control/plan/${siteId}`, {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({ decisionId: undefined }),
  });
  ok('ENFORCED plan cycle succeeded', plan2.status === 200, JSON.stringify(plan2.j).slice(0, 200));
  ok('ENFORCED attempted actuation (pushes compiled)', Array.isArray(plan2.j.actuated) && plan2.j.actuated.length >= 1);
  ok(
    'every actuation attempt is either dispatched or a TYPED error (no 500, no silence)',
    plan2.j.actuated.every((a) => a.push_id != null || (a.error && a.message)),
    JSON.stringify(plan2.j.actuated).slice(0, 220)
  );

  const decisions = await api(`/control/decisions?siteId=${siteId}`, { headers: AH });
  ok(
    'decision history is readable',
    decisions.status === 200 && decisions.j.decisions.length >= 2,
    `count ${decisions.j.decisions?.length}`
  );

  const enforcement = await api(`/control/enforcement?siteId=${siteId}&limit=10`, { headers: AH });
  ok('enforcement telemetry endpoint is readable', enforcement.status === 200 && Array.isArray(enforcement.j.ticks));

  const letters = await api('/ops/dead-letters', { headers: AH });
  ok('dead-letter triage is reachable to ADMIN', letters.status === 200 && Array.isArray(letters.j.letters));

  // ---- 7. durable audit trail + observable mirror health ----
  const logs = await api('/admin/audit-logs', { headers: AH });
  ok('audit log is readable to ADMIN', logs.status === 200 && Array.isArray(logs.j.logs));
  ok(
    'the grid-asset edit is audited',
    logs.j.logs.some((l) => l.entity_name === 'GRID_ASSET' && String(l.entity_id) === String(childId)),
    `no GRID_ASSET audit row for asset ${childId}`
  );
  // Proof, not decoration: the endpoint must serve at least one row created BEFORE this
  // API process started. Rows this run wrote cannot satisfy it, so it can only pass if
  // the boot hydrate actually read them back out of audit_log.
  const bootedAt = health.j.process_started_at;
  ok(
    'the API reports when it booted (needed to date evidence)',
    typeof bootedAt === 'string' && Date.parse(bootedAt) > 0,
    `process_started_at=${bootedAt}`
  );
  ok(
    'the audit trail carries rows written before this process started (durable hydrate)',
    logs.j.logs.some((l) => Date.parse(l.created_at) < Date.parse(bootedAt)),
    'audit_log was not hydrated into the read-cache on boot'
  );
  ok(
    'control-mode changes are audited with old/new values',
    logs.j.logs.some((l) => l.entity_name === 'CONTROL_MODE' && l.action === 'SET' && l.new_value),
    'CONTROL_MODE rows missing from the audit trail'
  );
  const health2 = await api('/health');
  ok(
    'no write-through mirror failures were recorded',
    (health2.j.mirror_errors || 0) === 0,
    `mirror_errors=${health2.j.mirror_errors} last=${health2.j.last_mirror_error}`
  );

  // ---- 9. hygiene: release the connector ----
  // Without this the suite is not re-runnable: each run would leave a CHARGING vehicle
  // holding a certified floor, and the next run's admission would be (correctly)
  // refused on an over-subscribed site — a false alarm that hides real regressions.
  const stopped = await api(`/sessions/${sessionId}/remote-stop`, {
    method: 'POST',
    headers: DH,
    body: JSON.stringify({}),
  });
  ok(
    'the test session is stopped (no active vehicle is left behind)',
    stopped.status === 200 && stopped.j.session?.state === 'COMPLETED',
    JSON.stringify(stopped.j).slice(0, 180)
  );

  // Return the site to the safe default: actuation is opt-in (ADR-0010/0011).
  const off = await api('/control/mode', {
    method: 'POST',
    headers: AH,
    body: JSON.stringify({ siteId, mode: 'ADVISORY' }),
  });
  ok('control mode returned to ADVISORY', off.status === 200 && off.j.mode === 'ADVISORY');

  console.log(`\nControl-plane E2E: ${pass} steps passed against ${BASE}`);
  process.exit(0);
}
main().catch((e) => {
  console.error(`CONTROL-PLANE-E2E FAIL: ${e.message}`);
  process.exit(1);
});
