'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, Line, Heatmap, PageState, PageHead, StationPicker, Pill, StaleChip, HEAT_RAMP } from '../../lib/ui';

export default function Telemetry() {
  const [st, setSt] = useState([]);
  const [sel, setSel] = useState(null);
  const [curve, setCurve] = useState([]);
  const [source, setSource] = useState('');
  const [heat, setHeat] = useState(null);
  const [heatSource, setHeatSource] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  // Stale-data contract: a failed POLL keeps the last good charts on screen and shows
  // a reconnecting chip — the old behaviour swapped the whole view for an error card
  // on any transient blip. Only a failed FIRST load renders the error state.
  const gotDataRef = useRef(false);
  const [stale, setStale] = useState(false);

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
        .then((j) => {
          if (dead) return;
          setCurve(j.points);
          setSource(j.source);
          gotDataRef.current = true;
          setStale(false);
        })
        .catch((e) => {
          if (dead) return;
          if (gotDataRef.current) setStale(true);
          else setErr(e.message);
        });
      api(`/telemetry/utilization-heatmap?station=${sel}`)
        .then((j) => {
          if (dead) return;
          setHeat(j.heatmap);
          setHeatSource(j.source);
        })
        .catch(() => {});
    };
    f();
    const t = setInterval(f, 10000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [sel]);

  const stats = useMemo(() => {
    if (!curve.length) return null;
    const avg = curve.reduce((a, p) => a + p.avg_kw, 0) / curve.length;
    const peak = Math.max(...curve.map((p) => p.peak_kw));
    // energy under the curve: 5-minute buckets -> kWh
    const kwh = curve.reduce((a, p) => a + (p.avg_kw * 5) / 60, 0);
    return { avg: avg.toFixed(1), peak: peak.toFixed(1), kwh: kwh.toFixed(1) };
  }, [curve]);

  return (
    <div className="wrap">
      <PageHead
        eyebrow="OPERATOR · DA3 PIPELINE · 10 s REFRESH"
        title="Telemetry"
        lede="Five-minute load curve and the 7×24 utilization matrix. Both read the engine they name: TimescaleDB when the pipeline is wired, the in-process rollup otherwise."
      />
      <StationPicker id="tl-station" stations={st} value={sel} onChange={setSel} />
      {stale && (
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <StaleChip />
        </div>
      )}
      <PageState loading={loading && !st.length} error={err} onRetry={loadStations}>
        <section className="card" style={{ marginTop: 'var(--sp-4)' }}>
          <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
            <h2 style={{ fontSize: '1rem' }}>Load curve</h2>
            <p>
              kW per 5-minute bucket, last six hours.{' '}
              {source ? (
                <span className="micro" style={{ marginLeft: 6 }}>
                  source <b>{source}</b>
                </span>
              ) : null}
            </p>
          </div>
          {stats ? (
            <div className="statband" style={{ marginBottom: 'var(--sp-3)' }}>
              <div>
                <div className="micro">MEAN DRAW</div>
                <div className="v num">{stats.avg} kW</div>
              </div>
              <div>
                <div className="micro">PEAK</div>
                <div className="v num">{stats.peak} kW</div>
              </div>
              <div>
                <div className="micro">DELIVERED</div>
                <div className="v num">{stats.kwh} kWh</div>
              </div>
              <div>
                <div className="micro">BUCKETS</div>
                <div className="v num">{curve.length}</div>
              </div>
            </div>
          ) : null}
          <Line pts={curve} h={200} id="tl" />
        </section>
        <section className="card" style={{ marginTop: 'var(--sp-4)' }}>
          <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
            <h2 style={{ fontSize: '1rem' }}>Utilization heatmap</h2>
            <p>
              Average bays drawing power, by weekday and hour — a week of ticks.{' '}
              {heatSource ? (
                <span className="micro" style={{ marginLeft: 6 }}>
                  source <b>{heatSource}</b>
                </span>
              ) : null}
            </p>
          </div>
          <Heatmap grid={heat} unit="bays busy" />
          <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center', marginTop: 'var(--sp-2)' }}>
            <span className="micro">quiet</span>
            <span style={{ display: 'flex', gap: 3 }}>
              {HEAT_RAMP.map((c) => (
                <i key={c} style={{ width: 18, height: 8, background: c, borderRadius: 2, display: 'inline-block' }} />
              ))}
            </span>
            <span className="micro">saturated</span>
            <span style={{ marginLeft: 'auto' }}>
              <Pill s={heatSource === 'timescaledb' ? 'AVAILABLE' : 'OFFLINE'} />
            </span>
          </div>
        </section>
      </PageState>
    </div>
  );
}
