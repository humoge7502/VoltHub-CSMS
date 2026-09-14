'use client';
import { useEffect, useState } from 'react';
import { api, Kpi, Pill, Line, PageState, Toasts, toast, inr, kwh, PageHead, StationPicker } from '../../lib/ui';

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
    setLoading(true);
    api('/stations')
      .then((j) => {
        setSt(j.stations);
        setErr('');
        setSel((s) => s ?? j.stations[0]?.station_id);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!sel) return;
    let dead = false;
    const f = () =>
      Promise.all([
        api(`/stations/${sel}/analytics`)
          .then((r) => !dead && setA(r))
          .catch((e) => !dead && setErr(e.message)),
        api(`/stations/${sel}/connectors/live`)
          .then((j) => !dead && setLive(j.connectors))
          .catch(() => {}),
        api(`/stations/${sel}/sessions/active`)
          .then((j) => !dead && setActive(j.sessions))
          .catch(() => {}),
        api(`/faults?open=1&station=${sel}`)
          .then((j) => !dead && setFaults(j.faults))
          .catch(() => {}),
        api(`/telemetry/load-curve?station=${sel}&bucket=1h`)
          .then((j) => !dead && setStrip(j.points))
          .catch(() => {}),
      ]);
    f();
    const t = setInterval(f, 15000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [sel]);
  return (
    <div className="wrap">
      <Toasts />
      <PageHead
        eyebrow="OPERATOR · STATION-SCOPED · REFRESHES EVERY 15 s"
        title="Health grid"
        lede="Revenue, energy, connector state and faults for one station. Select it here or deep-link with ?station=."
      />
      <StationPicker id="station-pick" stations={st} value={sel} onChange={pick} />
      <PageState loading={loading && !st.length} error={err} onRetry={() => window.location.reload()}>
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
                      <td className="num">{new Date(s.started_at).toLocaleTimeString()}</td>
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
