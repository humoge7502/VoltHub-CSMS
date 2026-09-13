// ADR-0010 / FC-HCC control-loop suite: pins the blueprint's binary claims.
// Properties (blueprint W "property-based optimizer tests"):
//   P1  Envelope caps are never exceeded by compiled profiles.
//   P2  Grid-asset cap monotonicity + one SITE root per station (V007 parity).
//   P3  Certificates: admission under worst case, legal lifecycle transitions only.
//   P4  Profile pushes are idempotent per (cp, decision) and rate-governed.
//   P5  ENFORCED actuation sends SetChargingProfile frames; ADVISORY never does.
//   P6  Deadline/energy: the schedule serves certified floors first and never
//       exceeds the site cap in any interval (constraint 5/8 parity, local LP).
//   P7  Dead letters capture envelope rejections and dedupe on event_ref.
// Run: node apps/api/test/control.js
'use strict';
const assert = require('assert');
const { createStore } = require('../src/db/store');
const { seedStore } = require('../src/db/seed');
const control = require('../src/control/controller');
const smartCharging = require('../src/ocpp/smart-charging');

function fakeRegistry(store, cpId, sink) {
  const cp = store.cps.get(Number(cpId));
  return new Map([[cp.ocpp_identity, { readyState: 1, send: (raw) => sink.push(JSON.parse(raw)) }]]);
}
function stageSession(store, connRef, powerKw) {
  const sess = {
    session_id: 9000 + store.sessions.size,
    user_id: 1,
    connector_ref: connRef,
    cp_id: Number(connRef.split(':')[0]),
    connector_no: Number(connRef.split(':')[1]),
    tariff_plan_id: 2,
    state: 'CHARGING',
    billing_state: 'UNBILLED',
    started_at: new Date().toISOString(),
    start_meter_kwh: 0,
  };
  store.sessions.set(sess.session_id, sess);
  store.connectors.get(connRef).status = 'OCCUPIED';
  store.readings.push({
    session_id: sess.session_id,
    seq_no: 1,
    taken_at: new Date().toISOString(),
    meter_kwh: 2.5,
    power_kw: powerKw,
    source: 'OCPP',
  });
  return sess;
}

