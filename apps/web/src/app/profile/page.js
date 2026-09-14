'use client';
import { useEffect, useState } from 'react';
import { api, logout, PageHead, ConfirmDialog } from '../../lib/ui';

export default function Profile() {
  const [me, setMe] = useState(null);
  const [v, setV] = useState([]);
  const [f, setF] = useState({ make: 'Tata', model: 'Nexon EV', battery_kwh: 40.5 });
  const [msg, setMsg] = useState('');
  const [confirmOut, setConfirmOut] = useState(false);
  useEffect(() => {
    api('/me')
      .then(setMe)
      .catch(() => (window.location = '/login'));
    api('/me/vehicles')
      .then((j) => setV(j.vehicles))
      .catch(() => {});
  }, []);
  const add = async () => {
    setMsg('');
    try {
      await api('/me/vehicles', { method: 'POST', body: JSON.stringify(f) });
      const j = await api('/me/vehicles');
      setV(j.vehicles);
      setMsg('EV added.');
    } catch (e) {
      setMsg(e.message);
    }
  };
  if (!me)
    return (
      <div className="wrap">
        <div className="skel" style={{ height: 60, maxWidth: 320 }} />
        <div className="skel" style={{ height: 160, marginTop: 12 }} />
      </div>
    );
  return (
    <div className="wrap">
      <PageHead
        eyebrow={`${me.user.role} · ${me.user.email}`}
        title={me.user.full_name}
        lede="Your account and registered vehicles. Vehicle battery size feeds the reservation advisor."
      />
      <section className="sec" style={{ paddingTop: 0, borderTop: 0 }}>
        <div className="sec-h">
          <h2>My EVs</h2>
        </div>
        <div className="grid" style={{ maxWidth: 560 }}>
          {v.map((x) => (
            <div key={x.vehicle_id} className="card" style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <b>
                {x.make} {x.model}
              </b>
              <span className="num micro" style={{ marginLeft: 'auto' }}>
                {x.battery_kwh} kWh
              </span>
            </div>
          ))}
          {!v.length && <p style={{ color: 'var(--tx2)' }}>No vehicles registered yet.</p>}
        </div>
        <form
          className="card"
          style={{ marginTop: 'var(--sp-3)', maxWidth: 560 }}
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <div className="micro">REGISTER EV</div>
          <div className="fieldrow" style={{ marginTop: 8 }}>
            <input
              value={f.make}
              onChange={(e) => setF({ ...f, make: e.target.value })}
              placeholder="Make"
              aria-label="Make"
              required
            />
            <input
              value={f.model}
              onChange={(e) => setF({ ...f, model: e.target.value })}
              placeholder="Model"
              aria-label="Model"
              required
            />
            <input
              type="number"
              value={f.battery_kwh}
              onChange={(e) => setF({ ...f, battery_kwh: e.target.value })}
              placeholder="Battery kWh"
              aria-label="Battery capacity in kWh"
              required
              style={{ maxWidth: 140 }}
            />
            <button className="btn pri" type="submit">
              Add
            </button>
          </div>
          {msg && (
            <p className="okmsg" role="status" style={{ marginTop: 8 }}>
              {msg}
            </p>
          )}
        </form>
      </section>
      <button className="btn danger" onClick={() => setConfirmOut(true)}>
        Log out
      </button>
      <ConfirmDialog
        open={confirmOut}
        eyebrow="LOG OUT"
        title="End this session?"
        body="Your refresh family is revoked server-side — every tab on this device signs out."
        confirmLabel="Log out"
        danger
        onConfirm={async () => {
          setConfirmOut(false);
          await logout();
          window.location = '/';
        }}
        onCancel={() => setConfirmOut(false)}
      />
    </div>
  );
}
