'use client';
import { useEffect, useState } from 'react';
import { api, Pill, inr, PageHead, PageState, ConfirmDialog } from '../../lib/ui';

const TABS = [
  ['overview', 'Overview'],
  ['stations', 'Stations'],
  ['tariffs', 'Tariffs'],
  ['audit', 'Audit log'],
];

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
  }, []);
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
