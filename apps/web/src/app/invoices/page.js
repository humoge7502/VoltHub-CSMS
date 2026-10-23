'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, Pill, inr, PageHead, PageState, AuthGate, EmptyState } from '../../lib/ui';

export default function Invoices() {
  const [invs, setInvs] = useState([]);
  const [w, setW] = useState(null);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [det, setDet] = useState(null);
  const [paying, setPaying] = useState(null); // invoice_id with a Pay POST in flight
  const load = () =>
    Promise.all([api('/invoices').then((j) => setInvs(j.invoices)), api('/me').then((j) => setW(j.wallet))])
      .then(() => {
        setErr('');
      })
      .catch((e) => setErr(e))
      .finally(() => setLoading(false));
  useEffect(() => {
    load();
  }, []);
  const open = async (id) => {
    setMsg('');
    try {
      setDet(await api(`/invoices/${id}`));
    } catch (e) {
      setMsg(e.message);
    }
  };
  // Deep link from the session page (?id=<invoice_id>) actually opens the itemized
  // panel — the param used to be dead: /invoices ignored it entirely.
  useEffect(() => {
    try {
      const q = Number(new URLSearchParams(window.location.search).get('id'));
      if (q) open(q);
    } catch {}
  }, []);
  const pay = async (id) => {
    if (paying) return; // double-click guard — a second POST would 409 noisily
    setMsg('');
    setOk('');
    setPaying(id);
    try {
      await api(`/invoices/${id}/pay`, { method: 'POST' });
      setOk('PAID — ledger appended, balance decremented atomically.');
      load();
    } catch (e) {
      setMsg(`${e.code || ''} ${e.message}`);
    } finally {
      setPaying(null);
    }
  };
  return (
    <div className="wrap">
      <PageHead
        eyebrow="DRIVER · ITEMIZED BILLING · SETTLED FROM THE PREPAID WALLET"
        title="Invoices"
        lede="Every session is billed once, line by line — time-of-use energy bands and the plan's session fee. Payment appends a ledger row and decrements the balance in one transaction."
      />
      <div
        className="card hl"
        style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 'var(--sp-4)' }}
      >
        <div className="kpi">
          <div className="micro">WALLET BALANCE</div>
          <div className="v num">{w ? inr(w.balance) : loading ? '…' : '—'}</div>
        </div>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <Link className="btn" href="/wallet">
            Top up by signature →
          </Link>
        </span>
      </div>
      {ok && (
        <p className="okmsg" role="status">
          {ok}
        </p>
      )}
      {msg && (
        <p className="err" role="alert">
          {msg}
        </p>
      )}
      <AuthGate error={err}>
        <PageState loading={loading} error={err && err.status !== 401 ? String(err.message || err) : ''} onRetry={load}>
          {invs.length ? (
            <div className="tscroll">
              <table className="t">
                <thead>
                  <tr>
                    <th scope="col">Invoice</th>
                    <th scope="col">Session</th>
                    <th scope="col" style={{ textAlign: 'right' }}>
                      Total
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>{' '}
                  </tr>
                </thead>
                <tbody>
                  {invs.map((i) => (
                    <tr key={i.invoice_id}>
                      <td className="num">{i.invoice_id}</td>
                      <td className="num">{i.session_id}</td>
                      <td className="n num">{inr(i.total)}</td>
                      <td>
                        <Pill s={i.status} />
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn sm" onClick={() => open(i.invoice_id)}>
                            Itemize
                          </button>
                          {i.status === 'DUE' && (
                            <button
                              className="btn sm pri"
                              onClick={() => pay(i.invoice_id)}
                              disabled={paying === i.invoice_id}
                            >
                              {paying === i.invoice_id ? 'Paying…' : 'Pay'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="No invoices yet"
              body="Invoices appear after a session is billed — itemized by time-of-use band and session fee."
            />
          )}
        </PageState>
      </AuthGate>
      {det && (
        <section
          className="card hl"
          style={{ marginTop: 'var(--sp-4)' }}
          aria-label={`Invoice ${det.invoice.invoice_id} detail`}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="micro">
              INVOICE #{det.invoice.invoice_id} · {det.invoice.status}
            </div>
            <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setDet(null)}>
              Close ✕
            </button>
          </div>
          {det.lines.map((l) => (
            <div
              key={l.line_no}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 12,
                padding: 'var(--sp-2) 0',
                borderBottom: '1px solid var(--hair)',
              }}
            >
              <span>
                {l.kind} — {l.description}
              </span>
              <span className="num">{inr(l.amount)}</span>
            </div>
          ))}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginTop: 'var(--sp-2)',
              paddingTop: 'var(--sp-2)',
              borderTop: '1px solid var(--hair2)',
            }}
          >
            <b>Total</b>
            <b className="num">{inr(det.invoice.total)}</b>
          </div>
        </section>
      )}
    </div>
  );
}
