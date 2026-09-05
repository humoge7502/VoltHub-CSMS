'use client';
import { useEffect, useState } from 'react';
import { api, Kpi, Pill, Line, inr, kwh } from '../../lib/ui';

export default function Dashboard() {
  const [st, setSt] = useState([]); const [sel, setSel] = useState(null); const [a, setA] = useState(null);
  const [live, setLive] = useState([]); const [active, setActive] = useState([]);
  const [faults, setFaults] = useState([]); const [strip, setStrip] = useState([]);
  useEffect(() => { api('/stations').then(j => { setSt(j.stations); setSel(j.stations[0]?.station_id); }).catch(() => {}); }, []);
  useEffect(() => {
    if (!sel) return;
    const f = () => Promise.all([
      api(`/stations/${sel}/analytics`).then(setA).catch(() => {}),
      api(`/stations/${sel}/connectors/live`).then(j => setLive(j.connectors)).catch(() => {}),
      api(`/stations/${sel}/sessions/active`).then(j => setActive(j.sessions)).catch(() => {}),
      api(`/faults?open=1&station=${sel}`).then(j => setFaults(j.faults)).catch(() => {}),
      api(`/telemetry/load-curve?station=${sel}&bucket=1h`).then(j => setStrip(j.points)).catch(() => {}),
    ]);
    f(); const t = setInterval(f, 15000); return () => clearInterval(t);
  }, [sel]);
  return (
    <div className="wrap">
      <div className="micro">OPERATOR · STATION-SCOPED</div>
      <h1 className="display" style={{ fontSize: '2.4rem' }}>Health grid</h1>
      <select value={sel || ''} onChange={e => setSel(Number(e.target.value))} style={{ maxWidth: 320, margin: '12px 0' }}>
        {st.map(s => <option key={s.station_id} value={s.station_id}>{s.name}</option>)}
      </select>
      {a && <div className="grid cards">
        <Kpi l="Revenue" v={inr(a.revenue)} /><Kpi l="Energy" v={kwh(a.energy_kwh)} />
        <Kpi l="Sessions" v={a.sessions} /><Kpi l="Active / Faults" v={`${a.active} / ${a.open_faults}`} />
      </div>}
      <div className="micro" style={{ margin: '16px 0 8px' }}>CONNECTOR GRID · 120px MIN TILES</div>
      <div className="tiles">{live.map(c => (
        <div key={c.connector_ref} className="tile"><div className="num">{c.connector_ref}</div>
          <div className="num micro">{c.standard_code} {c.max_power_kw}kW</div><Pill s={c.status} /></div>))}
      </div>
      <div className="two" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="micro">ACTIVE SESSIONS · CLICK THROUGH TO LIVE VIEW</div>
          <table className="t" style={{ marginTop: 8 }}>
            <thead><tr><th>Session</th><th>Connector</th><th>State</th><th>Started</th></tr></thead>
            <tbody>{active.map(s => (
              <tr key={s.session_id}><td className="n"><a href={`/session/${s.session_id}`}>{s.session_id}</a></td>
                <td className="n">{s.connector_ref}</td><td><Pill s={s.state} /></td>
                <td className="num">{new Date(s.started_at).toLocaleTimeString()}</td></tr>))}
            </tbody>
          </table>
          {!active.length && <p style={{ color: 'var(--tx2)' }}>No live sessions on this station.</p>}
        </div>
        <div className="grid">
          <div className="card">
            <div className="micro">LOAD STRIP · 1H CAGG</div>
            <Line pts={strip} h={110} stroke="#6E96B8" />
            <a className="micro" href="/telemetry">full telemetry →</a>
          </div>
          <div className="card">
            <div className="micro">OPEN FAULTS · {faults.length}</div>
            {faults.slice(0, 5).map(f => (
              <div key={f.fault_id} style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--hair)' }}>
                <span className="num">{f.connector_ref}</span><span>{f.error_code}</span>
                <span style={{ marginLeft: 'auto' }}><Pill s="FAILED" /></span>
              </div>))}
            {!faults.length && <p style={{ color: 'var(--tx2)' }}>Queue clear.</p>}
            <a className="micro" href="/faults">fault triage →</a>
          </div>
        </div>
      </div>
    </div>
  );
}
