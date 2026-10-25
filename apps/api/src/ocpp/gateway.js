// OCPP 1.6J WebSocket gateway: 1 socket per charge point, 10 msg/s/CP.
// Handles Boot/Heartbeat/Status/Authorize/Start/Meter/Stop; mirrors connector
// state into the store (CLIENT_IDENTIFIER='ocpp-gw' equivalent) exactly like
// the Oracle trigger expects in prod.
// SEC-003: OCPP 1.6 Security Profile 1 — HTTP Basic on upgrade (username=ocpp_identity,
// password=charge_point.auth_secret). A charge point WITHOUT a stored secret is not
// authenticable and is refused outright: an open registration row must not mean an
// open gateway (SEC-041 — the pre-fix behaviour let any guessable identity connect
// credential-less and fabricate sessions + meter input). OCPP_AUTH=off disables everything.
'use strict';
const crypto = require('crypto');
const { parse, result, call, callError } = require('@volthub/ocpp-messages');

let __callUid = 0;
function nextCallId() {
  return `csms-${Date.now().toString(36)}-${++__callUid}`;
}

// ---- CSMS->CP call correlation (ADR-0010 "ack-correlated") --------------------
// The gateway used to drop every CALLRESULT (only CALLs were handled), which made
// actuation fire-and-forget: a charger could answer `Rejected` and nothing in the
// CSMS would know. A bounded pending-call map fixes the loop's missing edge:
//   send -> registerPendingCall(uid, meta) -> CALLRESULT/CALLERROR -> setPushAck.
// Unknown uids stay ignorable (a chatty CP must not crash the gateway), but they are
// counted so the leak is observable.
const ACK_TIMEOUT_MS = Number(process.env.OCPP_ACK_TIMEOUT_MS || 10000);
// Every OCPP 1.6 command has its own success status. `Scheduled` (ChangeAvailability)
// and `RebootRequired` (ChangeConfiguration) are successful outcomes, not rejections.
const ACCEPTED_STATUS = new Set(['Accepted', 'Unlocked', 'Scheduled', 'RebootRequired']);
const pendingCalls = new Map(); // uid -> { action, cpId, identity, pushId, decisionId, deadline, resolve?, reject? }
let unknownResults = 0;
let foreignResults = 0;
let malformedResults = 0;

function registerPendingCall(uid, meta) {
  pendingCalls.set(String(uid), {
    ...meta,
    deadline: Number(meta?.deadline) || Date.now() + ACK_TIMEOUT_MS,
  });
}

function cancelPendingCall(uid) {
  return pendingCalls.delete(String(uid));
}

