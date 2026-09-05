'use client';
import { useEffect, useState } from 'react';
import { api, Pill, inr } from '../../lib/ui';

export default function Invoices() {
  const [invs, setInvs] = useState([]);
  const [w, setW] = useState(null);
  const [msg, setMsg] = useState('');
  const [det, setDet] = useState(null);
  const load = () =>
    Promise.all([api('/invoices').then((j) => setInvs(j.invoices)), api('/me').then((j) => setW(j.wallet))]).catch(
      (e) => setMsg(e.message)
    );
  useEffect(() => {
    load();
  }, []);
  const pay = async (id) => {
    try {
      await api(`/invoices/${id}/pay`, { method: 'POST' });
      setMsg('PAID — ledger appended, balance decremented atomically.');
      load();
    } catch (e) {
      setMsg(`${e.code || ''} ${e.message}`);
    }
  };
  const open = async (id) => setDet(await api(`/invoices/${id}`));
  const topup = async (amt) => {
    await api('/me/wallet/topup', { method: 'POST', body: JSON.stringify({ amount: amt }) });
    load();
  };
  return (
    <div className="wrap">
      <h1 className="display" style={{ fontSize: '2.4rem' }}>
        Wallet
      </h1>
      <div className="card" style={{ margin: '16px 0', display: 'flex', gap: 12, alignItems: 'center' }}>
        <div className="kpi">
          <div className="micro">BALANCE</div>
          <div className="v num">{w ? inr(w.balance) : '…'}</div>
        </div>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {[500, 1000, 2000].map((a) => (
            <button key={a} className="btn" onClick={() => topup(a)}>
              +{inr(a)}
            </button>
          ))}
        </span>
      </div>
      {msg && <p className={msg.startsWith('PAID') ? 'okmsg' : 'err'}>{msg}</p>}
      <table className="t">
        <thead>
          <tr>
            <th>Invoice</th>
            <th>Session</th>
            <th style={{ textAlign: 'right' }}>Total</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {invs.map((i) => (
            <tr key={i.invoice_id}>
              <td className="n">{i.invoice_id}</td>
              <td className="n">{i.session_id}</td>
              <td className="n num">{inr(i.total)}</td>
              <td>
                <Pill s={i.status} />
              </td>
              <td style={{ display: 'flex', gap: 6 }}>
                <button className="btn" onClick={() => open(i.invoice_id)}>
                  Itemize
                </button>
                {i.status === 'DUE' && (
                  <button className="btn pri" onClick={() => pay(i.invoice_id)}>
                    Pay
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {det && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="micro">
            INVOICE #{det.invoice.invoice_id} · {det.invoice.status}
          </div>
          {det.lines.map((l) => (
            <div key={l.line_no} style={{ display: 'flex', justifyContent: 'space-between' }}>
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
              borderTop: '1px solid var(--hair)',
              marginTop: 8,
              paddingTop: 8,
            }}
          >
            <b>Total</b>
            <b className="num">{inr(det.invoice.total)}</b>
          </div>
        </div>
      )}
    </div>
  );
}
