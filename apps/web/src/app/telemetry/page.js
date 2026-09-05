'use client';
import { useEffect, useState } from 'react';
import { api, Line, Heatmap, PageState } from '../../lib/ui';

export default function Telemetry() {
  const [st, setSt] = useState([]);
  const [sel, setSel] = useState(null);
  const [curve, setCurve] = useState([]);
  const [heat, setHeat] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const loadStations = () => {
    setLoading(true);
    api('/stations')
      .then((j) => {
        setSt(j.stations);
        setErr('');
        setSel((s) => s ?? j.stations[0]?.station_id);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    loadStations();
  }, []);
  useEffect(() => {
    if (!sel) return;
    let dead = false;
    const f = () => {
      api(`/telemetry/load-curve?station=${sel}&bucket=5m`)
        .then((j) => !dead && setCurve(j.points))
        .catch((e) => !dead && setErr(e.message));
      api('/telemetry/utilization-heatmap')
        .then((j) => !dead && setHeat(j.heatmap))
        .catch(() => {});
    };
    f();
    const t = setInterval(f, 10000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [sel]);
  return (
    <div className="wrap">
      <div className="micro">OPERATOR · DA3 · GAP-FILLED 5M CURVE + 7×24 HEATMAP</div>
      <h1 className="display" style={{ fontSize: '2.4rem' }}>
        Telemetry
      </h1>
      <label className="micro" htmlFor="tl-station">
        STATION
      </label>
      <select
        id="tl-station"
        aria-label="Station"
        value={sel || ''}
        onChange={(e) => setSel(Number(e.target.value))}
        style={{ maxWidth: 320, margin: '12px 0' }}
      >
        {st.map((s) => (
          <option key={s.station_id} value={s.station_id}>
            {s.name}
          </option>
        ))}
      </select>
      <PageState loading={loading && !st.length} error={err} onRetry={loadStations}>
        <div className="card">
          <div className="micro">LOAD CURVE · CAGG-BACKED WHEN TS_HOST IS SET, ELSE LOCAL ROLLUP</div>
          <Line pts={curve} h={200} />
        </div>
        <div className="card" style={{ marginTop: 16 }}>
          <div className="micro">UTILIZATION HEATMAP · STATE EVENTS</div>
          <Heatmap grid={heat} />
        </div>
      </PageState>
    </div>
  );
}
