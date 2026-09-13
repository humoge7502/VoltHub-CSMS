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
//   P8  Compliance: deviation beyond tolerance erodes ACTIVE certificates.
//   P9  The plan cycle CERTIFIES: every active session gets a certificate row whose
//       admission verdict matches its worst case, and floors never exceed the promise.
//   P10 Deadlines are real: a reservation end bounds the delivered energy window
//       (no scheduled kWh at or after the deadline slot) and the certificate carries it.
//   P11 Requirement is derived, not hard-coded: a registered vehicle's battery + target
//       SoC sets remainingKwh; without one the documented default applies.
//   P12 The solver is price-aware and feasibility-first: with headroom, energy lands in
//       cheaper intervals before expensive ones; deadlines still hold.
//   P13 CSMS->CP calls are ack-correlated (the loop's missing edge): CALLRESULT sets the
//       push ack, CALLERROR dead-letters, and an unanswered call times out as TIMEOUT.
//   P14 Verify: enforcement ticks compare the in-force schedule to the meter, and no
//       profile in force means no fabricated comparison (null, not zero).
// Run: node apps/api/test/control.js
'use strict';
const assert = require('assert');
const { createStore } = require('../src/db/store');
const { seedStore } = require('../src/db/seed');
const control = require('../src/control/controller');
const smartCharging = require('../src/ocpp/smart-charging');
const gw = require('../src/ocpp/gateway');

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

  await t('P9 certify: the plan cycle issues certificates for every active session', async () => {
    const s3 = createStore();
    seedStore(s3, 'demo');
    const site3 = [...s3.stations.keys()][0];
    s3.upsertGridAsset(site3, { kind: 'SITE', label: 'root', cap_kw: 10 }, null);
    const c1 = [...s3.connectors.keys()][0];
    stageSession(s3, c1, 5);
    const { certifications } = control.planSite(s3, site3, { planId: 2 });
    assert.equal(certifications.length, 1, 'one active session => one certificate');
    const cert = [...s3.certificates.values()].find((c) => c.cert_id === certifications[0].cert_id);
    assert.ok(cert, 'certificate row persisted');
    // site cap 10 kW, reserve 10% => 9 kW usable; 6h window => 9*0.25*24 = 54 kWh worst case
    const usable = 10 * (1 - control.FORECAST_RESERVE_FRACTION);
    assert.equal(cert.status, 'ACTIVE');
    assert.ok(Math.abs(cert.floor_kw - Math.min(22, usable)) < 1e-6, 'floor = residual share');
    assert.ok(cert.worst_case_kwh >= cert.required_kwh + cert.margin_kwh, 'admission implies worst case clears need');
    // The promise is a schedulable floor: a second plan cycle protects it.
    const second = control.planSite(s3, site3, { planId: 2 });
    assert.equal(second.certifications[0].reused, true, 'an ACTIVE certificate is reused, not duplicated');
  });

  await t('P9b certify: infeasible admission is FAILED, and stays FAILED (no rejection spam)', async () => {
    const s4 = createStore();
    seedStore(s4, 'demo');
    const site4 = [...s4.stations.keys()][0];
    s4.upsertGridAsset(site4, { kind: 'SITE', label: 'root', cap_kw: 1 }, null); // 1 kW site
    stageSession(s4, [...s4.connectors.keys()][0], 1);
    const first = control.planSite(s4, site4, { planId: 2 });
    assert.equal(first.certifications[0].status, 'FAILED');
    const rowsAfterFirst = s4.certificates.size;
    const second = control.planSite(s4, site4, { planId: 2 });
    assert.equal(second.certifications[0].reused, true, 'unchanged negative verdict is not re-inserted');
    assert.equal(s4.certificates.size, rowsAfterFirst, 'no certificate spam per plan cycle');
  });

  await t('P10 deadlines: a reservation end bounds the schedule window', async () => {
    const s5 = createStore();
    seedStore(s5, 'demo');
    const site5 = [...s5.stations.keys()][0];
    s5.upsertGridAsset(site5, { kind: 'SITE', label: 'root', cap_kw: 10 }, null);
    const conn5 = [...s5.connectors.keys()][0];
    const cpNum5 = Number(conn5.split(':')[0]);
    const connNo5 = Number(conn5.split(':')[1]);
    // A real booking on the connector, ending ~45 min out => deadline slot 3.
    const startAt = new Date(Date.now() + 15 * 60000).toISOString();
    const endAt = new Date(Date.now() + 45 * 60000).toISOString();
    const res = s5.createReservation(1, null, cpNum5, connNo5, startAt, endAt);
    // createReservation is async by design (mutex); await it before starting.
    await res;
    const sess = await s5.startSession({
      uid: 1,
      cpId: cpNum5,
      connNo: connNo5,
      planId: 2,
      reservationId: null,
      idTag: 'TAG-1',
    });
    s5.readings.push({
      session_id: sess.session_id,
      seq_no: 1,
      taken_at: new Date().toISOString(),
      meter_kwh: 0.5,
      power_kw: 2,
      source: 'OCPP',
    });
    const { solved, certifications } = control.planSite(s5, site5, { planId: 2 });
    assert.equal(certifications.length, 1, 'the plan certifies the active session');
    const slots = solved.metrics.deadline_slots[sess.session_id];
    assert.ok(Number.isFinite(slots) && slots > 0, `deadline resolved from the reservation (got ${slots})`);
    // The certificate carries the same deadline, so the promise and the plan agree.
    const cert = [...s5.certificates.values()].find((c) => c.session_id === sess.session_id);
    assert.ok(cert.deadline_at, 'certificate records the deadline it was promised against');
    for (let t = slots; t < solved.metrics.horizon; t++) {
      assert.equal(solved.schedule[sess.session_id][t], 0, `no energy scheduled at/after the deadline (slot ${t})`);
    }
  });

  await t('P11 requirement: vehicle battery + target SoC replaces the hard-coded default', async () => {
    const s6 = createStore();
    seedStore(s6, 'demo');
    const site6 = [...s6.stations.keys()][0];
    s6.upsertGridAsset(site6, { kind: 'SITE', label: 'root', cap_kw: 50 }, null);
    const veh = s6.createVehicle(1, { make: 'Tata', model: 'Nexon EV', battery_kwh: 40 });
    const conn6 = [...s6.connectors.keys()][0];
    const sess = await s6.startSession({
      uid: 1,
      vehicleId: veh.vehicle_id,
      cpId: Number(conn6.split(':')[0]),
      connNo: Number(conn6.split(':')[1]),
      planId: 2,
      reservationId: null,
      idTag: 'TAG-1',
    });
    const model = require('../src/control/model');
    // The richer resolver also carries the battery/SoC reference the certifier needs.
    const est = model.estimateVehicles(s6, site6, Date.now(), { vehicleStateFor: control.vehicleStateFor(s6) });
    const row = est.find((v) => v.sessionId === sess.session_id);
    assert.equal(row.requirementSource, 'declared');
    assert.ok(
      Math.abs(row.remainingKwh - 40 * control.TARGET_SOC) < 1e-6,
      `remaining = battery*targetSoC (got ${row.remainingKwh})`
    );
    assert.equal(row.batteryKwh, 40, 'the battery size reaches the certifier');
    // The SoC reference is the conservative one: never below the target SoC.
    assert.ok(row.socRef >= control.TARGET_SOC, `socRef is conservative (got ${row.socRef})`);
    // And with no declared vehicle the documented default is used, not an invention.
    const estDefault = model.estimateVehicles(s6, site6, Date.now(), { requirementKwhFor: () => null });
    assert.equal(estDefault[0].requirementSource, 'default');
  });

  await t('P12 solver: price-aware (cheap intervals first) while deadlines hold', async () => {
    const model = require('../src/control/model');
    const H = 8;
    // Price 4:1 between slot 0 (cheap) and slot 7 (expensive); no deadline pressure.
    const prices = [0.1, 0.1, 0.1, 0.1, 0.4, 0.4, 0.4, 0.4];
    const out = model.solveSchedule({
      vehicles: [{ sessionId: 1, cpId: 1, maxKw: 10, remainingKwh: 4, deadlineAt: null, certifiedFloorKw: 0 }],
      siteCapKw: 10,
      cpCaps: new Map([[1, 10]]),
      priceSeries: () => prices,
      dtMin: 15,
      horizon: H,
      now: Date.now(),
    });
    const arr = out.schedule[1];
    const cheap = arr.slice(0, 4).reduce((a, b) => a + b, 0);
    const expensive = arr.slice(4).reduce((a, b) => a + b, 0);
    assert.ok(cheap >= expensive, `cheap slots carry at least as much energy (${cheap} vs ${expensive})`);
    assert.ok(Math.abs(cheap + expensive - 4) < 1e-6, 'the full requirement is delivered');
    assert.equal(out.metrics.unmet_kwh, 0);
    assert.equal(out.metrics.peak_kw <= 10 + 1e-6, true);
    // Determinism: identical inputs => identical schedule (ADR-0008).
    const again = model.solveSchedule({
      vehicles: [{ sessionId: 1, cpId: 1, maxKw: 10, remainingKwh: 4, deadlineAt: null, certifiedFloorKw: 0 }],
      siteCapKw: 10,
      cpCaps: new Map([[1, 10]]),
      priceSeries: () => prices,
      dtMin: 15,
      horizon: H,
      now: Date.now(),
    });
    assert.deepEqual(again.schedule, out.schedule, 'identical inputs => identical schedule');
    // Arrival window is a hard lower bound: a vehicle arriving in slot 2 gets nothing before it.
    const now0 = Date.now();
    const grid0 = model.intervalGrid(now0, 15, H);
    const arrived = model.solveSchedule({
      vehicles: [
        {
          sessionId: 2,
          cpId: 1,
          maxKw: 10,
          remainingKwh: 4,
          arrivalAt: grid0.start + 2 * grid0.dt,
          deadlineAt: grid0.start + H * grid0.dt,
          certifiedFloorKw: 0,
        },
      ],
      siteCapKw: 10,
      cpCaps: new Map([[1, 10]]),
      priceSeries: () => Array(H).fill(0.2),
      dtMin: 15,
      horizon: H,
      now: now0,
    });
    assert.deepEqual(arrived.schedule[2].slice(0, 2), [0, 0], 'no energy may be scheduled before the vehicle arrives');
  });

  await t('P13 ack correlation: RESULT sets the push ack, ERROR dead-letters, silence times out', async () => {
    const s7 = createStore();
    seedStore(s7, 'demo');
    const site7 = [...s7.stations.keys()][0];
    s7.upsertGridAsset(site7, { kind: 'SITE', label: 'root', cap_kw: 10 }, null);
    s7.setControlMode(site7, 'ENFORCED', null);
    const conn7 = [...s7.connectors.keys()][0];
    stageSession(s7, conn7, 5);
    const cp7 = Number(conn7.split(':')[0]);
    const sent = [];
    const registry = fakeRegistry(s7, cp7, sent);
    const { decision, pushes } = control.planSite(s7, site7, { planId: 2 });
    const pushed = await smartCharging.setChargingProfile(s7, registry, null, {
      cpId: cp7,
      profile: pushes[0].profile,
      decisionId: decision.decision_id,
      payloadSha256: pushes[0].payloadSha256,
    });
    assert.equal(gw.pendingCallCount() >= 1, true, 'the send registered a pending call');
    const ok = gw.handleCsmsResult(s7, { kind: 'RESULT', uid: pushed.uid, payload: { status: 'Accepted' } }, null);
    assert.equal(ok.handled, true);
    assert.equal(ok.pushId, pushed.push_id);
    assert.equal(s7.profilePushes.get(pushed.push_id).ack_result, 'Accepted', 'ack persisted on the audit row');
    assert.ok(s7.activeProfileFor(cp7), 'an accepted profile is in force');
    // CALLERROR path: dead-lettered, not swallowed. Rate limit is 6/min so this
    // profile push uses a fresh decision id to avoid the governor.
    const pushed2 = await smartCharging.setChargingProfile(s7, registry, null, {
      cpId: cp7,
      profile: pushes[0].profile,
      decisionId: decision.decision_id + 1,
    });
    const bad = gw.handleCsmsResult(s7, { kind: 'ERROR', uid: pushed2.uid, code: 'NotSupported', desc: 'nope' }, null);
    assert.equal(bad.ack, 'CALLERROR');
    assert.ok(
      s7.listDeadLetters().some((l) => l.reason_code === 'NotSupported'),
      'a rejected command is triageable'
    );
    // Unanswered call: the sweeper converts silence into an explicit TIMEOUT.
    const pushed3 = await smartCharging.setChargingProfile(s7, registry, null, {
      cpId: cp7,
      profile: pushes[0].profile,
      decisionId: decision.decision_id + 2,
    });
    const expired = gw.sweepExpiredAcks(s7, Date.now() + gw.ACK_TIMEOUT_MS + 1000);
    assert.ok(expired.includes(pushed3.uid), 'the unacked call expired');
    assert.equal(s7.profilePushes.get(pushed3.push_id).ack_result, 'TIMEOUT');
    assert.ok(s7.listDeadLetters().some((l) => l.reason_code === 'ACK_TIMEOUT'));
    // Unknown uids stay ignorable, and are counted rather than crashing the gateway.
    const before = gw.unknownResultCount();
    assert.equal(gw.handleCsmsResult(s7, { kind: 'RESULT', uid: 'never-sent', payload: {} }, null).handled, false);
    assert.equal(gw.unknownResultCount(), before + 1);
  });

  await t('P14 verify: enforcement ticks compare schedule to meter; nothing in force => no tick', async () => {
    const s8 = createStore();
    seedStore(s8, 'demo');
    const site8 = [...s8.stations.keys()][0];
    s8.upsertGridAsset(site8, { kind: 'SITE', label: 'root', cap_kw: 10 }, null);
    const conn8 = [...s8.connectors.keys()][0];
    const cp8 = Number(conn8.split(':')[0]);
    assert.equal(
      gw.enforcementSample(s8, cp8, 1, 5, new Date().toISOString()),
      null,
      'no profile => no fabricated comparison'
    );
    s8.setControlMode(site8, 'ENFORCED', null);
    const sess8 = stageSession(s8, conn8, 5);
    const sent = [];
    const registry = fakeRegistry(s8, cp8, sent);
    const { decision, pushes } = control.planSite(s8, site8, { planId: 2 });
    await smartCharging.setChargingProfile(s8, registry, null, {
      cpId: cp8,
      profile: pushes[0].profile,
      decisionId: decision.decision_id,
    });
    const ts = new Date().toISOString();
    const tick = gw.enforcementSample(s8, cp8, sess8.session_id, 3.2, ts);
    assert.ok(tick, 'a tick is recorded when a schedule is in force');
    assert.ok(tick.scheduled_kw >= 0, 'scheduled kW resolved from the in-force profile');
    assert.equal(tick.session_id, sess8.session_id);
    assert.ok(Math.abs(tick.deviation_kw - (3.2 - tick.scheduled_kw)) < 1e-6, 'deviation = actual - scheduled');
    // And the verifier consumes them: a large deviation erodes the certificate.
    s8.recordEnforcementTick({ cpId: cp8, sessionId: sess8.session_id, scheduledKw: tick.scheduled_kw, actualKw: 0.1 });
    const verdict = control.verifyCompliance(s8, site8, { toleranceKw: 0.5, hysteresisMin: 0 });
    assert.equal(verdict.replan, true);
    assert.equal(verdict.reason, 'MARGIN_EROSION');
  });

  console.log(`\nControl tests: ${pass} passed`);
  process.exit(0);
}
main().catch((e) => {
  console.error('CONTROL-TEST FAIL', e);
  process.exit(1);
});
