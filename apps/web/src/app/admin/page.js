'use client';
import { useEffect, useState } from 'react';
import { api, Pill, inr } from '../../lib/ui';

export default function Admin() {
  const [tab, setTab] = useState('overview');
  const [logs, setLogs] = useState([]); const [plans, setPlans] = useState([]); const [msg, setMsg] = useState('');
  const [nu, setNu] = useState({ email: '', full_name: '', role: 'OPERATOR' });
  const [stations, setStations] = useState([]);
  const [ns, setNs] = useState({ name: '', latitude: '12.99', longitude: '80.21', city: 'Chennai' });
  useEffect(() => {
    api('/admin/audit-logs').then(j => setLogs(j.logs)).catch(e => setMsg(e.message));
    api('/admin/tariff-plans').then(j => setPlans(j.plans)).catch(() => {});
    api('/admin/stations').then(j => setStations(j.stations)).catch(() => {});
  }, []);
  const addUser = async () => { try { await api('/admin/users', { method: 'POST', body: JSON.stringify(nu) }); setMsg('operator created'); } catch (e) { setMsg(e.message); } };
  const newVersion = async () => {
    const name = prompt('Version name', 'City Day v3'); if (!name) return;
    await api('/admin/tariff-plans', { method: 'POST', body: JSON.stringify({ group_id: 1, name, session_fee: 20, bands: [{ day_scope: 'ALL', start_time: '00:00', end_time: '24:00', price_per_kwh: 24 }] }) });
    window.location.reload();
  };
  const addStation = async () => {
    try {
      await api('/admin/stations', { method: 'POST', body: JSON.stringify({ ...ns, latitude: Number(ns.latitude), longitude: Number(ns.longitude), charge_points: [{ model: 'VH-AC22', connectors: [{ standard: 'TYPE2', max_power_kw: 22 }] }] }) });
      window.location.reload();
    } catch (e) { setMsg(e.message); }
  };
  const flipStation = async (s) => {
    await api(`/admin/stations/${s.station_id}`, { method: 'PATCH', body: JSON.stringify({ status: s.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }) });
    window.location.reload();
  };
  return (
    <div className="wrap">
      <div className="micro">ADMIN</div>
      <h1 className="display" style={{ fontSize: '2.4rem' }}>Control</h1>
      <div style={{ display: 'flex', gap: 6, margin: '12px 0' }}>
        {['overview', 'stations', 'tariffs', 'audit'].map(t => <button key={t} className="btn" onClick={() => setTab(t)} style={tab === t ? { borderColor: 'var(--cream)' } : {}}>{t}</button>)}
      </div>
      {msg && <p className="err">{msg}</p>}
      {tab === 'overview' && (
        <div className="card"><div className="micro">CREATE OPERATOR (ADMIN ONLY)</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input placeholder="email" value={nu.email} onChange={e => setNu({ ...nu, email: e.target.value })} />
            <input placeholder="full name" value={nu.full_name} onChange={e => setNu({ ...nu, full_name: e.target.value })} />
            <button className="btn pri" onClick={addUser}>Create</button>
          </div></div>)}
      {tab === 'stations' && (
        <div className="grid">
          <div className="card"><div className="micro">PROVISION STATION (OCPP IDENTITIES AUTO-ASSIGNED)</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <input placeholder="name" value={ns.name} onChange={e => setNs({ ...ns, name: e.target.value })} />
              <input placeholder="lat" value={ns.latitude} onChange={e => setNs({ ...ns, latitude: e.target.value })} style={{ maxWidth: 110 }} />
              <input placeholder="lng" value={ns.longitude} onChange={e => setNs({ ...ns, longitude: e.target.value })} style={{ maxWidth: 110 }} />
              <button className="btn pri" onClick={addStation}>Provision + 1×AC22</button>
            </div></div>
          <table className="t"><thead><tr><th>ID</th><th>Name</th><th>Points</th><th>Conns</th><th>Status</th><th></th></tr></thead>
            <tbody>{stations.map(s => <tr key={s.station_id}><td className="n">{s.station_id}</td><td>{s.name}</td>
              <td className="n">{s.points}</td><td className="n">{s.connectors}</td><td><Pill s={s.status === 'ACTIVE' ? 'AVAILABLE' : 'OFFLINE'} /></td>
              <td><button className="btn" onClick={() => flipStation(s)}>{s.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}</button></td></tr>)}</tbody></table>
        </div>)}
      {tab === 'tariffs' && (
        <div className="card"><div className="micro">VERSION TIMELINE · NEVER EDIT ACTIVE, ALWAYS SUPERSEDE</div>
          {plans.map(p => <div key={p.plan_id} style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--hair)' }}>
            <span className="num">g{p.group_id}·v{p.version_no}</span><b>{p.name}</b>
            <span className="num">{inr(p.session_fee)} fee</span><Pill s={p.active_to ? 'EXPIRED' : 'AVAILABLE'} /></div>)}
          <button className="btn pri" style={{ marginTop: 12 }} onClick={newVersion}>New version</button></div>)}
      {tab === 'audit' && (
        <table className="t"><thead><tr><th>ID</th><th>Actor</th><th>Entity</th><th>Action</th><th>At</th></tr></thead>
          <tbody>{logs.slice(0, 60).map(l => <tr key={l.audit_id}><td className="n">{l.audit_id}</td><td className="n">{l.actor_user_id ?? 'sys'}</td>
            <td>{l.entity_name} {l.entity_id}</td><td>{l.action}</td><td className="num">{new Date(l.created_at).toLocaleString()}</td></tr>)}</tbody></table>)}
    </div>
  );
}
