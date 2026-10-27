'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  api,
  usePoll,
  Line,
  Heatmap,
  PageState,
  PageHead,
  StationPicker,
  Pill,
  StaleChip,
  HEAT_RAMP,
} from '../../lib/ui';

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
  // usePoll: ticks are serialised, so a slow load-curve query can no longer stack a
  // second request behind it every 10 s; a hidden tab stops polling and catches up on
  // reveal. `scope: sel` makes a repick tear the loop down — aborting the request in
  // flight and clearing the previous station's curve/heatmap — instead of letting the
  // next tick arrive up to 10 s later with the new station's data under the old charts.
  const { status, error, refresh } = usePoll(
    ({ signal }) =>
      Promise.all([
        api(`/telemetry/load-curve?station=${sel}&bucket=5m`, { signal }).then((j) => {
          setCurve(j.points);
          setSource(j.source);
        }),
        // The heatmap is secondary: its own failure must not mark the load curve stale,
        // so it is swallowed HERE (visible as the absent source chip) rather than by the
        // whole tick.
        api(`/telemetry/utilization-heatmap?station=${sel}`, { signal })
          .then((j) => {
            setHeat(j.heatmap);
            setHeatSource(j.source);
          })
          .catch(() => {}),
      ]),
    {
      intervalMs: 10000,
      enabled: !!sel,
      scope: sel,
      reset: () => {
        setCurve([]);
        setSource('');
        setHeat(null);
        setHeatSource('');
      },
    }
  );
  const stale = status === 'stale';

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
      <PageState
        loading={loading && !st.length}
        error={err || (status === 'error' ? error : '')}
        onRetry={() => {
          loadStations();
          refresh();
        }}
      >
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
          {/* A skeleton means "loading"; a station with no history would sit on one
              forever and read as a page that never finished. Once the tick has resolved
              with no grid, say so — the matrix is genuinely absent, not pending. */}
          {heat ? (
            <Heatmap grid={heat} unit="bays busy" />
          ) : status === 'ok' || status === 'stale' ? (
            <p className="micro" data-empty="heatmap">
              No utilization history for this station yet — the 7×24 matrix appears once meter ticks land.
            </p>
          ) : (
            <div className="skel" style={{ height: 180 }} />
          )}
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