// Resolve one inbound CALLRESULT/CALLERROR. Returns { handled, ack, pushId }.
// Pure with respect to the socket, so the suite drives it without a TCP peer.
// `from` ({identity, cpId}) binds the answer to the socket that received it: the csms
// call ids are sequential and guessable, and a second connected charger could otherwise
// resolve another CP's pending command with a forged CALLRESULT (F-13).
function handleCsmsResult(store, msg, log, from) {
  if (!msg || (msg.kind !== 'RESULT' && msg.kind !== 'ERROR')) return { handled: false };
  const key = String(msg.uid);
  const meta = pendingCalls.get(key);
  if (!meta) {
    unknownResults++;
    return { handled: false };
  }
  if (from) {
    const identity = typeof from === 'string' ? from : from.identity;
    const cpId = typeof from === 'string' ? null : from.cpId;
    const identityMismatch = meta.identity != null && identity != null && meta.identity !== identity;
    const cpMismatch = meta.cpId != null && cpId != null && Number(meta.cpId) !== Number(cpId);
    if (identityMismatch || cpMismatch) {
      foreignResults++;
      if (log && typeof log.warn === 'function')
        log.warn(
          { action: meta.action, expected: meta.identity ?? meta.cpId, got: identity ?? cpId },
          'ocpp CALLRESULT ignored: answer did not come from the charge point that was sent the call'
        );
      // Keep the pending entry: the legitimate CP may still answer before the deadline.
      return { handled: false, mismatch: true };
    }
  }
  pendingCalls.delete(key);
  let ack;
  if (msg.kind === 'ERROR') {
    ack = 'CALLERROR';
  } else {
    const status = msg.payload && typeof msg.payload.status === 'string' ? msg.payload.status : null;
    if (!status && meta.expectsStatus !== false) {
      // A CALLRESULT without `status` for a command that requires one is malformed;
      // never assume Accepted (F-13 — the old default masked rejected commands).
      malformedResults++;
      ack = 'MALFORMED';
      store.deadLetter({
        eventRef: `ack:${key}`,
        kind: meta.action || 'CSMS_CALL',
        reasonCode: 'MISSING_STATUS',
        detail: 'CALLRESULT did not carry status',
        payload: { cpId: meta.cpId ?? null, decisionId: meta.decisionId ?? null },
      });
    } else {
      // GetConfiguration and similar reads have no `status`; their CALLRESULT is still
      // a successful answer and must not be mislabelled as malformed.
      ack = status || 'RESULT';
      if (status && !ACCEPTED_STATUS.has(status)) {
        // Rejected/NotSupported/... is a poison event with an owner: it belongs in the
        // triage queue, not only in the audit row (ADR-0011).
        store.deadLetter({
          eventRef: `ack:${key}`,
          kind: meta.action || 'CSMS_CALL',
          reasonCode: String(status).toUpperCase(),
          detail: 'charge point rejected the command',
          payload: { cpId: meta.cpId ?? null, decisionId: meta.decisionId ?? null },
        });
      }
    }
  }
  if (meta.pushId != null) store.setPushAck(meta.pushId, ack);
  if (msg.kind === 'ERROR') {
    // A rejected command is a poison event with an owner: it lands in the triage
    // queue instead of a log line (ADR-0011 dead-letter loop).
    store.deadLetter({
      eventRef: `ack:${key}`,
      kind: meta.action || 'CSMS_CALL',
      reasonCode: msg.code || 'CALLERROR',
      detail: msg.desc || null,
      payload: { cpId: meta.cpId ?? null, decisionId: meta.decisionId ?? null },
    });
  }
  // Command senders (the OCPP 1.6 management suite) await the actual CALLRESULT.
  // Fire-and-forget callers leave these callbacks undefined and behave exactly as before.
  const response = {
    uid: key,
    action: meta.action,
    cpId: meta.cpId ?? null,
    ack,
    status: msg.kind === 'RESULT' && msg.payload && typeof msg.payload.status === 'string' ? msg.payload.status : null,
    payload: msg.kind === 'RESULT' ? msg.payload || {} : null,
  };
  if (typeof meta.resolve === 'function') {
    try {
      if (ack === 'MALFORMED' || msg.kind === 'ERROR') {
        const err = new Error(
          msg.kind === 'ERROR'
            ? msg.desc || `charge point returned ${msg.code || 'CALLERROR'}`
            : 'charge point CALLRESULT did not carry status'
        );
        err.code = msg.kind === 'ERROR' ? msg.code || 'CALLERROR' : 'MALFORMED_RESULT';
        err.status = 502;
        err.ocpp = response;
        if (typeof meta.reject === 'function') meta.reject(err);
        else meta.resolve(response);
      } else {
        meta.resolve(response);
      }
    } catch (err) {
      if (log && typeof log.warn === 'function') log.warn({ err: err.message }, 'ocpp command settle callback failed');
    }
  } else if (msg.kind === 'ERROR' && typeof meta.reject === 'function') {
    const err = new Error(msg.desc || `charge point returned ${msg.code || 'CALLERROR'}`);
    err.code = msg.code || 'CALLERROR';
    err.status = 502;
    err.ocpp = response;
    try {
      meta.reject(err);
    } catch (e) {
      if (log && typeof log.warn === 'function') log.warn({ err: e.message }, 'ocpp command reject callback failed');
    }
  }
  if (log && typeof log.info === 'function')
    log.info({ action: meta.action, cpId: meta.cpId, ack }, 'ocpp CALLRESULT correlated');
  return {
    handled: true,
    ack,
    pushId: meta.pushId ?? null,
    action: meta.action,
    cpId: meta.cpId ?? null,
    response,
  };
}

