'use client';
import { useEffect, useState } from 'react';
import { api, Pill, inr, PageHead, PageState, ConfirmDialog } from '../../lib/ui';

const TABS = [
  ['overview', 'Overview'],
  ['stations', 'Stations'],
  ['ocpp', 'OCPP commands'],
  ['tariffs', 'Tariffs'],
  ['audit', 'Audit log'],
];

const CMD_TEMPLATES = {
  Reset: { type: 'Soft' },
  UnlockConnector: { connectorId: 1 },
  ChangeAvailability: { connectorId: 0, type: 'Operative' },
  GetConfiguration: {},
  ChangeConfiguration: { key: 'HeartbeatInterval', value: '60' },
  TriggerMessage: { requestedMessage: 'StatusNotification', connectorId: 1 },
  ReserveNow: {
    connectorId: 1,
    idTag: 'DEMO-TAG',
    reservationId: 9001,
  },
  CancelReservation: { reservationId: 9001 },
  ClearCache: {},
  DataTransfer: { vendorId: 'com.volthub.console', messageId: 'ping', data: '{}' },
};

// ReserveNow needs a future expiry. Compute it when the action is chosen, not at
// module load, so server and client render the same initial Reset template.
function commandTemplate(action) {
  const base = CMD_TEMPLATES[action] || {};
  if (action !== 'ReserveNow') return { ...base };
  return { ...base, expiryDate: new Date(Date.now() + 3600e3).toISOString() };
}

