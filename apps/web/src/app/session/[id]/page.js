'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  api,
  usePoll,
  Pill,
  Line,
  Toasts,
  toast,
  inr,
  ConfirmDialog,
  useCountUp,
  StaleChip,
  IST,
} from '../../../lib/ui';

const fmtTime = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: IST })
    : '—';
const fmtDate = (iso) =>
  iso
    ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: IST })
    : '—';

export default function LiveSession() {
  // Next 16: dynamic-route params come from useParams(), not the page props.
  const params = useParams();
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState('');
  const [confirmStop, setConfirmStop] = useState(false);
  // One in-flight guard for every mutation on this page (declared with the other hooks —
  // a useState below the `if (!d)` skeleton is the React #310 crash this route already
  // shipped once). The old code closed the stop dialog BEFORE awaiting the call, so a
  // 409/500 left the operator looking at a settled-looking page, and Suspend/Resume/
  // Invoice could be clicked again while the previous PATCH was still running.
  const [busy, setBusy] = useState('');
  // A session that has reached a terminal state has nothing left to poll (the old
  // interval kept hitting /sessions/:id/live every 5 s forever after the stop).
  const [terminal, setTerminal] = useState(false);
  const id = params.id;
  useEffect(() => {
    setTerminal(false);
  }, [id]);
  // Poll hygiene: usePoll sequence-guards (via AbortController — a superseded or
  // unmounted tick cannot write state at all), never overlaps a tick, and pauses when
  // the tab is hidden so a driver watching the meter on a phone doesn't burn battery or
  // queue requests behind a stalled one.
  const { status, error, refresh } = usePoll(
    ({ signal }) =>
      api(`/sessions/${id}/live`, { signal }).then((x) => {
        setD(x);
        setMsg('');
        const st = x?.session?.state;
        if (st) setTerminal(!['PREPARING', 'CHARGING', 'SUSPENDED'].includes(st));
      }),
    {
      intervalMs: 5000,
      enabled: !terminal,
      // Navigating /session/1 → /session/2 reuses this component, so the loop is scoped
      // to the id: the old session's meter is cleared and its request aborted rather
      // than shown for up to 5 s under the new session's header.
      scope: id,
      reset: () => setD(null),
    }
  );
  const load = refresh;
  // Hooks must run on EVERY render: this call used to sit below the `if (!d)` skeleton
  // return, so render 1 (no data) registered fewer hooks than render 2 (data arrived)
  // and React aborted the route with "rendered more hooks than during the previous
  // render" — the live session page never mounted at all in a production build. The
  // count-up now runs unconditionally and animates from the skeleton's zero.
  const energy = useCountUp(d?.live?.energy_kwh ?? 0);
  if (!d)
    return (
      <div className="wrap">
        <Toasts />
        <div className="skel" style={{ height: 60, maxWidth: 280 }} />
        <div className="skel" style={{ height: 120, marginTop: 12 }} />
        <div className="skel" style={{ height: 200, marginTop: 12 }} />
        {(msg || error) && (
          <p className="err" role="alert" style={{ marginTop: 12 }}>
            {msg || error}
          </p>
        )}
      </div>
    );
  const { session: s, live } = d;
  const isLive = ['PREPARING', 'CHARGING', 'SUSPENDED'].includes(s.state);
  const mutate = async (key, run) => {
    if (busy) return;
    setBusy(key);
    try {
      await run();
      setMsg('');
    } catch (e) {
      setMsg(`${e.code || ''} ${e.message}`.trim());
      toast(`${e.code || ''} ${e.message}`.trim(), 'err');
    } finally {
      setBusy('');
    }
  };
  const stop = () =>
    mutate('stop', async () => {
      await api(`/sessions/${s.session_id}/remote-stop`, { method: 'POST' });
      setConfirmStop(false); // only on success — a failure leaves the dialog open to retry
      toast('Charge stopped');
      load();
    });
  const setState = (to) =>
    mutate(`state:${to}`, async () => {
      await api(`/sessions/${s.session_id}/state`, {
        method: 'PATCH',
        body: JSON.stringify({ to, reason: 'OPERATOR_CONSOLE' }),
      });
      toast(`State → ${to}`);
      load();
    });
  const bill = () =>
    mutate('bill', async () => {
      const j = await api(`/sessions/${s.session_id}/bill`, { method: 'POST' });
      toast(`Invoice ${j.invoice.invoice_id} issued`);
      window.location = `/invoices?id=${j.invoice.invoice_id}`;
    });
  const ticks = live.ticks || [];
  const peak = ticks.reduce((m, t) => Math.max(m, Number(t.power_kw) || 0), 0);

  return (
    <div className="wrap">
      <Toasts />
      <header className="rise" style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--sp-6)' }}>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div className="micro">
            {isLive ? 'LIVE SESSION' : 'SESSION'} · {s.connector_ref} · {isLive ? '5 s POLL' : fmtDate(s.started_at)}
          </div>
          {/* A poll that failed after the first good frame keeps the meter on screen —
              it must not silently read as a live number that is simply not moving. */}
          {status === 'stale' && <StaleChip />}
          {/* Scoped live region: only the hero number is announced — the old
              whole-page aria-live re-read the ENTIRE view every 5 s. */}
          <h1
            className="display num"
            aria-live="polite"
            aria-atomic="true"
            aria-label={`${live.energy_kwh.toFixed(2)} kilowatt hours${isLive ? ', live' : ''}`}
            style={{ fontSize: 'clamp(2.4rem, 6vw, 4rem)', margin: 'var(--sp-3) 0 0' }}
          >
            <span aria-hidden="true">
              {energy.toFixed(2)} <span style={{ fontSize: '0.35em', color: 'var(--tx2)' }}>kWh</span>
            </span>
          </h1>
          <div style={{ display: 'flex', gap: 8, marginTop: 'var(--sp-3)', flexWrap: 'wrap' }}>
            <Pill s={s.state} /> <Pill s={s.billing_state === 'UNBILLED' ? 'DUE' : 'PAID'} />
            {s.reservation_id && <Pill s={`RES #${s.reservation_id}`} />}
          </div>
        </div>
        {isLive && (
          <div style={{ textAlign: 'right', flex: '0 0 auto' }}>
            <div className="micro">METERING</div>
            <div className="num" style={{ fontSize: '1.5rem', color: 'var(--lime)' }}>
              ● receiving
            </div>
            <div className="micro" style={{ color: 'var(--tx3)' }}>
              {ticks.length} frames · OCPP 1.6J
            </div>
          </div>
        )}
      </header>

      <div className="grid cards" style={{ marginTop: 'var(--sp-5)' }}>
        <div className="card kpi">
          <div className="micro">Power</div>
          <div className="v num live-dot">{live.power_kw ?? '—'} kW</div>
          <div className="micro" style={{ color: 'var(--tx3)' }}>
            peak {peak.toFixed(1)} kW
          </div>
        </div>
        <div className="card kpi">
          <div className="micro">Elapsed</div>
          <div className="v num">
            {Math.floor(live.elapsed_s / 60)}m {live.elapsed_s % 60}s
          </div>
          <div className="micro" style={{ color: 'var(--tx3)' }}>
            since {fmtTime(s.started_at)} IST
          </div>
        </div>
        <div className="card kpi">
          <div className="micro">Est. cost</div>
          <div className="v num">{inr(live.est_cost)}</div>
          <div className="micro" style={{ color: 'var(--tx3)' }}>
            time-of-use + session fee
          </div>
        </div>
        <div className="card kpi">
          <div className="micro">Meter register</div>
          <div className="v num">{live.energy_kwh.toFixed(2)} kWh</div>
          <div className="micro" style={{ color: 'var(--tx3)' }}>
            start {s.start_meter_kwh ?? 0} kWh · absolute register
          </div>
        </div>
      </div>

      <div className="two" style={{ marginTop: 'var(--sp-4)' }}>
        <section className="card">
          <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
            <h2 style={{ fontSize: '1rem' }}>Power trace</h2>
            <p>One tick per MeterValues frame — the same event the billing engine sees.</p>
          </div>
          <Line pts={ticks.map((t) => ({ avg_kw: t.power_kw, ts: t.taken_at }))} id="trace" h={200} live={isLive} />
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginTop: 'var(--sp-3)',
              paddingTop: 'var(--sp-3)',
              borderTop: '1px solid var(--hair)',
            }}
          >
            <span className="micro" style={{ color: 'var(--tx3)' }}>
              LAST FRAME {ticks.length ? fmtTime(ticks[ticks.length - 1].taken_at) : '—'} IST
            </span>
            <span className="micro" style={{ color: 'var(--tx3)' }}>
              {s.id_tag} · {ticks.length} samples
            </span>
          </div>
        </section>

        <aside className="card">
          <div className="micro">SESSION FACTS</div>
          <dl className="kv">
            <dt>Session</dt>
            <dd className="num">#{s.session_id}</dd>
            <dt>Connector</dt>
            <dd className="num">{s.connector_ref}</dd>
            <dt>Tariff plan</dt>
            <dd className="num">#{s.tariff_plan_id}</dd>
            <dt>Id tag</dt>
            <dd className="num">{s.id_tag}</dd>
            <dt>Started</dt>
            <dd className="num">
              {fmtDate(s.started_at)} · {fmtTime(s.started_at)}
            </dd>
            <dt>Ended</dt>
            <dd className="num">{s.ended_at ? `${fmtDate(s.ended_at)} · ${fmtTime(s.ended_at)}` : '—'}</dd>
            <dt>Billing</dt>
            <dd>
              <Pill s={s.billing_state} />
            </dd>
            <dt>Reservation</dt>
            <dd className="num">{s.reservation_id ? `#${s.reservation_id}` : 'walk-in'}</dd>
          </dl>
          <div style={{ marginTop: 'var(--sp-4)', display: 'grid', gap: 8 }}>
            <Link className="btn" href="/invoices">
              Open invoices →
            </Link>
            <Link className="btn" href="/history">
              Session history →
            </Link>
          </div>
        </aside>
      </div>

      <section className="card" style={{ marginTop: 'var(--sp-4)' }}>
        <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
          <h2 style={{ fontSize: '1rem' }}>Meter frames</h2>
          <p>The last OCPP MeterValues frames in arrival order — the raw rows behind the trace above.</p>
        </div>
        <table className="t">
          <caption className="micro" style={{ textAlign: 'left', paddingBottom: 8 }}>
            Recent OCPP meter frames
          </caption>
          <thead>
            <tr>
              <th scope="col">Frame</th>
              <th scope="col">Taken (IST)</th>
              <th scope="col" style={{ textAlign: 'right' }}>
                Meter
              </th>
              <th scope="col" style={{ textAlign: 'right' }}>
                Power
              </th>
              <th scope="col" style={{ textAlign: 'right' }}>
                Delta
              </th>
            </tr>
          </thead>
          <tbody>
            {[...ticks]
              .reverse()
              .slice(0, 6)
              .map((t, i, arr) => {
                const prev = arr[i + 1];
                const delta = prev ? Number(t.meter_kwh) - Number(prev.meter_kwh) : null;
                return (
                  <tr key={t.seq_no}>
                    <td className="num">#{t.seq_no}</td>
                    <td className="num">{fmtTime(t.taken_at)}</td>
                    <td className="n num">{Number(t.meter_kwh).toFixed(2)} kWh</td>
                    <td className="n num">{Number(t.power_kw).toFixed(1)} kW</td>
                    <td className="n num" style={{ color: 'var(--lime)' }}>
                      {delta == null ? '—' : `+${delta.toFixed(2)}`}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </section>

      <div style={{ display: 'flex', gap: 8, marginTop: 'var(--sp-4)', flexWrap: 'wrap' }}>
        {isLive && (
          <button className="btn danger" onClick={() => setConfirmStop(true)} disabled={!!busy}>
            Stop charging
          </button>
        )}
        {s.state === 'CHARGING' && (
          <button className="btn" onClick={() => setState('SUSPENDED')} disabled={!!busy}>
            {busy === 'state:SUSPENDED' ? 'Suspending…' : 'Suspend'}
          </button>
        )}
        {s.state === 'SUSPENDED' && (
          <button className="btn" onClick={() => setState('CHARGING')} disabled={!!busy}>
            {busy === 'state:CHARGING' ? 'Resuming…' : 'Resume'}
          </button>
        )}
        {s.state === 'COMPLETED' && s.billing_state === 'UNBILLED' && (
          <button className="btn pri" onClick={bill} disabled={!!busy}>
            {busy === 'bill' ? 'Issuing…' : 'Generate invoice'}
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
        busyLabel="Stopping…"
        busy={busy === 'stop'}
        danger
        onConfirm={stop}
        onCancel={() => setConfirmStop(false)}
      />
    </div>
  );
}
