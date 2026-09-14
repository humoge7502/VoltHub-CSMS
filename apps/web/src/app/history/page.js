'use client';
import { useEffect, useState } from 'react';
import { api, Pill, kwh, PageHead, PageState, EmptyState } from '../../lib/ui';

export default function History() {
  const [list, setList] = useState([]);
  const [cur, setCur] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const load = (c) =>
    api(`/sessions${c ? `?cursor=${c}` : ''}`)
      .then((j) => {
        setList((x) => (c ? [...x, ...j.sessions] : j.sessions));
        setCur(j.nextCursor);
        setErr('');
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  useEffect(() => {
    load().catch(() => {});
  }, []);
  return (
    <div className="wrap">
      <PageHead
        eyebrow="DRIVER · EVERY SESSION, OLDEST LEDGER TO NEWEST"
        title="History"
        lede="Charging sessions with metered energy and final state. Open one to see the live power trace."
      />
      <PageState loading={loading} error={err} onRetry={() => load()}>
        {!!list.length && (
          <div className="tscroll">
            <table className="t">
              <thead>
                <tr>
                  <th scope="col">Session</th>
                  <th scope="col">Connector</th>
                  <th scope="col">Started</th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    Energy
                  </th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.session_id}>
                    <td className="n">
                      <a className="link" href={`/session/${s.session_id}`}>
                        #{s.session_id}
                      </a>
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
          </div>
        )}
        {cur && (
          <button className="btn" style={{ marginTop: 'var(--sp-3)' }} onClick={() => load(cur)}>
            Load more (keyset)
          </button>
        )}
      </PageState>
      {!list.length && !loading && !err && (
        <EmptyState
          title="No sessions yet"
          body="Your first charge lands here the moment you plug in."
          action={
            <a href="/discover" className="btn pri">
              Find a charger
            </a>
          }
        />
      )}
    </div>
  );
}
