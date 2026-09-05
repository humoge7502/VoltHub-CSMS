'use client';
import { useEffect, useState } from 'react';
import { api, Pill } from '../../lib/ui';

export default function Reservations() {
  const [list, setList] = useState([]); const [msg, setMsg] = useState('');
  const load = () => api('/reservations').then(j => setList(j.reservations)).catch(e => setMsg(e.message));
  useEffect(() => { load(); }, []);
  const cancel = async (id) => { try { await api(`/reservations/${id}/cancel`, { method: 'POST' }); load(); } catch (e) { setMsg(e.message); } };
  const startSession = async (r) => {
    try {
      const [cp, no] = r.connector_ref.split(':').map(Number);
      const j = await api('/sessions/start', { method: 'POST', body: JSON.stringify({ cpId: cp, connectorNo: no, reservationId: r.reservation_id, planId: 2 }) });
      window.location = `/session/${j.session.session_id}`;
    } catch (e) { setMsg(e.message); }
  };
  return (
    <div className="wrap">
      <h1 className="display" style={{ fontSize: '2.4rem' }}>Reservations</h1>
      {msg && <p className="err">{msg}</p>}
      <table className="t" style={{ marginTop: 16 }}>
        <thead><tr><th>ID</th><th>Connector</th><th>Window</th><th>Status</th><th></th></tr></thead>
        <tbody>{list.map(r => (
          <tr key={r.reservation_id}><td className="n">{r.reservation_id}</td><td className="n">{r.connector_ref}</td>
            <td className="num">{new Date(r.start_at).toLocaleString()} → {new Date(r.end_at).toLocaleTimeString()}</td>
            <td><Pill s={r.status} /></td>
            <td style={{ display: 'flex', gap: 6 }}>
              {r.status === 'BOOKED' && <><button className="btn" onClick={() => cancel(r.reservation_id)}>Cancel</button><button className="btn pri" onClick={() => startSession(r)}>Plug in</button></>}
            </td></tr>))}
        </tbody>
      </table>
      {!list.length && <p style={{ color: 'var(--tx2)' }}>No bookings yet — <a href="/discover">find a charger</a>.</p>}
    </div>
  );
}