// Timeout sweep: an unanswered CSMS call must not stay pending forever (the charger
// is gone, wedged, or silently dropping frames). Expired calls are dead-lettered and
// the push audit row records TIMEOUT — the honest alternative to "assume Accepted".
function sweepExpiredAcks(store, now) {
  const nowMs = now || Date.now();
  const expired = [];
  for (const [uid, meta] of pendingCalls) {
    if (meta.deadline > nowMs) continue;
    pendingCalls.delete(uid);
    if (meta.pushId != null) store.setPushAck(meta.pushId, 'TIMEOUT');
    store.deadLetter({
      eventRef: `ack-timeout:${uid}`,
      kind: meta.action || 'CSMS_CALL',
      reasonCode: 'ACK_TIMEOUT',
      detail: `no CALLRESULT within ${ACK_TIMEOUT_MS} ms`,
      payload: { cpId: meta.cpId ?? null, decisionId: meta.decisionId ?? null },
    });
    if (typeof meta.reject === 'function') {
      const err = new Error(`CP_TIMEOUT: no CALLRESULT within ${ACK_TIMEOUT_MS} ms`);
      err.code = 'CP_TIMEOUT';
      err.status = 504;
      try {
        meta.reject(err);
      } catch {
        /* the caller is gone; the dead letter is the durable record */
      }
    }
    expired.push(uid);
  }
  return expired;
}

// Enforcement telemetry (ADR-0010 step "verify"): the scheduled kW of the profile in
// force versus what the meter actually reports. Returns the recorded tick, or null
// when no profile is in force (ADVISORY sites and non-compliant chargers must not
// manufacture a comparison that does not exist).
function enforcementSample(store, cpId, sessionId, powerKw, ts) {
  if (typeof store.scheduledKwAt !== 'function') return null;
  const scheduledKw = store.scheduledKwAt(cpId, Date.parse(ts));
  if (scheduledKw == null) return null;
  const push = typeof store.activeProfileFor === 'function' ? store.activeProfileFor(cpId) : null;
  return store.recordEnforcementTick({
    cpId: Number(cpId),
    sessionId: sessionId != null ? Number(sessionId) : null,
    decisionId: push ? push.decision_id : null,
    scheduledKw,
    actualKw: powerKw,
    ts,
  });
}

// B2G-009: CSMS→CP remote commands (half-duplex fix). Fire-and-forget CALL over the
// stored socket; the CP answers with CALLRESULT (handled in the RESULT branch below).
// Currently used by POST /sessions/:id/remote-stop; RemoteStart shares the plumbing.
function stopTransaction(registry, identity, sessionId, log) {
  const ws = registry?.get?.(identity);
  if (!ws || ws.readyState !== 1) {
    const e = new Error(`CP_OFFLINE: ${identity} not connected`);
    e.code = 'CP_OFFLINE';
    e.status = 409;
    return Promise.reject(e);
  }
  const uid = nextCallId();
  try {
    ws.send(call(uid, 'RemoteStopTransaction', { transactionId: Number(sessionId) }));
  } catch (e) {
    return Promise.reject(e);
  }
  // Correlate the CP's answer too: a rejected remote stop must be observable, not
  // assumed (the same registry that carries SetChargingProfile acks).
  registerPendingCall(uid, { action: 'RemoteStopTransaction', cpId: null, identity, sessionId: Number(sessionId) });
  // B3G-001: method-call form preserves pino `this` (detached log.info throws msgPrefix TypeError).
  if (log && typeof log.info === 'function') log.info({ identity, sessionId }, 'ocpp RemoteStopTransaction sent');
  return Promise.resolve({ uid, identity, transactionId: Number(sessionId) });
}
function startTransaction(registry, identity, idTag, connectorId, log) {
  const ws = registry?.get?.(identity);
  if (!ws || ws.readyState !== 1) {
    const e = new Error(`CP_OFFLINE: ${identity} not connected`);
    e.code = 'CP_OFFLINE';
    e.status = 409;
    return Promise.reject(e);
  }
  const uid = nextCallId();
  try {
    ws.send(call(uid, 'RemoteStartTransaction', { idTag, connectorId: Number(connectorId) }));
  } catch (e) {
    return Promise.reject(e);
  }
  registerPendingCall(uid, { action: 'RemoteStartTransaction', cpId: null, identity });
  if (log && typeof log.info === 'function') log.info({ identity, idTag }, 'ocpp RemoteStartTransaction sent');
  return Promise.resolve({ uid, identity });
}

