'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, Pill, CorridorMap, PageHead, EmptyState } from '../../lib/ui';

export default function Discover() {
  const [st, setSt] = useState([]);
  const [q, setQ] = useState('');
  const [std, setStd] = useState('');
  const [sel, setSel] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  // The 15 s poll runs from a stable interval, so it reads the LATEST q/std/sel
  // through refs — a closure over the first render would poll the initial search
  // forever and re-select the first station on every tick (BUG-027).
  const qRef = useRef(q);
  const stdRef = useRef(std);
  const selRef = useRef(sel);
  qRef.current = q;
  stdRef.current = std;
  selRef.current = sel;
  const load = () =>
    api(
      `/stations?q=${encodeURIComponent(qRef.current)}${stdRef.current ? `&std=${stdRef.current}` : ''}&lat=12.97&lng=80.06&radius=60`
    )
      .then((j) => {
        setErr('');
        setSt(j.stations);
        if (!selRef.current && j.stations[0]) setSel(j.stations[0].station_id);
      })
      .catch((e) => setErr('API unreachable — start it: npm run dev:api (localhost:4000)'))
      .finally(() => setLoading(false));
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
  const cur = st.find((s) => s.station_id === sel);
  return (
    <div className="wrap">
      <PageHead
        eyebrow="DRIVER · LIVE AVAILABILITY · 15 s CADENCE"
        title="Discover"
        lede="Every station on the OMR corridor with its live connector state. Pick one, reserve a window, plug in."
      />
      <div className="fieldrow" style={{ marginBottom: 'var(--sp-4)' }} role="search">
        <input
          aria-label="Search stations by name or area"
          placeholder="Search name / area…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()}
          style={{ maxWidth: 320 }}
        />
        <select
          aria-label="Connector standard"
          value={std}
          onChange={(e) => setStd(e.target.value)}
          style={{ maxWidth: 180 }}
        >
          <option value="">all standards</option>
          <option>TYPE2</option>
          <option>CCS2</option>
          <option>CHADEMO</option>
          <option>BHARAT_DC001</option>
        </select>
        <button className="btn pri" onClick={load}>
          Search
        </button>
      </div>
      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}
      <div className="two">
        <div className="grid">
          <CorridorMap stations={st} selected={sel} onPick={(s) => setSel(s.station_id)} />
          {loading && !st.length ? (
            <div className="skel" style={{ height: 200 }} />
          ) : !st.length && !err ? (
            <EmptyState
              title="No stations match"
              body="Try a broader search or clear the standard filter — the corridor has a dozen seeded stations."
            />
          ) : (
            <div className="grid">
              {st.map((s) => {
                const on = sel === s.station_id;
                return (
                  <article key={s.station_id} className="card" style={on ? { borderColor: 'var(--cream)' } : undefined}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'baseline',
                        gap: 12,
                        flexWrap: 'wrap',
                      }}
                    >
                      <h3 style={{ fontSize: '1.05rem' }}>{s.name}</h3>
                      <span className="num micro">
                        {s.distance_km != null ? `${s.distance_km} km · ` : ''}
                        {s.available_count}/{s.connector_count} free
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                      {s.connectors.slice(0, 6).map((c) => (
                        <Pill key={c.connector_ref} s={c.status} />
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                      <button className="btn sm" onClick={() => setSel(s.station_id)} aria-pressed={on}>
                        {on ? 'Selected' : 'Select'}
                      </button>
                      <Link href={`/stations/${s.station_id}`} className="btn sm pri">
                        Open · Reserve
                      </Link>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
        <aside className="card hl" style={{ position: 'sticky', top: 80 }}>
          <div className="micro">SELECTED STATION</div>
          {cur ? (
            <>
              <h3 style={{ margin: 'var(--sp-2) 0', fontSize: '1.15rem' }}>{cur.name}</h3>
              <p style={{ color: 'var(--tx2)', margin: 0, fontSize: 13 }}>
                {cur.address_line}, {cur.city}
              </p>
              <div className="tiles" style={{ marginTop: 'var(--sp-3)' }}>
                {cur.connectors.map((c) => (
                  <div key={c.connector_ref} className="tile">
                    <div className="num">{c.standard_code}</div>
                    <div className="num micro">{c.max_power_kw} kW</div>
                    <Pill s={c.status} />
                  </div>
                ))}
              </div>
              <Link
                href={`/stations/${cur.station_id}`}
                className="btn pri"
                style={{ marginTop: 'var(--sp-3)', width: '100%', justifyContent: 'center' }}
              >
                Reserve a connector
              </Link>
            </>
          ) : (
            <p style={{ color: 'var(--tx2)' }}>Pick a station — on the map or in the list.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
