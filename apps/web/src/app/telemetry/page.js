'use client';
import { useEffect, useState } from 'react';
import { api, Line, Heatmap, PageState, PageHead, StationPicker } from '../../lib/ui';

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
      <PageHead
        eyebrow="OPERATOR · DA3 PIPELINE · 10 s REFRESH"
        title="Telemetry"
        lede="Five-minute load curve and the 7×24 utilization heatmap, read from continuous aggregates when TimescaleDB is wired."
      />
      <StationPicker id="tl-station" stations={st} value={sel} onChange={setSel} />
      <PageState loading={loading && !st.length} error={err} onRetry={loadStations}>
        <section className="card" style={{ marginTop: 'var(--sp-4)' }}>
          <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
            <h2 style={{ fontSize: '1rem' }}>Load curve</h2>
            <p>kW per 5-minute bucket — cagg-backed when TS_HOST is set, local rollup otherwise.</p>
          </div>
          <Line pts={curve} h={200} id="tl" />
        </section>
        <section className="card" style={{ marginTop: 'var(--sp-4)' }}>
          <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
            <h2 style={{ fontSize: '1rem' }}>Utilization heatmap</h2>
            <p>Sessions per hour across the last 7 days — hover a cell for the count.</p>
          </div>
          <Heatmap grid={heat} />
        </section>
      </PageState>
    </div>
  );
}
