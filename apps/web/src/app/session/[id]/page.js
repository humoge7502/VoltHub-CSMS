'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, Pill, Line, Toasts, toast, inr, ConfirmDialog } from '../../../lib/ui';

export default function LiveSession() {
  // Next 16: dynamic-route params come from useParams(), not the page props.
  const params = useParams();
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState('');
  const [confirmStop, setConfirmStop] = useState(false);
  const id = params.id;
  const load = () =>
    api(`/sessions/${id}/live`)
      .then((x) => {
        setD(x);
        setMsg('');
      })
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
        <div className="skel" style={{ height: 60, maxWidth: 280 }} />
        <div className="skel" style={{ height: 120, marginTop: 12 }} />
        <div className="skel" style={{ height: 200, marginTop: 12 }} />
        {msg && (
          <p className="err" role="alert" style={{ marginTop: 12 }}>
            {msg}
          </p>
        )}
      </div>
    );
  const { session: s, live } = d;
  const stop = async () => {
    setConfirmStop(false);
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
      <header className="rise">
        <div className="micro">LIVE SESSION · {s.connector_ref} · 5 s POLL</div>
        <h1 className="display num" style={{ fontSize: 'clamp(2.4rem, 6vw, 4rem)', margin: 'var(--sp-3) 0 0' }}>
          {live.energy_kwh.toFixed(2)} <span style={{ fontSize: '0.35em', color: 'var(--tx2)' }}>kWh</span>
        </h1>
        <div style={{ display: 'flex', gap: 8, marginTop: 'var(--sp-3)' }}>
          <Pill s={s.state} /> <Pill s={s.billing_state === 'UNBILLED' ? 'DUE' : 'PAID'} />
        </div>
      </header>
      <div className="grid cards" style={{ marginTop: 'var(--sp-5)' }}>
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
      <section className="card" style={{ marginTop: 'var(--sp-4)' }}>
        <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
          <h2 style={{ fontSize: '1rem' }}>Power trace</h2>
          <p>One tick per MeterValues frame — the same event the billing engine sees.</p>
        </div>
        <Line pts={live.ticks.map((t) => ({ avg_kw: t.power_kw }))} id="trace" />
      </section>
      <div style={{ display: 'flex', gap: 8, marginTop: 'var(--sp-4)', flexWrap: 'wrap' }}>
        {['PREPARING', 'CHARGING', 'SUSPENDED'].includes(s.state) && (
          <button className="btn danger" onClick={() => setConfirmStop(true)}>
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
        <p className="err" role="alert" style={{ marginTop: 'var(--sp-3)' }}>
          {msg}
        </p>
      )}
      <ConfirmDialog
        open={confirmStop}
        eyebrow="REMOTE STOP"
        title="Stop this charge?"
        body="The gateway sends RemoteStopTransaction to the charge point. The session settles at the metered total."
        confirmLabel="Stop charging"
        danger
        onConfirm={stop}
        onCancel={() => setConfirmStop(false)}
      />
    </div>
  );
}
