'use client';
import { useEffect, useState } from 'react';
import { api, Pill, CorridorMap } from '../../lib/ui';

export default function Discover() {
  const [st, setSt] = useState([]);
  const [q, setQ] = useState('');
  const [std, setStd] = useState('');
  const [sel, setSel] = useState(null);
  const [err, setErr] = useState('');
  const load = () =>
    api(`/stations?q=${encodeURIComponent(q)}${std ? `&std=${std}` : ''}&lat=12.97&lng=80.06&radius=60`)
      .then((j) => {
        setErr('');
        setSt(j.stations);
        if (!sel && j.stations[0]) setSel(j.stations[0].station_id);
      })
      .catch((e) => setErr('API unreachable — start it: npm run dev:api (localhost:4000)'));
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
  const cur = st.find((s) => s.station_id === sel);
  return (
    <div className="wrap">
      <h1 className="display" style={{ fontSize: '2.4rem' }}>
        Discover
      </h1>
      <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        <input
          placeholder="search name / area…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()}
        />
        <select value={std} onChange={(e) => setStd(e.target.value)} style={{ maxWidth: 180 }}>
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
      {err && <p className="err">{err}</p>}
      <div className="two">
        <div className="grid">
          <CorridorMap stations={st} selected={sel} onPick={(s) => setSel(s.station_id)} />
          <div className="grid">
            {st.map((s) => (
              <div
                key={s.station_id}
                className="card"
                style={{ borderColor: sel === s.station_id ? 'var(--cream)' : undefined }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <b>{s.name}</b>
                  <span className="num micro">
                    {s.distance_km ?? '—'} km · {s.available_count}/{s.connector_count} free
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {s.connectors.slice(0, 6).map((c) => (
                    <Pill key={c.connector_ref} s={c.status} />
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button className="btn" onClick={() => setSel(s.station_id)}>
                    Select
                  </button>
                  <a href={`/stations/${s.station_id}`}>
                    <button className="btn pri">Open · Reserve</button>
                  </a>
                </div>
              </div>
            ))}
            {!st.length && <div className="skel" style={{ height: 120 }} />}
          </div>
        </div>
        <div className="card">
          <div className="micro">SELECTED STATION</div>
          {cur ? (
            <>
              <h3>{cur.name}</h3>
              <p style={{ color: 'var(--tx2)' }}>
                {cur.address_line}, {cur.city}
              </p>
              <div className="tiles">
                {cur.connectors.map((c) => (
                  <div key={c.connector_ref} className="tile">
                    <div className="num">{c.standard_code}</div>
                    <div className="num">{c.max_power_kw} kW</div>
                    <Pill s={c.status} />
                  </div>
                ))}
              </div>
              <a href={`/stations/${cur.station_id}`}>
                <button className="btn pri" style={{ marginTop: 12, width: '100%' }}>
                  Reserve a connector
                </button>
              </a>
            </>
          ) : (
            '—'
          )}
        </div>
      </div>
    </div>
  );
}