function checkBasic(req, identity, cp) {
  const secret = cp?.auth_secret;
  const mode = process.env.OCPP_AUTH || 'per-cp'; // per-cp | require | off
  const prod = process.env.NODE_ENV === 'production';
  // SEC-041/SEC-069: OCPP_AUTH=off exists for isolated labs. In production it would turn
  // the gateway into an unauthenticated command surface for any charger that can reach
  // it, so the switch is ignored there (fail closed).
  if (mode === 'off' && !prod) return true;
  // SEC-041 (review 2026-10-24): a CP row with no auth_secret is NOT authenticable.
  // The old `!secret => allow` bypass turned every seeded/hydrated deployment into an
  // open gateway (anyone could connect as any guessable identity). Provision a secret
  // via the admin API, or set OCPP_AUTH=off explicitly for an isolated lab.
  if (!secret) return false;
  // Demo seeds and the simulator share `dev-<identity>` secrets. They are published in
  // the repository, so accepting them in production would be equivalent to no auth.
  if (prod && /^dev-/.test(String(secret))) return false;
  const h = String(req.headers?.authorization || '');
  const m = /^Basic (.+)$/.exec(h);
  if (!m) return false;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  const user = decoded.slice(0, idx),
    pass = decoded.slice(idx + 1);
  if (user !== identity) return false;
  const a = Buffer.from(pass),
    b = Buffer.from(String(secret || ''));
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function mountOcpp(wss, store, log) {
  const registry = new Map(); // ocpp_identity -> ws
  // Ack sweeper: unref'd so it never holds the process (or a test suite) open.
  const ackSweeper = setInterval(
    () => {
      try {
        sweepExpiredAcks(store);
      } catch (err) {
        log.warn({ err: err.message }, 'ack sweep failed');
      }
    },
    Math.max(1000, Math.floor(ACK_TIMEOUT_MS / 2))
  );
  if (typeof ackSweeper.unref === 'function') ackSweeper.unref();
  wss.on('close', () => clearInterval(ackSweeper));
  const lastMsg = new Map();
  const seqByTx = new Map(); // BUG-006: monotonic per-session seq (OCPP has no seq; gateway owns it)
  global.__ocppTickCursor = seqByTx; // test seam (BUG-024): lets a suite drop the cursor to simulate a CSMS restart

  wss.on('connection', (ws, req) => {
    const m = String(req.url || '').match(/\/ocpp\/([^/?]+)/);
    const identity = m ? decodeURIComponent(m[1]) : null;
    if (!identity || !store.cpsByOcpp.has(identity)) {
      ws.close(4404, 'unknown charge point identity');
      return;
    }
    const cpId = store.cpsByOcpp.get(identity);
    const cp = store.cps.get(cpId);
    if (!checkBasic(req, identity, cp)) {
      try {
        ws.close(4401, 'ocpp basic auth required (Security Profile 1)');
      } catch {}
      // Method-call form: a detached `(log.warn || log.info)(...)` loses pino `this`
      // and throws under pino 9/10 (B3G-001) — always call as a method.
      log.warn({ identity }, 'ocpp rejected: bad basic auth');
      return;
    }
    cp.status = 'ONLINE';
    cp.last_seen_at = new Date().toISOString();
    // Duplicate connection: close the stale socket so one identity == one socket (OCPP 1.6J §4).
    const prev = registry.get(identity);
    if (prev && prev !== ws) {
      try {
        prev.close(4400, 'duplicate charge point identity');
      } catch {}
    }
    registry.set(identity, ws);
    log.info({ identity }, 'ocpp connected');

    ws.on('message', async (raw) => {
      // The rate limit counts RAW frames (a malformed-frame flood must not bypass
      // the limiter by being unparseable), but the violation CALLERROR carries the
      // offending message's uid whenever the frame parses (PROTO-002: answering
      // uid '0' to a parsed CALL is not a valid OCPP reply).
      let msg = null;
      try {
        msg = parse(raw);
      } catch {
        msg = null;
      }
      // ADR-0018: a CALLRESULT/CALLERROR that answers a call this CSMS actually sent is
      // not charge-point chatter and must not consume its 10 CALL/s budget. A management
      // burst (11 commands in one second) otherwise had its answers rate-limited, so the
      // commands timed out even though the charger replied instantly. Only uids that are
      // pending for THIS socket bypass the limiter; forged/unknown results still count.
      if (msg && (msg.kind === 'RESULT' || msg.kind === 'ERROR')) {
        const pending = pendingCalls.get(String(msg.uid));
        const fromThisCp =
          pending &&
          (pending.identity == null || pending.identity === identity) &&
          (pending.cpId == null || Number(pending.cpId) === Number(cpId));
        if (fromThisCp) {
          handleCsmsResult(store, msg, log, { identity, cpId });
          return;
        }
      }
      const now = Date.now();
      const arr = (lastMsg.get(identity) || []).filter((t) => now - t < 1000);
      arr.push(now);
      lastMsg.set(identity, arr);
      const overLimit = arr.length > 10;
      if (overLimit) {
        // SEC-042: these two sends run BEFORE the handler's try/catch — a throw from a
        // dying socket rejected the async listener (process-fatal unhandled rejection).
        try {
          ws.send(callError(msg ? msg.uid : '0', 'FormationViolation', 'rate limit 10 msg/s per charge point'));
        } catch {}
        return;
      }
      if (!msg) {
        try {
          ws.send(callError('0', 'FormationViolation'));
        } catch {}
        return;
      }
      // B2G-009 + ADR-0010: CSMS-initiated CALLs get CALLRESULT/CALLERROR answers.
      // They are correlated against the pending-call registry above (the previous
      // behaviour — log and drop — broke the control loop's verify stage).
      if (msg.kind === 'RESULT' || msg.kind === 'ERROR') {
        handleCsmsResult(store, msg, log, { identity, cpId });
        return;
      }
      if (msg.kind !== 'CALL') return;
      const p = msg.payload || {};
      try {
        switch (msg.action) {
          case 'BootNotification':
            cp.last_boot_at = new Date().toISOString();
            ws.send(result(msg.uid, { status: 'Accepted', currentTime: new Date().toISOString(), interval: 60 }));
            break;
          case 'Heartbeat':
            cp.last_seen_at = new Date().toISOString();
            ws.send(result(msg.uid, { currentTime: new Date().toISOString() }));
            break;
          case 'StatusNotification': {
            const key = `${cpId}:${p.connectorId}`;
            const c = store.connectors.get(key);
            if (c) {
              const map = {
                Available: 'AVAILABLE',
                Occupied: 'OCCUPIED',
                Reserved: 'RESERVED',
                Faulted: 'FAULTED',
                Unavailable: 'UNAVAILABLE',
              };
              let to = map[p.status] || 'UNAVAILABLE';
              // A CP must not be able to erase CSMS-owned state with a stale
              // "Available": during an active session that would make the connector
              // bookable again (double-booking), and during a live reservation it
              // would let a walk-up driver take the reserved window. Keep the
              // authoritative state for those two cases; physical faults/unavailability
              // still pass through.
              if (to === 'AVAILABLE') {
                // PF-03: the connector row is the authoritative derived state — every
                // start/transition and reservation path writes it, including hydration.
                // Scanning all sessions and reservations per StatusNotification made a
                // single frame O(fleet) (40 ms at 1M rows); two comparisons are enough.
                if (c.status === 'OCCUPIED') to = 'OCCUPIED';
                else if (c.status === 'RESERVED') to = 'RESERVED';
              }
              const from = c.status;
              c.status = to;
              c.last_state_change_at = new Date().toISOString();
              if (p.errorCode && p.errorCode !== 'NoError') {
                const fid = ++store.seq.fault;
                store.faults.set(fid, {
                  fault_id: fid,
                  connector_ref: `${cpId}:${p.connectorId}`,
                  cp_id: cpId,
                  error_code: p.errorCode,
                  severity: 'WARN',
                  source: 'OCPP',
                  description: p.info || null,
                  reported_by: null,
                  reported_at: new Date().toISOString(),
                  cleared_at: null,
                });
              } else {
                // BUG-062: a NoError report clears this connector's open OCPP faults —
                // previously only the manual maintenance route ever set cleared_at, so
                // triage queues filled with faults the charger had already recovered from.
                const fref = `${cpId}:${p.connectorId}`;
                const nowIso = new Date().toISOString();
                for (const f of store.faults.values())
                  if (f.connector_ref === fref && f.source === 'OCPP' && !f.cleared_at) f.cleared_at = nowIso;
              }
              store.emitOutbox('CONNECTOR_STATE', `ocpp:${cpId}:${p.connectorId}:${Date.now()}`, {
                connector_ref: `${cpId}:${p.connectorId}`,
                from,
                to,
                cause: 'OCPP',
              });
              store.stateEvents.push({
                ts: new Date().toISOString(),
                connector_ref: `${cpId}:${p.connectorId}`,
                from_state: from,
                to_state: to,
                cause: 'OCPP',
                session_id: null,
              });
            }
            ws.send(result(msg.uid, {}));
            break;
          }
          case 'Authorize': {
            // BUG-002 fix: allow-list only. TAG-<user_id> of an existing user => Accepted, else Invalid.
            const m2 = /^TAG-(\d+)$/.exec(String(p.idTag || ''));
            const ok = !!(m2 && store.users.has(Number(m2[1])));
            ws.send(result(msg.uid, { idTagInfo: { status: ok ? 'Accepted' : 'Invalid' } }));
            break;
          }
          case 'StartTransaction': {
            const tagUid = /^TAG-(\d+)$/.exec(p.idTag || '');
            // BUG-002 follow-on: reject unknown tags instead of silently billing user 1.
            if (!tagUid || !store.users.has(Number(tagUid[1]))) {
              ws.send(result(msg.uid, { transactionId: 0, idTagInfo: { status: 'Invalid' } }));
              break;
            }
            const uid = Number(tagUid[1]);
            // BUG-054 (review 2026-10-24): meterStart is the charger's absolute register
            // at plug-in. OCPP sends Wh. Ignoring it billed every charger with a non-zero
            // register for energy it never delivered (bill = end − start, start was 0).
            const meterStartRaw = Number(p.meterStart);
            const meterStartKwh = Number.isFinite(meterStartRaw) ? meterStartRaw / 1000 : 0;
            const sess = await store
              .startSession({
                uid,
                vehicleId: null,
                cpId,
                connNo: p.connectorId,
                planId: store.defaultPlanId ? store.defaultPlanId() : 2,
                reservationId: null,
                idTag: p.idTag,
                meterStartKwh,
              })
              .catch((e) => {
                // B2G-013b: a foreign idTag on a RESERVED connector must read as Invalid
                // (Authorize/Start semantics), not a CSMS InternalError.
                if (e && e.code === 'RESERVATION_MISMATCH') {
                  ws.send(result(msg.uid, { transactionId: 0, idTagInfo: { status: 'Invalid' } }));
                  return null;
                }
                throw e;
              });
            if (!sess) break;
            seqByTx.set(sess.session_id, 0);
            ws.send(result(msg.uid, { transactionId: sess.session_id, idTagInfo: { status: 'Accepted' } }));
            break;
          }
          case 'MeterValues': {
            const tx = p.transactionId;
            const vals = [...(p.meterValue || [])].flatMap((mv) => mv.sampledValue || []);
            const e = vals.find((v) => v.measurand === 'Energy.Active.Import.Register');
            const pr = vals.find((v) => v.measurand === 'Power.Active.Import');
            // BUG-006 fix: monotonic per-session counter, never Date.now() (collides + breaks (session_id,seq_no) PK).
            // BUG-024 fix: seqByTx is memory-only, but sessions are durable (Oracle + hydrate).
            // After a CSMS restart, an in-flight session's counter would restart at 1 and
            // every replayed seq_no would be silently swallowed by the store's idempotent
            // dedupe ({deduped:true}) — meter data dropped until the counter caught up.
            // Recover the cursor from the persisted readings on first sight of a session.
            if (tx) {
              const sid = Number(tx);
              // A charge point may only meter its own sessions. Without this check any
              // authenticated CP could inject readings into (and thereby inflate the
              // bill of) another CP's live transaction. (Applies to EVERY frame, not
              // just energy-bearing ones.)
              const owner = store.sessions.get(sid);
              if (owner && Number(owner.cp_id) !== Number(cpId)) {
                ws.send(callError(msg.uid, 'SecurityError', `transaction ${sid} is not owned by ${identity}`));
                break;
              }
              if (!seqByTx.has(sid)) {
                // PF-03: readingsFor() is the store's O(1) per-session index; filtering
                // the global telemetry array here made every session's first frame scan
                // all history.
                const maxSeq = store.readingsFor(sid).reduce((m, r) => Math.max(m, Number(r.seq_no) || 0), 0);
                seqByTx.set(sid, maxSeq);
                if (maxSeq) log.info({ identity, sessionId: sid, maxSeq }, 'ocpp tick cursor recovered after restart');
              }
              if (e) {
                // SampledValue.value is a string. A register that does not parse is a
                // malformed frame, not a session fault: answer TypeMismatch BEFORE a
                // sequence number is spent, and never hand NaN to the store — Timescale
                // float8 would store it as a legitimate-looking row (NaN = NaN is TRUE
                // there, so nothing downstream spots it) while Oracle rejects the bind.
                const register = Number(e.value) / 1000;
                if (!Number.isFinite(register)) {
                  ws.send(callError(msg.uid, 'TypeMismatch', `unparsable energy register: ${JSON.stringify(e.value)}`));
                  break;
                }
                const next = seqByTx.get(sid) + 1;
                seqByTx.set(sid, next);
                const sampledAt = new Date().toISOString();
                const powerRaw = pr ? Number(pr.value) / 1000 : null;
                const sampledKw = Number.isFinite(powerRaw) ? powerRaw : null;
                await store.recordTick(sid, next, sampledAt, register, sampledKw, null, null);
                // Verify stage: only after the tick is durably recorded do we compare it
                // to the schedule in force — a tick that was rejected/deduped must not
                // become compliance evidence.
                try {
                  enforcementSample(store, cpId, sid, sampledKw, sampledAt);
                } catch (err) {
                  log.warn({ identity, err: err.message }, 'enforcement sample failed');
                }
              } else if (pr) {
                // BUG-061: a frame carrying ONLY power (no energy measurand) used to be
                // ACKed and dropped — real chargers do this between register updates, so
                // the power trace lost its cadence. Carry the last known register
                // forward: energy is unchanged (billing reads max(reading), unaffected),
                // the power sample is preserved.
                const next = seqByTx.get(sid) + 1;
                seqByTx.set(sid, next);
                const sampledAt = new Date().toISOString();
                const powerRaw = Number(pr.value) / 1000;
                const sampledKw = Number.isFinite(powerRaw) ? powerRaw : null;
                // PF-03: per-session index, not a full telemetry scan on every
                // power-only frame. The reduce still handles out-of-order replays.
                const lastKwh = store
                  .readingsFor(sid)
                  .reduce((m, r) => Math.max(m, Number(r.meter_kwh) || 0), Number(owner?.start_meter_kwh) || 0);
                await store.recordTick(sid, next, sampledAt, lastKwh, sampledKw, null, null);
                try {
                  enforcementSample(store, cpId, sid, sampledKw, sampledAt);
                } catch (err) {
                  log.warn({ identity, err: err.message }, 'enforcement sample failed');
                }
              }
              // frames with neither measurand (SoC/voltage-only) stay ACK-only.
            }
            ws.send(result(msg.uid, {}));
            break;
          }
          case 'StopTransaction': {
            if (p.transactionId) {
              const sess = store.sessions.get(Number(p.transactionId));
              if (sess) {
                if (Number(sess.cp_id) !== Number(cpId)) {
                  ws.send(
                    callError(msg.uid, 'SecurityError', `transaction ${p.transactionId} is not owned by ${identity}`)
                  );
                  break;
                }
                // BUG-020 fix: 0 Wh is valid — only fall back when meterStop is absent/NaN.
                const stopKwh = Number(p.meterStop);
                const endMeterKwh = Number.isFinite(stopKwh) ? stopKwh / 1000 : undefined;
                seqByTx.delete(Number(p.transactionId));
                // PROTO-003: a CP may stop a transaction that never delivered a tick
                // (plug-in then stop). PREPARING ends as CANCELLED — not an
                // ILLEGAL_TRANSITION InternalError.
                // SEC-067: stopSession persists the meter on BOTH engines. The old
                // direct field write lived only in the Oracle adapter's read-cache, so
                // the durable invoice priced 0 kWh.
                await store.stopSession(p.transactionId, 'OCPP_STOP', endMeterKwh);
              }
            }
            ws.send(result(msg.uid, { idTagInfo: { status: 'Accepted' } }));
            break;
          }
          default:
            ws.send(callError(msg.uid, 'NotSupported', msg.action));
        }
      } catch (e) {
        // The catch's own send can throw on a dying socket — that must not turn an
        // InternalError answer into an unhandled rejection (same window as SEC-042).
        try {
          ws.send(callError(msg.uid, 'InternalError', e.message));
        } catch {}
      }
    });
    ws.on('error', (err) => {
      // HARD-001: oversized frames (maxPayload 1009) and socket faults emit 'error'
      // before 'close'. Without this handler an unhandled 'error' would crash the
      // whole API process on one bad charge point. Cleanup is the close handler's job.
      log.warn({ identity, err: err.message }, 'ocpp socket error');
    });
    ws.on('close', () => {
      // BUG-021: only the socket that OWNS the registry slot may deregister it.
      // When a CP reconnects, the gateway closes the stale predecessor (above) —
      // that predecessor's close event must NOT delete the successor's registration
      // or flip the live CP to OFFLINE (remote commands resolve via registry.get).
      if (registry.get(identity) === ws) {
        registry.delete(identity);
        cp.status = 'OFFLINE';
      }
      log.info({ identity }, 'ocpp disconnected');
    });
  });
  return registry;
}

module.exports = {
  mountOcpp,
  checkBasic,
  stopTransaction,
  startTransaction,
  registerPendingCall,
  cancelPendingCall,
  handleCsmsResult,
  sweepExpiredAcks,
  ACCEPTED_STATUS,
  enforcementSample,
  pendingCallCount: () => pendingCalls.size,
  unknownResultCount: () => unknownResults,
  foreignResultCount: () => foreignResults,
  malformedResultCount: () => malformedResults,
  ACK_TIMEOUT_MS,
};
