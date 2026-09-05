'use client';
import { useEffect, useState } from 'react';
import { api, Line, Heatmap } from '../../lib/ui';

export default function Telemetry() {
  const [st, setSt] = useState([]); const [sel, setSel] = useState(null);
  const [curve, setCurve] = useState([]); const [heat, setHeat] = useState(null);
  useEffect(() => { api('/stations').then(j => { setSt(j.stations); setSel(j.stations[0]?.station_id); }).catch(() => {}); }, []);
  useEffect(() => {
    if (!sel) return;
    const f = () => {
      api(`/telemetry/load-curve?station=${sel}&bucket=5m`).then(j => setCurve(j.points)).catch(() => {});
      api('/telemetry/utilization-heatmap').then(j => setHeat(j.heatmap)).catch(() => {});
    };
    f(); const t = setInterval(f, 10000); return () => clearInterval(t);
  }, [sel]);
  return (
    <div className="wrap">
      <div className="micro">OPERATOR · DA3 · GAP-FILLED 5M CURVE + 7×24 HEATMAP</div>
      <h1 className="display" style={{ fontSize: '2.4rem' }}>Telemetry</h1>
      <select value={sel || ''} onChange={e => setSel(Number(e.target.value))} style={{ maxWidth: 320, margin: '12px 0' }}>
        {st.map(s => <option key={s.station_id} value={s.station_id}>{s.name}</option>)}
      </select>
      <div className="card"><div className="micro">LOAD CURVE · TICK_1M CAGG (18MS VS 2.1S RAW)</div><Line pts={curve} h={200} /></div>
      <div className="card" style={{ marginTop: 16 }}><div className="micro">UTILIZATION HEATMAP · STATE_1M</div><Heatmap grid={heat} /></div>
    </div>
  );
}
