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
  // Retry used to be `setSel(x => x)`, which React bails out on: the button re-rendered
  // nothing and re-fetched nothing. `attempt` is the dependency that actually re-runs.
  const [attempt, setAttempt] = useState(0);
  // Both effects own an AbortController, so navigating away (or retrying) cannot leave a
  // response that writes state into a page that no longer cares about it.
  useEffect(() => {
    const ctrl = new AbortController();
    api('/stations', { signal: ctrl.signal })
      .then((j) => {
        setSt(j.stations);
        setSel((s) => s ?? j.stations[0]?.station_id);
      })
      .catch((e) => {
        if (!ctrl.signal.aborted) setErr(e.message);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [attempt]);
  useEffect(() => {
    if (!sel) return;
    const ctrl = new AbortController();
    // The load curve is secondary (a station with no ticks is a valid analytics page),
    // so its failure is reported by the absent chart, not by the page error — but it is
    // no longer swallowed whole: a 401/500 still surfaces through the headline request.
    api(`/telemetry/load-curve?station=${sel}&bucket=1h`, { signal: ctrl.signal })
      .then((j) => setCurve(j.points))
      .catch(() => {});
    api(`/stations/${sel}/analytics`, { signal: ctrl.signal })
      .then((r) => {
        setA(r);
        setErr('');
      })
      .catch((e) => {
        if (!ctrl.signal.aborted) setErr(e.message);
      });
    return () => ctrl.abort();
  }, [sel, attempt]);
  return (
    <div className="wrap">
      <PageHead
        eyebrow="OPERATOR · MV_STATION_DAILY + CAGGS"
        title="Analytics"
        lede="Station rollups from the materialized view and hourly load from the 1-hour continuous aggregate."
      />
      <StationPicker id="an-station" stations={st} value={sel} onChange={setSel} />
      <PageState
        loading={loading}
        error={err}
        onRetry={() => {
          setLoading(true);
          setAttempt((n) => n + 1);
        }}
      >
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
