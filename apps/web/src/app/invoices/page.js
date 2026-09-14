'use client';
import { useEffect, useState } from 'react';
import { api, Pill, inr, PageHead, PageState, AuthGate, EmptyState } from '../../lib/ui';

export default function Invoices() {
  const [invs, setInvs] = useState([]);
  const [w, setW] = useState(null);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [det, setDet] = useState(null);
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
  const pay = async (id) => {
    setMsg('');
    setOk('');
    try {
      await api(`/invoices/${id}/pay`, { method: 'POST' });
      setOk('PAID — ledger appended, balance decremented atomically.');
      load();
    } catch (e) {
      setMsg(`${e.code || ''} ${e.message}`);
    }
  };
  const open = async (id) => {
    setMsg('');
    try {
      setDet(await api(`/invoices/${id}`));
    } catch (e) {
      setMsg(e.message);
    }
  };
  const topup = async (amt) => {
    setMsg('');
    setOk('');
    try {
      await api('/me/wallet/topup', { method: 'POST', body: JSON.stringify({ amount: amt }) });
      setOk(`Wallet credited ${inr(amt)}.`);
      load();
    } catch (e) {
      setMsg(e.message);
    }
  };
  return (
    <div className="wrap">
      <PageHead
        eyebrow="DRIVER · PREPAID WALLET · NO CARD DATA, EVER"
        title="Wallet"
        lede="Top up, settle invoices, inspect every line. Payment is a ledger append and a balance decrement in one transaction."
      />
      <div
        className="card hl"
        style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 'var(--sp-4)' }}
      >
        <div className="kpi">
          <div className="micro">BALANCE</div>
          <div className="v num">{w ? inr(w.balance) : '…'}</div>
        </div>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[500, 1000, 2000].map((a) => (
            <button key={a} className="btn" onClick={() => topup(a)}>
              +{inr(a)}
            </button>
          ))}
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
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invs.map((i) => (
                    <tr key={i.invoice_id}>
                      <td className="n">#{i.invoice_id}</td>
                      <td className="n">{i.session_id}</td>
                      <td className="n num">{inr(i.total)}</td>
                      <td>
                        <Pill s={i.status} />
                      </td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        <button className="btn sm" onClick={() => open(i.invoice_id)}>
                          Itemize
                        </button>
                        {i.status === 'DUE' && (
                          <button className="btn sm pri" onClick={() => pay(i.invoice_id)}>
                            Pay
                          </button>
                        )}
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
          <div className="micro">
            INVOICE #{det.invoice.invoice_id} · {det.invoice.status}
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
