'use client';
import { useEffect, useState } from 'react';
import {
  api,
  usePoll,
  Kpi,
  Pill,
  Line,
  PageState,
  Toasts,
  toast,
  inr,
  kwh,
  PageHead,
  StationPicker,
  StaleChip,
  IST,
} from '../../lib/ui';

export default function Dashboard() {
  const [st, setSt] = useState([]);
  const [sel, setSel] = useState(null);
  const [a, setA] = useState(null);
  const [live, setLive] = useState([]);
  const [active, setActive] = useState([]);
  const [faults, setFaults] = useState([]);
  const [strip, setStrip] = useState([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  // Stale-data contract (same as telemetry): a failed poll keeps the last good KPIs
  // on screen with a reconnecting chip; only a failed first load shows the error card.
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
  // URL as state (§9.5-3): ?station= survives refresh/deep-link.
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get('station');
      if (q) setSel(Number(q));
    } catch {}
  }, []);
  const pick = (id) => {
    setSel(id);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('station', String(id));
      window.history.replaceState(null, '', u.toString());
    } catch {}
  };
  useEffect(() => {
    loadStations();
  }, []);
  // usePoll serialises the five-request fan-out: the old setInterval fired the whole
  // batch every 15 s whether or not the previous batch had landed, so one slow endpoint
  // multiplied the load on a laptop with a bad connection. Same tick, paused in a hidden
  // tab, and every request gets an AbortSignal. `scope: sel` is the part that keeps the
  // numbers honest: repicking tears the loop down, aborts the batch in flight and clears
  // the previous station's payload, so station B's label can never render station A's
  // KPIs while the new batch is still on the wire (or, if it fails, indefinitely).
  const { status, error, refresh } = usePoll(
    ({ signal }) =>
      Promise.all([
        api(`/stations/${sel}/analytics`, { signal }).then((r) => setA(r)),
        api(`/stations/${sel}/connectors/live`, { signal }).then((j) => setLive(j.connectors)),
        api(`/stations/${sel}/sessions/active`, { signal }).then((j) => setActive(j.sessions)),
        api(`/faults?open=1&station=${sel}`, { signal }).then((j) => setFaults(j.faults)),
        api(`/telemetry/load-curve?station=${sel}&bucket=1h`, { signal }).then((j) => setStrip(j.points)),
      ]),
    {
      intervalMs: 15000,
      enabled: !!sel,
      scope: sel,
      reset: () => {
        setA(null);
        setLive([]);
        setActive([]);
        setFaults([]);
        setStrip([]);
      },
    }
  );
  const stale = status === 'stale';
  return (
    <div className="wrap">
      <Toasts />
      <PageHead
        eyebrow="OPERATOR · STATION-SCOPED · REFRESHES EVERY 15 s"
        title="Health grid"
        lede="Revenue, energy, connector state and faults for one station. Select it here or deep-link with ?station=."
      />
      <StationPicker id="station-pick" stations={st} value={sel} onChange={pick} />
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
        {a && (
          <div className="grid cards" style={{ marginTop: 'var(--sp-4)' }}>
            <Kpi l="Revenue" v={inr(a.revenue)} />
            <Kpi l="Energy" v={kwh(a.energy_kwh)} />
            <Kpi l="Sessions" v={a.sessions} />
            <Kpi l="Active / Faults" v={`${a.active} / ${a.open_faults}`} />
          </div>
        )}
      </PageState>
      <section className="sec">
        <div className="sec-h">
          <h2>Connector grid</h2>
          <p>Live state per connector — occupancy changes flow through the OCPP gateway in real time.</p>
        </div>
        <div className="tiles">
          {live.map((c) => (
            <div key={c.connector_ref} className="tile">
              <div className="num">{c.connector_ref}</div>
              <div className="num micro">
                {c.standard_code} {c.max_power_kw}kW
              </div>
              <Pill s={c.status} />
            </div>
          ))}
        </div>
        {!live.length && !loading && <p style={{ color: 'var(--tx2)' }}>No connectors report for this station yet.</p>}
      </section>
      <div className="two">
        <section className="card">
          <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
            <h2 style={{ fontSize: '1rem' }}>Active sessions</h2>
            <p>Click a session to watch it live.</p>
          </div>
          {active.length ? (
            <div className="tscroll">
              <table className="t">
                <caption className="micro" style={{ textAlign: 'left', marginBottom: 8 }}>
                  Live sessions on the selected station
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Session</th>
                    <th scope="col">Connector</th>
                    <th scope="col">State</th>
                    <th scope="col">Started</th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((s) => (
                    <tr key={s.session_id}>
                      <td className="n">
                        <a className="link" href={`/session/${s.session_id}`}>
                          #{s.session_id}
                        </a>
                      </td>
                      <td className="n">{s.connector_ref}</td>
                      <td>
                        <Pill s={s.state} />
                      </td>
                      <td className="num">
                        {new Date(s.started_at).toLocaleTimeString('en-IN', {
                          hour: '2-digit',
                          minute: '2-digit',
                          hour12: false,
                          timeZone: IST,
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p style={{ color: 'var(--tx2)' }}>
              No live sessions on this station. When a driver plugs in, one appears here within seconds.
            </p>
          )}
        </section>
        <div className="grid">
          <section className="card">
            <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
              <h2 style={{ fontSize: '1rem' }}>Load strip</h2>
            </div>
            <Line pts={strip} h={110} stroke="#6E96B8" id="dash" />
            <a className="micro link" href="/telemetry">
              full telemetry →
            </a>
          </section>
          <section className="card">
            <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
              <h2 style={{ fontSize: '1rem' }}>Open faults</h2>
            </div>
            {faults.slice(0, 5).map((f) => (
              <div
                key={f.fault_id}
                style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--hair)' }}
              >
                <span className="num">{f.connector_ref}</span>
                <span>{f.error_code}</span>
                <span style={{ marginLeft: 'auto' }}>
                  <Pill s="FAILED" />
                </span>
              </div>
            ))}
            {!faults.length && <p style={{ color: 'var(--tx2)' }}>Queue clear.</p>}
            <a className="micro link" href="/faults">
              fault triage →
            </a>
          </section>
        </div>
      </div>
    </div>
  );
}
