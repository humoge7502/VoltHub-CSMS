'use client';
import { useEffect, useState } from 'react';
import { api, Pill, Line, Toasts, toast, kwh, inr } from '../../../lib/ui';

export default function LiveSession({ params }) {
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState('');
  const id = params.id;
  const load = () =>
    api(`/sessions/${id}/live`)
      .then(setD)
      .catch((e) => setMsg(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [id]);
  if (!d)
    return (
      <div className="wrap">
        <Toasts />
        <div className="skel" style={{ height: 220 }} aria-busy="true" aria-label="Loading session" />
        {msg && (
          <p className="err" role="alert">
            {msg}
          </p>
        )}
      </div>
    );
  const { session: s, live } = d;
  const stop = async () => {
    if (!window.confirm('Stop charging?')) return;
    try {
      await api(`/sessions/${s.session_id}/remote-stop`, { method: 'POST' });
      toast('Charge stopped');
      load();
    } catch (e) {
      setMsg(e.message);
      toast(`${e.code || ''} ${e.message}`, 'err');
    }
  };
  const setState = async (to) => {
    try {
      await api(`/sessions/${s.session_id}/state`, {
        method: 'PATCH',
        body: JSON.stringify({ to, reason: 'OPERATOR_CONSOLE' }),
      });
      toast(`State → ${to}`);
      load();
    } catch (e) {
      setMsg(`${e.code || ''} ${e.message}`);
      toast(`${e.code || ''} ${e.message}`, 'err');
    }
  };
  const bill = async () => {
    try {
      const j = await api(`/sessions/${s.session_id}/bill`, { method: 'POST' });
      toast(`Invoice ${j.invoice.invoice_id} issued`);
      window.location = `/invoices?id=${j.invoice.invoice_id}`;
    } catch (e) {
      setMsg(e.message);
      toast(e.message, 'err');
    }
  };
  return (
    <div className="wrap" aria-live="polite">
      <Toasts />
      <div className="micro">LIVE SESSION · {s.connector_ref}</div>
      <h1 className="display num" style={{ fontSize: '3rem' }}>
        {live.energy_kwh.toFixed(2)} <span style={{ fontSize: '1.2rem' }}>kWh</span>
      </h1>
      <div style={{ margin: '8px 0' }}>
        <Pill s={s.state} /> <Pill s={s.billing_state === 'UNBILLED' ? 'DUE' : 'PAID'} />
      </div>
      <div className="grid cards">
        <div className="card kpi">
          <div className="micro">Power</div>
          <div className="v num live-dot">{live.power_kw ?? '—'} kW</div>
        </div>
        <div className="card kpi">
          <div className="micro">Elapsed</div>
          <div className="v num">
            {Math.floor(live.elapsed_s / 60)}m {live.elapsed_s % 60}s
          </div>
        </div>
        <div className="card kpi">
          <div className="micro">Est. cost</div>
          <div className="v num">{inr(live.est_cost)}</div>
        </div>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="micro">POWER TRACE · 5s TICKS</div>
        <Line pts={live.ticks.map((t) => ({ avg_kw: t.power_kw }))} />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        {['PREPARING', 'CHARGING', 'SUSPENDED'].includes(s.state) && (
          <button className="btn danger" onClick={stop}>
            Stop charging
          </button>
        )}
        {s.state === 'CHARGING' && (
          <button className="btn" onClick={() => setState('SUSPENDED')}>
            Suspend
          </button>
        )}
        {s.state === 'SUSPENDED' && (
          <button className="btn" onClick={() => setState('CHARGING')}>
            Resume
          </button>
        )}
        {s.state === 'COMPLETED' && s.billing_state === 'UNBILLED' && (
          <button className="btn pri" onClick={bill}>
            Generate invoice
          </button>
        )}
      </div>
      {msg && (
        <p className="err" role="alert">
          {msg}
        </p>
      )}
    </div>
  );
}
