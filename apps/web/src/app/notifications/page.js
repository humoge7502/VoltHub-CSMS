'use client';
import { useEffect, useState } from 'react';
import { api, Pill, PageHead, EmptyState, AuthGate } from '../../lib/ui';

export default function Notifications() {
  const [list, setList] = useState([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const load = () =>
    api('/me/notifications')
      .then((j) => {
        setList(j.notifications);
        setErr('');
      })
      .catch((e) => setErr(e))
      .finally(() => setLoading(false));
  useEffect(() => {
    load();
  }, []);
  const read = async (id) => {
    try {
      await api(`/me/notifications/${id}/read`, { method: 'POST' });
      load();
    } catch (e) {
      setMsg(e.message);
    }
  };
  return (
    <div className="wrap">
      <PageHead
        eyebrow="DRIVER · RESERVATION / SESSION / INVOICE EVENTS"
        title="Notifications"
        lede="In-app events only — nothing leaves the system, nothing to unsubscribe from."
      />
      {msg && (
        <p className="err" role="alert">
          {msg}
        </p>
      )}
      <AuthGate error={err}>
        {!loading && !list.length && !err ? (
          <EmptyState
            title="All quiet"
            body="Reservation confirmations, session events and invoice receipts will land here."
          />
        ) : (
          <div className="grid">
            {list.map((n) => {
              const unread = n.is_read === 'N';
              return (
                <article
                  key={n.notification_id}
                  className={`card ${unread ? 'hl' : ''}`}
                  style={unread ? undefined : { opacity: 0.7 }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Pill s={unread ? 'BOOKED' : 'EXPIRED'} />
                    <b>{n.title}</b>
                    <span className="micro num" style={{ marginLeft: 'auto' }}>
                      {new Date(n.created_at).toLocaleString()}
                    </span>
                  </div>
                  <div className="num micro" style={{ marginTop: 4 }}>
                    {n.kind}
                  </div>
                  {unread && (
                    <button className="btn sm" style={{ marginTop: 8 }} onClick={() => read(n.notification_id)}>
                      Mark read
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </AuthGate>
    </div>
  );
}
