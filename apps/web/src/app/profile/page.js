'use client';
import { useEffect, useState } from 'react';
import { api, logout } from '../../lib/ui';

export default function Profile() {
  const [me, setMe] = useState(null); const [v, setV] = useState([]);
  const [f, setF] = useState({ make: 'Tata', model: 'Nexon EV', battery_kwh: 40.5 });
  useEffect(() => { api('/me').then(setMe).catch(() => window.location = '/login'); api('/me/vehicles').then(j => setV(j.vehicles)).catch(() => {}); }, []);
  const add = async () => { await api('/me/vehicles', { method: 'POST', body: JSON.stringify(f) }); window.location.reload(); };
  if (!me) return <div className="wrap">loading…</div>;
  return (
    <div className="wrap">
      <h1 className="display" style={{ fontSize: '2.4rem' }}>{me.user.full_name}</h1>
      <p className="micro">{me.user.email} · {me.user.role}</p>
      <h3 style={{ marginTop: 24 }}>My EVs</h3>
      {v.map(x => <div key={x.vehicle_id} className="card" style={{ marginTop: 8 }}><b>{x.make} {x.model}</b> <span className="num">· {x.battery_kwh} kWh</span></div>)}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="micro">REGISTER EV</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input value={f.make} onChange={e => setF({ ...f, make: e.target.value })} placeholder="make" />
          <input value={f.model} onChange={e => setF({ ...f, model: e.target.value })} placeholder="model" />
          <input type="number" value={f.battery_kwh} onChange={e => setF({ ...f, battery_kwh: e.target.value })} />
          <button className="btn pri" onClick={add}>Add</button>
        </div>
      </div>
      <button className="btn" style={{ marginTop: 16 }} onClick={() => { logout(); window.location = '/'; }}>Log out</button>
    </div>
  );
}
