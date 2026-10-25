'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, inr, PageHead, PageState, AuthGate, Toasts, toast, Pill } from '../../lib/ui';
import {
  hasInjected,
  demoWalletAddress,
  createDemoWallet,
  linkWallet,
  topUpWithSignature,
  shortAddr,
} from '../../lib/wallet-client';

const AMOUNTS = [500, 1000, 2000, 5000];

const STEP_LABEL = {
  intent: 'Authorisation created',
  sign: 'Signed in your wallet',
  verify: 'Signature verified',
  done: 'Ledger credited',
};

export default function WalletPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState('demo');
  const [demoAddr, setDemoAddr] = useState(null);
  const [busy, setBusy] = useState('');
  const [ceremony, setCeremony] = useState(null); // {message, signature, link}
  const [amount, setAmount] = useState(1000);
  const [steps, setSteps] = useState([]); // ['intent','sign','verify','done']
  const [intentMsg, setIntentMsg] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [localErr, setLocalErr] = useState('');

  const load = useCallback(
    () =>
      api('/me/wallet')
        .then((j) => {
          setData(j);
          setErr(null);
        })
        .catch((e) => setErr(e))
        .finally(() => setLoading(false)),
    []
  );

  useEffect(() => {
    load();
    setDemoAddr(demoWalletAddress());
    setMode(hasInjected() ? 'injected' : 'demo');
  }, [load]);

  const linked = data?.links?.[0] || null;
  const balance = data?.wallet?.balance ?? 0;

  // Balance history for the sparkline: ledger is newest-first, the chart wants oldest.
  const series = useMemo(() => {
    const rows = [...(data?.ledger || [])].reverse();
    return rows.map((r) => ({ v: r.balance_after }));
  }, [data]);

  const doCreateDemo = async () => {
    setLocalErr('');
    try {
      setDemoAddr(await createDemoWallet());
      setMode('demo');
    } catch (e) {
      setLocalErr(e.message);
    }
  };

  const doLink = async () => {
    setBusy('link');
    setLocalErr('');
    setCeremony(null);
    try {
      const out = await linkWallet({
        mode,
        label: mode === 'demo' ? 'VoltHub demo wallet' : 'Browser wallet',
      });
      setCeremony(out);
      toast('Wallet linked — signature verified', 'ok');
      await load();
    } catch (e) {
      setLocalErr(e.message || String(e));
    } finally {
      setBusy('');
    }
  };

  const doUnlink = async () => {
    if (!linked) return;
    setBusy('unlink');
    setLocalErr('');
    try {
      await api(`/me/wallet/link/${linked.address}`, { method: 'DELETE' });
      setCeremony(null);
      setReceipt(null);
      toast('Wallet unlinked', 'ok');
      await load();
    } catch (e) {
      setLocalErr(e.message || String(e));
    } finally {
      setBusy('');
    }
  };

  const doTopUp = async () => {
    setBusy('topup');
    setLocalErr('');
    setReceipt(null);
    setSteps([]);
    setIntentMsg('');
    try {
      const out = await topUpWithSignature({
        amount: Number(amount),
        mode,
        onStep: (s) => {
          setSteps((prev) => (prev.includes(s) ? prev : [...prev, s]));
          if (s === 'sign') setIntentMsg((m) => m || 'signing…');
        },
      });
      setIntentMsg(out.intent.message);
      setReceipt(out);
      toast(`Credited ${inr(Number(amount))} — ledger seq ${out.receipt.ledger_seq}`, 'ok');
      await load();
    } catch (e) {
      setLocalErr(e.message || String(e));
      setSteps([]);
    } finally {
      setBusy('');
    }
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied', 'ok');
    } catch {
      /* clipboard blocked — the value is on screen anyway */
    }
  };

  return (
    <div className="wrap">
      {/* BUG-060 (review 2026-10-24): this page calls toast() for linked/credited/copied
          outcomes but never mounted the outlet — every toast silently vanished. */}
      <Toasts />
      <PageHead
        eyebrow="DRIVER · PREPAID WALLET · SIGNED AUTHORISATION"
        title="Wallet"
        lede="Connect a wallet, sign an authorisation, and the prepaid ledger is credited exactly once. No card data, no private keys, no gas — the signature is the authorisation, the ledger is the settlement."
      />

      <AuthGate error={err}>
        <PageState loading={loading} error={err && err.status !== 401 ? String(err.message || err) : ''} onRetry={load}>
          {/* ---- 01 balance + rail ---- */}
          <section className="w-grid">
            <div className="card hl w-bal">
              <div className="micro">PREPAID BALANCE · INR</div>
              <div className="w-amount num">{inr(balance)}</div>
              <div className="w-bal-foot">
                <span className="micro">{data?.ledger?.length || 0} ledger entries · append-only</span>
                <Link className="link micro" href="/invoices">
                  Invoices →
                </Link>
              </div>
              {series.length > 1 ? (
                <svg viewBox="0 0 520 90" className="w-spark" role="img" aria-label="Balance history">
                  {(() => {
                    const vals = series.map((p) => p.v);
                    const mx = Math.max(...vals, 1);
                    const mn = Math.min(...vals, 0);
                    const X = (i) => 8 + (i * 504) / Math.max(vals.length - 1, 1);
                    const Y = (v) => 78 - ((v - mn) / Math.max(mx - mn, 1)) * 64;
                    const d = vals.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
                    return (
                      <>
                        <path d={`${d} L${X(vals.length - 1)},86 L8,86 Z`} fill="var(--lime)" opacity=".09" />
                        <path d={d} fill="none" stroke="var(--lime)" strokeWidth="1.6" strokeLinejoin="round" />
                        <circle cx={X(vals.length - 1)} cy={Y(vals[vals.length - 1])} r="3" fill="var(--lime)" />
                      </>
                    );
                  })()}
                </svg>
              ) : (
                <div className="w-spark-empty micro">balance history appears after the first movement</div>
              )}
            </div>

            <div className="card w-rail">
              <div className="micro">SETTLEMENT RAIL</div>
              <dl className="w-facts">
                <div>
                  <dt>Standard</dt>
                  <dd>EIP-191 · personal_sign</dd>
                </div>
                <div>
                  <dt>Challenge</dt>
                  <dd>EIP-4361 shaped, 5-min TTL</dd>
                </div>
                <div>
                  <dt>Network</dt>
                  <dd>
                    {data?.rail?.chain_name || 'Sepolia'} · chain {data?.rail?.chain_id || '—'}
                  </dd>
                </div>
                <div>
                  <dt>Reference rate</dt>
                  <dd className="num">₹{Number(data?.rail?.inr_per_eth || 0).toLocaleString('en-IN')} / ETH</dd>
                </div>
              </dl>
              <p className="micro w-note">
                Signing authorises a credit; it moves no funds on-chain and needs no gas. The API verifies the signature
                with <code>verifyMessage</code> before a single rupee reaches the ledger.
              </p>
            </div>
          </section>

          {/* ---- 02 connect ---- */}
          <section className="sec">
            <div className="sec-h">
              <span className="secnum">01</span>
              <h2>Connect a wallet</h2>
              <p>Two signers, one verification path. Both produce a real EIP-191 signature the server checks.</p>
            </div>

            {linked ? (
              <div className="card w-linked">
                <div className="w-linked-main">
                  <span className="w-verified" aria-hidden="true">
                    ✓
                  </span>
                  <div>
                    <div className="micro">VERIFIED · {linked.verified_by}</div>
                    <div className="w-addr num">{linked.address}</div>
                    <div className="micro">
                      {linked.label} · {linked.chain_name} · linked{' '}
                      {new Date(linked.linked_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                    </div>
                  </div>
                </div>
                <div className="w-linked-actions">
                  <button className="btn sm" onClick={() => copy(linked.address)}>
                    Copy address
                  </button>
                  <button className="btn sm danger" onClick={doUnlink} disabled={busy === 'unlink'}>
                    {busy === 'unlink' ? 'Unlinking…' : 'Unlink'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="card w-connect">
                {/* ARIA radio pattern: arrow keys move between options, roving tabIndex
                    keeps one tab stop (Tab-only used to skip the unselected option). */}
                <div
                  className="w-modes"
                  role="radiogroup"
                  aria-label="Signer"
                  onKeyDown={(e) => {
                    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
                    e.preventDefault();
                    const opts = ['injected', 'demo'];
                    const i = opts.indexOf(mode);
                    const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
                    setMode(opts[(i + (fwd ? 1 : opts.length - 1)) % opts.length]);
                  }}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={mode === 'injected'}
                    className="w-mode"
                    data-on={mode === 'injected'}
                    tabIndex={mode === 'injected' ? 0 : -1}
                    onClick={() => setMode('injected')}
                    disabled={!hasInjected()}
                  >
                    <span className="w-mode-t">Browser wallet</span>
                    <span className="micro">
                      {hasInjected() ? 'MetaMask or any EIP-1193 provider' : 'not detected in this browser'}
                    </span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={mode === 'demo'}
                    className="w-mode"
                    data-on={mode === 'demo'}
                    tabIndex={mode === 'demo' ? 0 : -1}
                    onClick={() => setMode('demo')}
                  >
                    <span className="w-mode-t">VoltHub demo wallet</span>
                    <span className="micro">
                      {demoAddr ? `ready · ${shortAddr(demoAddr)}` : 'generated in this tab, dies with it'}
                    </span>
                  </button>
                </div>

                <ol className="w-steps">
                  <li data-on={busy === 'link' || !!ceremony}>
                    <b>1</b> Request a single-use challenge bound to your address
                  </li>
                  <li data-on={!!ceremony}>
                    <b>2</b> Sign it with your key — the text names the address, chain and nonce
                  </li>
                  <li data-on={!!ceremony}>
                    <b>3</b> API recovers the signer and stores the public address
                  </li>
                </ol>

                <div className="w-connect-actions">
                  {mode === 'demo' && !demoAddr ? (
                    <button className="btn" onClick={doCreateDemo}>
                      Generate demo wallet
                    </button>
                  ) : null}
                  <button className="btn pri" onClick={doLink} disabled={busy === 'link'}>
                    {busy === 'link' ? 'Waiting for signature…' : 'Link wallet'}
                  </button>
                  <span className="micro">
                    {mode === 'demo'
                      ? 'A real secp256k1 key, held in sessionStorage for this tab only.'
                      : 'Your key stays in the extension; only the signature reaches VoltHub.'}
                  </span>
                </div>
              </div>
            )}

            {/* The proof is the point of the ceremony, so it stays on screen after the link
                succeeds — the linked card above replaces the form, not the evidence. */}
            {ceremony ? (
              <div className="w-proof">
                <div className="micro">SIGNED CHALLENGE · VERIFIED SERVER-SIDE</div>
                <pre className="w-mono">{ceremony.message}</pre>
                <div className="w-proof-foot">
                  <span className="micro">
                    signature <code className="num">{ceremony.signature.slice(0, 26)}…</code>
                  </span>
                  <button className="btn sm" onClick={() => copy(ceremony.signature)}>
                    Copy signature
                  </button>
                </div>
              </div>
            ) : null}

            {localErr ? (
              <p className="err" role="alert" style={{ marginTop: 'var(--sp-3)' }}>
                {localErr}
              </p>
            ) : null}
          </section>

          {/* ---- 03 top-up ---- */}
          <section className="sec">
            <div className="sec-h">
              <span className="secnum">02</span>
              <h2>Top up by signature</h2>
              <p>
                The amount lives inside the signed text — a ₹500 signature cannot settle ₹5,000, and the same intent
                cannot credit twice.
              </p>
            </div>
            <div className="w-grid">
              <div className="card">
                <div className="micro">AMOUNT</div>
                <div className="w-chips">
                  {AMOUNTS.map((a) => (
                    <button
                      key={a}
                      className="w-chip"
                      data-on={Number(amount) === a}
                      onClick={() => setAmount(a)}
                      aria-pressed={Number(amount) === a}
                    >
                      ₹{a.toLocaleString('en-IN')}
                    </button>
                  ))}
                </div>
                <label className="f" style={{ marginTop: 'var(--sp-3)' }}>
                  Custom (₹1 – ₹10,000)
                  <input type="number" min="1" max="10000" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </label>
                <button
                  className="btn pri"
                  style={{ marginTop: 'var(--sp-3)' }}
                  onClick={doTopUp}
                  disabled={!linked || busy === 'topup'}
                >
                  {busy === 'topup' ? 'Authorising…' : `Authorise ${inr(Number(amount) || 0)}`}
                </button>
                {!linked ? <p className="micro">Link a wallet first — the intent is addressed to it.</p> : null}

                <ol className="w-track" aria-live="polite">
                  {['intent', 'sign', 'verify', 'done'].map((s) => (
                    <li key={s} data-on={steps.includes(s)}>
                      <i aria-hidden="true">{steps.includes(s) ? '✓' : ''}</i>
                      {STEP_LABEL[s]}
                    </li>
                  ))}
                </ol>
              </div>

              <div className="card">
                <div className="micro">AUTHORISATION TEXT</div>
                {intentMsg ? (
                  <pre className="w-mono">{intentMsg}</pre>
                ) : (
                  <p className="micro w-hint">
                    Pick an amount and press authorise. The exact text your wallet signs appears here before the ledger
                    moves — nothing hidden, nothing summarised.
                  </p>
                )}
                {receipt ? (
                  <div className="w-receipt">
                    <div className="micro">RECEIPT · CREDITED ONCE</div>
                    <div className="w-receipt-amt num">{inr(receipt.receipt.amount_inr)}</div>
                    <dl className="w-facts tight">
                      <div>
                        <dt>Reference</dt>
                        <dd className="num">{receipt.receipt.reference}</dd>
                      </div>
                      <div>
                        <dt>Ledger seq</dt>
                        <dd className="num">{receipt.receipt.ledger_seq}</dd>
                      </div>
                      <div>
                        <dt>ETH equivalent</dt>
                        <dd className="num">{receipt.receipt.amount_eth} ETH</dd>
                      </div>
                      <div>
                        <dt>Balance after</dt>
                        <dd className="num">{inr(receipt.receipt.balance_after)}</dd>
                      </div>
                    </dl>
                    <div className="w-receipt-foot">
                      <Pill s="PAID" />
                      <span className="micro">{receipt.receipt.mode}</span>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          {/* ---- 04 ledger ---- */}
          <section className="sec">
            <div className="sec-h">
              <span className="secnum">03</span>
              <h2>Ledger</h2>
              <p>Append-only. Every row names what moved the balance and which intent authorised it.</p>
            </div>
            {data?.ledger?.length ? (
              <div className="tscroll">
                <table className="t">
                  <caption className="micro" style={{ textAlign: 'left', paddingBottom: 8 }}>
                    Wallet ledger
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Seq</th>
                      <th scope="col">Kind</th>
                      <th scope="col" style={{ textAlign: 'right' }}>
                        Amount
                      </th>
                      <th scope="col" style={{ textAlign: 'right' }}>
                        Balance
                      </th>
                      <th scope="col">Provenance</th>
                      <th scope="col">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.ledger.map((l) => (
                      <tr key={l.seq_no}>
                        <td className="n num">{String(l.seq_no).padStart(3, '0')}</td>
                        <td>
                          <Pill s={l.kind} />
                        </td>
                        <td className="n num" style={{ color: l.amount < 0 ? 'var(--tx)' : 'var(--ok)' }}>
                          {l.amount < 0 ? '−' : '+'}
                          {inr(Math.abs(l.amount))}
                        </td>
                        <td className="n num">{inr(l.balance_after)}</td>
                        <td className="w-prov">{l.note || '—'}</td>
                        <td className="micro">
                          {new Date(l.created_at).toLocaleString('en-IN', {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="card">
                <p className="micro">No movements yet — authorise a top-up above and the first row lands here.</p>
              </div>
            )}
          </section>

          {data?.intents?.length ? (
            <section className="sec">
              <div className="sec-h">
                <span className="secnum">04</span>
                <h2>Authorisations</h2>
                <p>Each intent is single-use. Settled ones carry the reference that matches their ledger row.</p>
              </div>
              <div className="w-intents">
                {data.intents.map((i) => (
                  <div key={i.intent_id} className="card w-intent" data-status={i.status}>
                    <div className="micro">{i.intent_id}</div>
                    <div className="num w-intent-amt">{inr(i.amount_inr)}</div>
                    <div className="micro">
                      {i.amount_eth} ETH · {i.status}
                    </div>
                    {i.reference ? <div className="micro num w-ref">{i.reference}</div> : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </PageState>
      </AuthGate>
    </div>
  );
}
