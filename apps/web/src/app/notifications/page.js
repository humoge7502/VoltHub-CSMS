'use client';
import { useEffect, useState } from 'react';
import { api, Pill } from '../../lib/ui';

export default function Notifications() {
  const [list, setList] = useState([]);
  const [msg, setMsg] = useState('');
  const load = () =>
    api('/me/notifications')
      .then((j) => setList(j.notifications))
      .catch((e) => setMsg(e.message || 'log in to see notifications'));
  useEffect(() => {
    load();
  }, []);
  const read = async (id) => {
    await api(`/me/notifications/${id}/read`, { method: 'POST' });
    load();
  };
  return (
    <div className="wrap">
      <div className="micro">IN-APP EVENTS · RESERVATION / SESSION / INVOICE</div>
      <h1 className="display" style={{ fontSize: '2.4rem' }}>
        Notifications
      </h1>
      {msg && <p className="err">{msg}</p>}
      {list.map((n) => (
        <div key={n.notification_id} className="card" style={{ marginTop: 8, opacity: n.is_read === 'Y' ? 0.6 : 1 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Pill s={n.is_read === 'Y' ? 'EXPIRED' : 'BOOKED'} />
            <b>{n.title}</b>
            <span className="micro" style={{ marginLeft: 'auto' }}>
              {new Date(n.created_at).toLocaleString()}
            </span>
          </div>
          <div className="num micro" style={{ marginTop: 4 }}>
            {n.kind}
          </div>
          {n.is_read === 'N' && (
            <button className="btn" style={{ marginTop: 8 }} onClick={() => read(n.notification_id)}>
              Mark read
            </button>
          )}
        </div>
      ))}
      {!list.length && !msg && <p style={{ color: 'var(--tx2)' }}>All quiet.</p>}
    </div>
  );
}
