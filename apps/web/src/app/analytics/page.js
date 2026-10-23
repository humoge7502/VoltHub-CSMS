'use client';
import { useEffect, useState } from 'react';
import { api, Kpi, Line, inr, kwh, PageHead, PageState, StationPicker } from '../../lib/ui';

export default function Analytics() {
  const [st, setSt] = useState([]);
  const [sel, setSel] = useState(null);
  const [a, setA] = useState(null);
  const [curve, setCurve] = useState([]);
  // The page used to render blank-forever on any failure (every catch was
  // `() => {}`) and had no loading state at all — PageState now owns both.
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api('/stations')
      .then((j) => {
        setSt(j.stations);
        setSel(j.stations[0]?.station_id);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!sel) return;
    api(`/stations/${sel}/analytics`)
      .then((r) => {
        setA(r);
        setErr('');
      })
      .catch((e) => setErr(e.message));
    api(`/telemetry/load-curve?station=${sel}&bucket=1h`)
      .then((j) => setCurve(j.points))
      .catch(() => {});
  }, [sel]);
  return (
    <div className="wrap">
      <PageHead
        eyebrow="OPERATOR · MV_STATION_DAILY + CAGGS"
        title="Analytics"
        lede="Station rollups from the materialized view and hourly load from the 1-hour continuous aggregate."
      />
      <StationPicker id="an-station" stations={st} value={sel} onChange={setSel} />
      <PageState loading={loading} error={err} onRetry={() => sel && setSel((x) => x)}>
        {a ? (
          <div className="grid cards" style={{ marginTop: 'var(--sp-4)' }}>
            <Kpi l="Revenue" v={inr(a.revenue)} />
            <Kpi l="Energy" v={kwh(a.energy_kwh)} />
            <Kpi l="Sessions" v={a.sessions} />
            <Kpi l="Utilization signal" v={`${a.active} live`} />
          </div>
        ) : (
          <div className="grid cards" style={{ marginTop: 'var(--sp-4)' }} aria-hidden="true">
            <div className="skel" style={{ height: 96 }} />
            <div className="skel" style={{ height: 96 }} />
            <div className="skel" style={{ height: 96 }} />
          </div>
        )}
        <section className="card" style={{ marginTop: 'var(--sp-4)' }}>
          <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
            <h2 style={{ fontSize: '1rem' }}>Hourly load</h2>
            <p>kW per hour bucket — the shape the tariff bands price against.</p>
          </div>
          <Line pts={curve} stroke="#6E96B8" id="an" />
        </section>
      </PageState>
    </div>
  );
}
