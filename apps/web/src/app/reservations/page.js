'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, Pill, PageHead, PageState, ConfirmDialog, EmptyState, AuthGate } from '../../lib/ui';

export default function Reservations() {
  const [list, setList] = useState([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [cancelTarget, setCancelTarget] = useState(null);
  const load = () =>
    api('/reservations')
      .then((j) => {
        setList(j.reservations);
        setErr('');
      })
      .catch((e) => setErr(e))
      .finally(() => setLoading(false));
  useEffect(() => {
    load();
  }, []);
  const cancel = async (id) => {
    setMsg('');
    try {
      await api(`/reservations/${id}/cancel`, { method: 'POST' });
      setCancelTarget(null);
      load();
    } catch (e) {
      setCancelTarget(null);
      setMsg(e.message);
    }
  };
  const startSession = async (r) => {
    setMsg('');
    try {
      const [cp, no] = r.connector_ref.split(':').map(Number);
      const j = await api('/sessions/start', {
        method: 'POST',
        body: JSON.stringify({ cpId: cp, connectorNo: no, reservationId: r.reservation_id, planId: 2 }),
      });
      window.location = `/session/${j.session.session_id}`;
    } catch (e) {
      setMsg(e.message);
    }
  };
  return (
    <div className="wrap">
      <PageHead
        eyebrow="DRIVER · YOUR BOOKED WINDOWS"
        title="Reservations"
        lede="A booking holds a connector for a window. Cancel it, or plug in when you arrive."
      />
      {msg && (
        <p className="err" role="alert">
          {msg}
        </p>
      )}
      <AuthGate error={err}>
        <PageState loading={loading} error={err && err.status !== 401 ? String(err.message || err) : ''} onRetry={load}>
          {list.length ? (
            <div className="tscroll">
              <table className="t">
                <thead>
                  <tr>
                    <th scope="col">ID</th>
                    <th scope="col">Connector</th>
                    <th scope="col">Window</th>
                    <th scope="col">Status</th>
                    <th scope="col" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.reservation_id}>
                      <td className="n">#{r.reservation_id}</td>
                      <td className="n">{r.connector_ref}</td>
                      <td className="num">
                        {new Date(r.start_at).toLocaleString()} → {new Date(r.end_at).toLocaleTimeString()}
                      </td>
                      <td>
                        <Pill s={r.status} />
                      </td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        {r.status === 'BOOKED' && (
                          <>
                            <button className="btn sm" onClick={() => setCancelTarget(r)}>
                              Cancel
                            </button>
                            <button className="btn sm pri" onClick={() => startSession(r)}>
                              Plug in
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="No bookings yet"
              body="Find a station on the corridor and hold a connector for the window you need."
              action={
                <Link href="/discover" className="btn pri">
                  Find a charger
                </Link>
              }
            />
          )}
        </PageState>
      </AuthGate>
      <ConfirmDialog
        open={!!cancelTarget}
        eyebrow="CANCEL RESERVATION"
        title={`Release ${cancelTarget?.connector_ref ?? ''}?`}
        body="The window frees immediately and another driver can take it. This cannot be undone."
        confirmLabel="Cancel reservation"
        danger
        onConfirm={() => cancel(cancelTarget.reservation_id)}
        onCancel={() => setCancelTarget(null)}
      />
    </div>
  );
}
