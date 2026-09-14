'use client';
import { useEffect, useState } from 'react';
import { api, Kpi, Line, inr, kwh, PageHead, StationPicker } from '../../lib/ui';

export default function Analytics() {
  const [st, setSt] = useState([]);
  const [sel, setSel] = useState(null);
  const [a, setA] = useState(null);
  const [curve, setCurve] = useState([]);
  useEffect(() => {
    api('/stations')
      .then((j) => {
        setSt(j.stations);
        setSel(j.stations[0]?.station_id);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!sel) return;
    api(`/stations/${sel}/analytics`)
      .then(setA)
      .catch(() => {});
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
      {a && (
        <div className="grid cards" style={{ marginTop: 'var(--sp-4)' }}>
          <Kpi l="Revenue" v={inr(a.revenue)} />
          <Kpi l="Energy" v={kwh(a.energy_kwh)} />
          <Kpi l="Sessions" v={a.sessions} />
          <Kpi l="Utilization signal" v={`${a.active} live`} />
        </div>
      )}
      <section className="card" style={{ marginTop: 'var(--sp-4)' }}>
        <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
          <h2 style={{ fontSize: '1rem' }}>Hourly load</h2>
          <p>kW per hour bucket — the shape the tariff bands price against.</p>
        </div>
        <Line pts={curve} stroke="#6E96B8" id="an" />
      </section>
    </div>
  );
}