export default function Admin() {
  const [tab, setTab] = useState('overview');
  const [logs, setLogs] = useState([]);
  const [plans, setPlans] = useState([]);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState('');
  const [nu, setNu] = useState({ email: '', full_name: '', role: 'OPERATOR' });
  const [stations, setStations] = useState([]);
  const [ns, setNs] = useState({ name: '', latitude: '12.99', longitude: '80.21', city: 'Chennai' });
  const [confirmUser, setConfirmUser] = useState(false);
  const [confirmStation, setConfirmStation] = useState(false);
  const [confirmVersion, setConfirmVersion] = useState(false);
  const [versionName, setVersionName] = useState('City Day v3');
  const [flipTarget, setFlipTarget] = useState(null);
  const [cps, setCps] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [cmdCp, setCmdCp] = useState('');
  const [cmdAction, setCmdAction] = useState('Reset');
  const [cmdJson, setCmdJson] = useState(() => JSON.stringify(commandTemplate('Reset'), null, 2));
  const [cmdOut, setCmdOut] = useState(null);
  const [cmdBusy, setCmdBusy] = useState(false);
  useEffect(() => {
    api('/admin/audit-logs')
      .then((j) => setLogs(j.logs))
      .catch((e) => setMsg(e.message));
    api('/admin/tariff-plans')
      .then((j) => setPlans(j.plans))
      .catch(() => {});
    api('/admin/stations')
      .then((j) => setStations(j.stations))
      .catch(() => {});
    api('/admin/charge-points')
      .then((j) => setCps(j.charge_points))
      .catch(() => {});
    api('/control/commands')
      .then((j) => setCatalog(j.commands))
      .catch(() => {});
  }, []);
  const pickAction = (a) => {
    setCmdAction(a);
    setCmdJson(JSON.stringify(commandTemplate(a), null, 2));
    setCmdOut(null);
  };
  const sendCommand = async () => {
    if (!cmdCp) return setMsg('Select a charge point first.');
    let body;
    try {
      body = cmdJson.trim() ? JSON.parse(cmdJson) : {};
    } catch {
      return setMsg('Payload is not valid JSON.');
    }
    setMsg('');
    setOk('');
    setCmdOut(null);
    setCmdBusy(true);
    try {
      const j = await api(`/control/cp/${cmdCp}/commands/${cmdAction.toLowerCase()}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setCmdOut(j.command);
      setOk(`${cmdAction} acknowledged by CP ${cmdCp}.`);
      api('/admin/charge-points')
        .then((x) => setCps(x.charge_points))
        .catch(() => {});
    } catch (e) {
      setCmdOut({ error: { code: e.code || 'COMMAND_FAILED', message: e.message } });
      setMsg(`${e.code || 'COMMAND_FAILED'}: ${e.message}`);
    } finally {
      setCmdBusy(false);
    }
  };
  const selectedCatalog = catalog.find((c) => c.action === cmdAction);
  const addUser = async () => {
    setConfirmUser(false);
    setMsg('');
    try {
      await api('/admin/users', { method: 'POST', body: JSON.stringify(nu) });
      setOk(`Operator ${nu.email} created.`);
      setNu({ email: '', full_name: '', role: 'OPERATOR' });
    } catch (e) {
      setMsg(e.message);
    }
  };
  const newVersion = async () => {
    setConfirmVersion(false);
    setMsg('');
    try {
      await api('/admin/tariff-plans', {
        method: 'POST',
        body: JSON.stringify({
          group_id: 1,
          name: versionName,
          session_fee: 20,
          bands: [{ day_scope: 'ALL', start_time: '00:00', end_time: '24:00', price_per_kwh: 24 }],
        }),
      });
      const j = await api('/admin/tariff-plans');
      setPlans(j.plans);
      setOk(`Tariff version "${versionName}" created — the previous version is superseded, not edited.`);
    } catch (e) {
      setMsg(e.message);
    }
  };
  const addStation = async () => {
    setConfirmStation(false);
    setMsg('');
    try {
      await api('/admin/stations', {
        method: 'POST',
        body: JSON.stringify({
          ...ns,
          latitude: Number(ns.latitude),
          longitude: Number(ns.longitude),
          charge_points: [{ model: 'VH-AC22', connectors: [{ standard: 'TYPE2', max_power_kw: 22 }] }],
        }),
      });
      const j = await api('/admin/stations');
      setStations(j.stations);
      setOk(`Station "${ns.name}" provisioned with 1×AC22 — OCPP identities auto-assigned.`);
    } catch (e) {
      setMsg(e.message);
    }
  };
  const flipStation = async () => {
    const s = flipTarget;
    setFlipTarget(null);
    try {
      await api(`/admin/stations/${s.station_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: s.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }),
      });
      const j = await api('/admin/stations');
      setStations(j.stations);
    } catch (e) {
      setMsg(e.message);
    }
  };
  return (
    <div className="wrap">
      <PageHead
        eyebrow="ADMIN · PROVISIONING, TARIFFS, AUDIT"
        title="Control"
        lede="Tariff versions supersede, never edit; stations provision with identities auto-assigned; the audit log keeps the receipts."
      />
      <div
        style={{ display: 'flex', gap: 6, margin: 'var(--sp-4) 0', flexWrap: 'wrap' }}
        role="tablist"
        aria-label="Admin sections"
      >
        {TABS.map(([t, label]) => (
          <button key={t} className="btn" onClick={() => setTab(t)} aria-pressed={tab === t}>
            {label}
          </button>
        ))}
      </div>
      {ok && (
        <p className="okmsg" role="status">
          {ok}
        </p>
      )}
      {msg && (
        <p className="err" role="alert">
          {msg}
        </p>
      )}
      {tab === 'overview' && (
        <section className="card" style={{ maxWidth: 640 }}>
          <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
            <h2 style={{ fontSize: '1rem' }}>Create operator</h2>
            <p>Admin only — operators run stations and triage faults.</p>
          </div>
          <form
            className="fieldrow"
            onSubmit={(e) => {
              e.preventDefault();
              setConfirmUser(true);
            }}
          >
            <input
              placeholder="Email"
              type="email"
              aria-label="Operator email"
              value={nu.email}
              onChange={(e) => setNu({ ...nu, email: e.target.value })}
              required
            />
            <input
              placeholder="Full name"
              aria-label="Operator full name"
              value={nu.full_name}
              onChange={(e) => setNu({ ...nu, full_name: e.target.value })}
              required
            />
            <button className="btn pri" type="submit">
              Create
            </button>
          </form>
        </section>
      )}
      {tab === 'stations' && (
        <div className="grid">
          <section className="card">
            <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
              <h2 style={{ fontSize: '1rem' }}>Provision station</h2>
              <p>Ships with one AC22 charge point; add more later.</p>
            </div>
            <form
              className="fieldrow"
              onSubmit={(e) => {
                e.preventDefault();
                setConfirmStation(true);
              }}
            >
              <input
                placeholder="Name"
                aria-label="Station name"
                value={ns.name}
                onChange={(e) => setNs({ ...ns, name: e.target.value })}
                required
              />
              <input
                placeholder="Latitude"
                aria-label="Latitude"
                type="number"
                step="any"
                value={ns.latitude}
                onChange={(e) => setNs({ ...ns, latitude: e.target.value })}
                style={{ maxWidth: 120 }}
                required
              />
              <input
                placeholder="Longitude"
                aria-label="Longitude"
                type="number"
                step="any"
                value={ns.longitude}
                onChange={(e) => setNs({ ...ns, longitude: e.target.value })}
                style={{ maxWidth: 120 }}
                required
              />
              <button className="btn pri" type="submit">
                Provision + 1×AC22
              </button>
            </form>
          </section>
          <div className="tscroll">
            <table className="t">
              <caption className="micro" style={{ textAlign: 'left', paddingBottom: 8 }}>
                Stations in this deployment
              </caption>
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Name</th>
                  <th scope="col">Points</th>
                  <th scope="col">Connectors</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {stations.map((s) => (
                  <tr key={s.station_id}>
                    <td className="n">#{s.station_id}</td>
                    <td>{s.name}</td>
                    <td className="n">{s.points}</td>
                    <td className="n">{s.connectors}</td>
                    <td>
                      <Pill s={s.status === 'ACTIVE' ? 'AVAILABLE' : 'OFFLINE'} />
                    </td>
                    <td>
                      <button className="btn sm" onClick={() => setFlipTarget(s)}>
                        {s.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {tab === 'ocpp' && (
        <div className="grid" style={{ gap: 'var(--sp-4)' }}>
          <section className="card">
            <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
              <h2 style={{ fontSize: '1rem' }}>Charge-point command console</h2>
              <p>
                Ten allow-listed OCPP 1.6J commands. Every send waits for the charger’s CALLRESULT — an offline unit is
                a 409, a timeout is a 504, a rejection is surfaced, never swallowed.
              </p>
            </div>
            <div className="fieldrow" style={{ alignItems: 'end' }}>
              <label className="f" style={{ flex: '1 1 320px' }}>
                Charge point
                <select value={cmdCp} onChange={(e) => setCmdCp(e.target.value)} aria-describedby="ocpp-help">
                  <option value="">Select a charge point…</option>
                  {cps.map((c) => (
                    <option key={c.cp_id} value={c.cp_id}>
                      {c.ocpp_identity} · {c.station_name || `station ${c.station_id}`} · {c.status}
                    </option>
                  ))}
                </select>
              </label>
              <label className="f" style={{ flex: '0 1 220px' }}>
                Command
                <select value={cmdAction} onChange={(e) => pickAction(e.target.value)}>
                  {catalog.map((c) => (
                    <option key={c.action} value={c.action}>
                      {c.action}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="micro" id="ocpp-help" style={{ marginTop: 'var(--sp-2)' }}>
              ADMIN only · awaited CALLRESULT · audited. `GetConfiguration` returns the charger payload rather than a
              status.
            </p>
            <label className="f" style={{ marginTop: 'var(--sp-3)' }}>
              Payload (JSON)
              <textarea
                value={cmdJson}
                onChange={(e) => setCmdJson(e.target.value)}
                rows={8}
                spellCheck={false}
                style={{ fontFamily: 'var(--font-plex-mono), monospace', fontSize: 13 }}
              />
            </label>
            {selectedCatalog && Object.keys(selectedCatalog.payload || {}).length > 0 && (
              <ul className="micro" style={{ margin: 'var(--sp-2) 0 0', paddingLeft: 18 }}>
                {Object.entries(selectedCatalog.payload).map(([k, v]) => (
                  <li key={k}>
                    <code>{k}</code>: {v}
                  </li>
                ))}
              </ul>
            )}
            <button
              className="btn pri"
              type="button"
              style={{ marginTop: 'var(--sp-3)' }}
              onClick={sendCommand}
              disabled={cmdBusy || !cmdCp}
            >
              {cmdBusy ? 'Waiting for charger…' : 'Send command'}
            </button>
          </section>
          <section className="card" aria-live="polite">
            <div className="sec-h" style={{ marginBottom: 'var(--sp-2)' }}>
              <h2 style={{ fontSize: '1rem' }}>Charger answer</h2>
              <p>The raw correlated result, including the OCPP status and any payload.</p>
            </div>
            {cmdOut ? (
              <pre
                style={{
                  overflowX: 'auto',
                  margin: 0,
                  padding: 'var(--sp-3)',
                  background: 'var(--s1)',
                  borderRadius: 'var(--r-s)',
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                {JSON.stringify(cmdOut, null, 2)}
              </pre>
            ) : (
              <p style={{ color: 'var(--tx2)' }}>No command sent in this session.</p>
            )}
          </section>
        </div>
      )}
      {tab === 'tariffs' && (
        <section className="card" style={{ maxWidth: 720 }}>
          <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
            <h2 style={{ fontSize: '1rem' }}>Version timeline</h2>
            <p>The active version is never edited — a new version supersedes it.</p>
          </div>
          {plans.map((p) => (
            <div
              key={p.plan_id}
              style={{
                display: 'flex',
                gap: 12,
                padding: 'var(--sp-2) 0',
                borderBottom: '1px solid var(--hair)',
                flexWrap: 'wrap',
              }}
            >
              <span className="num micro" style={{ minWidth: 72 }}>
                g{p.group_id}·v{p.version_no}
              </span>
              <b>{p.name}</b>
              <span className="num">{inr(p.session_fee)} fee</span>
              <span style={{ marginLeft: 'auto' }}>
                <Pill s={p.active_to ? 'EXPIRED' : 'AVAILABLE'} />
              </span>
            </div>
          ))}
          <button className="btn pri" style={{ marginTop: 'var(--sp-3)' }} onClick={() => setConfirmVersion(true)}>
            New version
          </button>
        </section>
      )}
      {tab === 'audit' && (
        <div className="tscroll">
          <table className="t">
            <caption className="micro" style={{ textAlign: 'left', paddingBottom: 8 }}>
              Recent audit entries
            </caption>
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">Actor</th>
                <th scope="col">Entity</th>
                <th scope="col">Action</th>
                <th scope="col">At</th>
              </tr>
            </thead>
            <tbody>
              {logs.slice(0, 60).map((l) => (
                <tr key={l.audit_id}>
                  <td className="n">#{l.audit_id}</td>
                  <td className="n">{l.actor_user_id ?? 'sys'}</td>
                  <td>
                    {l.entity_name} {l.entity_id}
                  </td>
                  <td>{l.action}</td>
                  <td className="num">{new Date(l.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={confirmUser}
        eyebrow="CREATE OPERATOR"
        title={`Create ${nu.email || 'operator'}?`}
        body="They will be able to run stations, triage faults and start sessions."
        confirmLabel="Create operator"
        onConfirm={addUser}
        onCancel={() => setConfirmUser(false)}
      />
      <ConfirmDialog
        open={confirmStation}
        eyebrow="PROVISION STATION"
        title={`Add "${ns.name || 'station'}"?`}
        body="It goes live immediately with one AC22 charge point and auto-assigned OCPP identities."
        confirmLabel="Provision"
        onConfirm={addStation}
        onCancel={() => setConfirmStation(false)}
      />
      <ConfirmDialog
        open={confirmVersion}
        eyebrow="NEW TARIFF VERSION"
        title={`Supersede with "${versionName}"?`}
        body="In-flight sessions keep the version they pinned; new sessions price on this one."
        confirmLabel="Create version"
        onConfirm={newVersion}
        onCancel={() => setConfirmVersion(false)}
      >
        <label className="f">
          Version name
          <input value={versionName} onChange={(e) => setVersionName(e.target.value)} />
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!flipTarget}
        eyebrow="STATION STATUS"
        title={flipTarget?.status === 'ACTIVE' ? `Deactivate ${flipTarget?.name}?` : `Activate ${flipTarget?.name}?`}
        body={
          flipTarget?.status === 'ACTIVE'
            ? 'Drivers will stop seeing it in Discover; in-flight sessions continue.'
            : 'It becomes discoverable again with its live availability.'
        }
        confirmLabel={flipTarget?.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
        danger={flipTarget?.status === 'ACTIVE'}
        onConfirm={flipStation}
        onCancel={() => setFlipTarget(null)}
      />
    </div>
  );
}
