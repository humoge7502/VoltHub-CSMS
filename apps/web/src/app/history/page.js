'use client';
import { useEffect, useState } from 'react';
import { api, Pill, kwh } from '../../lib/ui';

export default function History() {
  const [list, setList] = useState([]);
  const [cur, setCur] = useState(null);
  const load = (c) =>
    api(`/sessions${c ? `?cursor=${c}` : ''}`).then((j) => {
      setList((x) => (c ? [...x, ...j.sessions] : j.sessions));
      setCur(j.nextCursor);
    });
  useEffect(() => {
    load().catch(() => {});
  }, []);
  return (
    <div className="wrap">
      <h1 className="display" style={{ fontSize: '2.4rem' }}>
        History
      </h1>
      <table className="t" style={{ marginTop: 16 }}>
        <thead>
          <tr>
            <th>Session</th>
            <th>Connector</th>
            <th>Started</th>
            <th style={{ textAlign: 'right' }}>Energy</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.session_id}>
              <td className="n">
                <a href={`/session/${s.session_id}`}>{s.session_id}</a>
              </td>
              <td className="n">{s.connector_ref}</td>
              <td className="num">{new Date(s.started_at).toLocaleString()}</td>
              <td className="n num">{s.energy_kwh != null ? kwh(s.energy_kwh) : '—'}</td>
              <td>
                <Pill s={s.state} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {cur && (
        <button className="btn" style={{ marginTop: 12 }} onClick={() => load(cur)}>
          Load more (keyset)
        </button>
      )}
    </div>
  );
}