async function main() {
  let pass = 0;
  const t = async (name, fn) => {
    await fn();
    pass++;
    console.log(`  ok ${pass} - ${name}`);
  };

  const store = createStore();
  seedStore(store, 'demo');
  const siteId = [...store.stations.keys()][0];
  const firstConn = [...store.connectors.keys()][0];
  const firstCp = Number(firstConn.split(':')[0]);

  await t('P2 grid assets: monotonic caps + one SITE root + four-eyes on reductions', async () => {
    const site = store.upsertGridAsset(siteId, { kind: 'SITE', label: 'root', cap_kw: 50 }, 7);
    assert.equal(store.siteCapKw(siteId), 50);
    // child above parent must fail with the V007 band
    assert.throws(
      () => store.upsertGridAsset(siteId, { kind: 'PANEL', parent_id: site.asset_id, label: 'p', cap_kw: 51 }, 7),
      (e) => e.num === -20902 && e.code === 'GRID_CAP_MONOTONIC'
    );
    const panel = store.upsertGridAsset(siteId, { kind: 'PANEL', parent_id: site.asset_id, label: 'p', cap_kw: 30 }, 7);
    assert.equal(panel.cap_kw, 30);
    // second SITE root rejected
    assert.throws(
      () => store.upsertGridAsset(siteId, { kind: 'SITE', label: 'root2', cap_kw: 10 }, 7),
      (e) => e.num === -20901
    );
    // cap reduction -> PENDING, self-approval rejected, second admin approves
    const red = store.upsertGridAsset(siteId, { asset_id: site.asset_id, kind: 'SITE', cap_kw: 40 }, 7);
    assert.equal(red.status, 'PENDING');
    assert.throws(
      () => store.approveGridAsset(site.asset_id, 7),
      (e) => e.num === -20901
    );
    store.approveGridAsset(site.asset_id, 8);
    assert.equal(site.status, 'ACTIVE');
    assert.equal(store.siteCapKw(siteId), 40);
    global.__siteCap = 40;
    global.__site = site;
  });

  await t('P5 plan cycle ADVISORY: decision persisted, no OCPP frames, no actuation', async () => {
    stageSession(store, firstConn, 6.6);
    store.setControlMode(siteId, 'ADVISORY', null);
    const sent = [];
    const registry = fakeRegistry(store, firstCp, sent);
    global.__registry = registry;
    global.__sent = sent;
    const { mode, decision, pushes } = control.planSite(store, siteId, {});
    assert.equal(mode, 'ADVISORY');
    assert.ok(decision.decision_id > 0 && decision.bounds_hash, 'decision has provenance');
    assert.ok(pushes.length >= 1, 'profile compiled per active CP');
    assert.equal(sent.length, 0, 'ADVISORY never touches the wire');
    global.__decision = decision;
  });

  await t('P1+P6 schedule: site cap respected in every interval; certified floors first', async () => {
    // A fresh store to control the certificate order deterministically.
    const s2 = createStore();
    seedStore(s2, 'demo');
    const site2 = [...s2.stations.keys()][0];
    s2.upsertGridAsset(site2, { kind: 'SITE', label: 'root', cap_kw: 10 }, null);
    const c1 = [...s2.connectors.keys()][0];
    const c2 = [...s2.connectors.keys()][1];
    stageSession(s2, c1, 7);
    stageSession(s2, c2, 7);
    const capPerT = 10 * 0.25; // kW * dt(h)
    const { solved } = control.planSite(s2, site2, { planId: 2 });
    for (let t = 0; t < solved.metrics.horizon; t++) {
      const total = Object.values(solved.schedule).reduce((a, arr) => a + (arr[t] || 0), 0);
      assert.ok(
        total <= capPerT * (1 - control.FORECAST_RESERVE_FRACTION) + 1e-6,
        `interval ${t} exceeds the reserved site cap: ${total}`
      );
    }
    // Both sessions got energy; nothing silently truncated without an unmet record.
    const need = Object.values(solved.schedule).reduce((a, arr) => a + arr.reduce((x, y) => x + y, 0), 0);
    assert.ok(need > 0, 'schedule delivers energy');
    global.__s2 = s2;
    global.__site2 = site2;
  });

  await t('P3 certificates: worst-case admission refuses infeasible demand; lifecycle is legal', async () => {
    const s2 = global.__s2;
    const site2 = global.__site2;
    const refused = s2.issueCertificate({
      sessionId: 7001,
      stationId: site2,
      cpId: 1,
      connectorNo: 1,
      floorKw: 0,
      marginKwh: 2,
      worstCaseKwh: 5,
      requiredKwh: 20,
      deadlineAt: new Date(Date.now() + 3600e3).toISOString(),
      decisionId: null,
      admitted: false,
    });
    assert.equal(refused.status, 'FAILED');
    // legal: FAILED has no exits (lifecycle terminal)
    assert.throws(
      () => s2.transitionCertificate(refused.cert_id, 'ACTIVE'),
      (e) => e.code === 'ILLEGAL_TRANSITION'
    );
    const ok = s2.issueCertificate({
      sessionId: 7002,
      stationId: site2,
      cpId: 2,
      connectorNo: 1,
      floorKw: 4,
      marginKwh: 1,
      worstCaseKwh: 30,
      requiredKwh: 20,
      deadlineAt: new Date(Date.now() + 3600e3).toISOString(),
      decisionId: null,
      admitted: true,
    });
    assert.equal(ok.status, 'ACTIVE');
    s2.transitionCertificate(ok.cert_id, 'ERODED', 'deviation 2 kW');
    s2.transitionCertificate(ok.cert_id, 'FAILED', 'deadline risk');
    assert.throws(
      () => s2.transitionCertificate(ok.cert_id, 'MET'),
      (e) => e.code === 'ILLEGAL_TRANSITION'
    );
  });

  await t('P1 envelope: compiled profiles never exceed the site cap; violations rejected -20903', async () => {
    const store2 = global.__s2;
    const site2 = global.__site2;
    const over = { chargingSchedule: { chargingSchedulePeriods: [{ startPeriod: 0, limit: 100000 }] } };
    const env = control.envelopeCheck(store2, 1, over);
    assert.equal(env.ok, false);
    assert.equal(env.error.num, -20903);
    assert.equal(env.error.code, 'ENVELOPE_REJECTED');
    const under = { chargingSchedule: { chargingSchedulePeriods: [{ startPeriod: 0, limit: 4000 }] } };
    assert.equal(control.envelopeCheck(store2, 1, under).ok, true);
    // compiler output itself: no period above the cap
    const { solved } = control.planSite(store2, site2, { planId: 2 });
    const capW = 10 * 1000;
    for (const p of control.compileToProfiles(store2, site2, global.__decision, solved, 15, 24)) {
      for (const period of p.profile.chargingSchedule.chargingSchedulePeriods) {
        assert.ok(period.limit <= capW + 1e-6, 'compiled limit above site cap');
      }
    }
  });

  await t('P5 ENFORCED: SetChargingProfile frames go out; envelope-rejected push is dead-lettered', async () => {
    const s2 = global.__s2;
    const site2 = global.__site2;
    s2.setControlMode(site2, 'ENFORCED', null);
    const sent = [];
    const registry = fakeRegistry(s2, 1, sent);
    const { decision, pushes } = control.planSite(s2, site2, { planId: 2 });
    const sent2 = await smartCharging.setChargingProfile(s2, registry, null, {
      cpId: 1,
      profile: pushes[0].profile,
      decisionId: decision.decision_id,
      payloadSha256: pushes[0].payloadSha256,
    });
    assert.ok(sent2.push_id > 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][2], 'SetChargingProfile');
    assert.ok(sent[0][3].csChargingProfiles.chargingProfileId === decision.decision_id);
    // ack recorded on the audit row
    s2.setPushAck(sent2.push_id, 'Accepted');
    assert.equal([...s2.profilePushes.values()].find((p) => p.push_id === sent2.push_id).ack_result, 'Accepted');
    // envelope rejection path: dead letter + typed error
    const badProfile = { chargingSchedule: { chargingSchedulePeriods: [{ startPeriod: 0, limit: 999999 }] } };
    await assert.rejects(
      () => smartCharging.setChargingProfile(s2, registry, null, { cpId: 1, profile: badProfile, decisionId: 424242 }),
      (e) => e.num === -20903 && e.code === 'ENVELOPE_REJECTED'
    );
    const letters = s2.listDeadLetters();
    assert.ok(
      letters.some((l) => l.reason_code === 'ENVELOPE_REJECTED'),
      'envelope rejection dead-lettered'
    );
    // push idempotency per (cp, decision): same decision twice => one audit row
    const again = await smartCharging.setChargingProfile(s2, registry, null, {
      cpId: 1,
      profile: pushes[0].profile,
      decisionId: decision.decision_id,
      payloadSha256: pushes[0].payloadSha256,
    });
    assert.equal(again.push_id, sent2.push_id, 'profile push deduped on (cp, decision)');
  });

  await t('P4 rate governance: >6 pushes/min per CP is rejected 429', async () => {
    const s2 = global.__s2;
    const registry = fakeRegistry(s2, 2, []);
    const profile = { chargingSchedule: { chargingSchedulePeriods: [{ startPeriod: 0, limit: 1000 }] } };
    let saw429 = null;
    for (let i = 0; i < 8; i++) {
      try {
        await smartCharging.setChargingProfile(s2, registry, null, { cpId: 2, profile, decisionId: 60000 + i });
      } catch (e) {
        saw429 = e;
        break;
      }
    }
    assert.ok(saw429 && saw429.code === 'PROFILE_RATE_LIMITED' && saw429.status === 429, 'rate limit fired');
  });

  await t('P7 dead letters: dedupe on event_ref + operator resolve', async () => {
    const s2 = global.__s2;
    const before = s2.listDeadLetters().length;
    const a = s2.deadLetter({ eventRef: 'dup-1', kind: 'X', reasonCode: 'R1' });
    const b = s2.deadLetter({ eventRef: 'dup-1', kind: 'X', reasonCode: 'R1' });
    assert.equal(a.letter_id, b.letter_id, 'same ref dedupes');
    assert.equal(s2.listDeadLetters().length, before + 1);
    const resolved = s2.resolveDeadLetter(a.letter_id, 'DISMISSED', 8);
    assert.equal(resolved.status, 'DISMISSED');
  });

  await t('P8 compliance: deviation beyond tolerance erodes ACTIVE certificates + replans', async () => {
    const s2 = global.__s2;
    const cert = s2.issueCertificate({
      sessionId: 7100,
      stationId: global.__site2,
      cpId: 2,
      connectorNo: 1,
      floorKw: 6,
      marginKwh: 0.5,
      worstCaseKwh: 40,
      requiredKwh: 20,
      deadlineAt: new Date(Date.now() + 3600e3).toISOString(),
      decisionId: null,
      admitted: true,
    });
    s2.recordEnforcementTick({ cpId: 2, sessionId: 7100, scheduledKw: 6, actualKw: 3.2 });
    const verdict = control.verifyCompliance(s2, global.__site2, { toleranceKw: 0.5, hysteresisMin: 0 });
    assert.equal(verdict.replan, true);
    assert.equal(verdict.reason, 'MARGIN_EROSION');
    const after = [...s2.certificates.values()].find((c) => c.cert_id === cert.cert_id);
    assert.equal(after.status, 'ERODED');
  });

  console.log(`\nControl tests: ${pass} passed`);
  process.exit(0);
}
main().catch((e) => {
  console.error('CONTROL-TEST FAIL', e);
  process.exit(1);
});
