'use client';
import { useEffect, useState } from 'react';
import { api, Kpi, Line, inr, kwh } from '../../lib/ui';

export default function Analytics() {
  const [st, setSt] = useState([]); const [sel, setSel] = useState(null);
  const [a, setA] = useState(null); const [curve, setCurve] = useState([]);
  useEffect(() => { api('/stations').then(j => { setSt(j.stations); setSel(j.stations[0]?.station_id); }).catch(() => {}); }, []);
  useEffect(() => {
    if (!sel) return;
    api(`/stations/${sel}/analytics`).then(setA).catch(() => {});
    api(`/telemetry/load-curve?station=${sel}&bucket=1h`).then(j => setCurve(j.points)).catch(() => {});
  }, [sel]);
  return (
    <div className="wrap">
      <div className="micro">OPERATOR · MV_STATION_DAILY + CAGGS</div>
      <h1 className="display" style={{ fontSize: '2.4rem' }}>Analytics</h1>
      <select value={sel || ''} onChange={e => setSel(Number(e.target.value))} style={{ maxWidth: 320, margin: '12px 0' }}>
        {st.map(s => <option key={s.station_id} value={s.station_id}>{s.name}</option>)}
      </select>
      {a && <div className="grid cards"><Kpi l="Revenue" v={inr(a.revenue)} /><Kpi l="Energy" v={kwh(a.energy_kwh)} /><Kpi l="Sessions" v={a.sessions} /><Kpi l="Utilization signal" v={`${a.active} live`} /></div>}
      <div className="card" style={{ marginTop: 16 }}><div className="micro">HOURLY LOAD · TICK_1H CAGG</div><Line pts={curve} stroke="#6E96B8" /></div>
    </div>
  );
}
