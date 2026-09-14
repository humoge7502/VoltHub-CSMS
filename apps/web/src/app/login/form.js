'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api, setToken } from '../../lib/ui';

const SIDE = {
  login: {
    micro: 'OPERATORS · DRIVERS · AUDITORS',
    h: 'The console where certainty is visible.',
    points: [
      ['201 + 409', 'Two terminals, one connector — the race ends in the database, not the support queue.'],
      ['5 s ticks', 'MeterValues you can watch arrive, not a dashboard that pretends.'],
      ['66 paths', 'A versioned OpenAPI contract, drift-gated in CI on every push.'],
    ],
  },
  register: {
    micro: 'NEW DRIVER ACCOUNT',
    h: 'A wallet, a bay, no card data.',
    points: [
      ['Prepaid', 'The wallet holds the money; card data never touches the system.'],
      ['Reserve', 'A window on a connector, held by a row lock — overlap is impossible.'],
      ['Itemized', 'Time-of-use bands and the session fee, line by line, every invoice.'],
    ],
  },
};

export function LoginForm({ mode }) {
  const [f, setF] = useState({ email: '', password: '', full_name: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e) => {
    e.preventDefault();
    setErr('');
    if (mode === 'register' && !f.full_name.trim()) {
      setErr('Add your name — it appears on invoices and reviews.');
      return;
    }
    setBusy(true);
    try {
      const j =
        mode === 'login'
          ? await api('/auth/login', { method: 'POST', body: JSON.stringify(f) })
          : await api('/auth/register', { method: 'POST', body: JSON.stringify(f) });
      setToken(j.accessToken);
      window.location = '/discover';
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  };
  const side = SIDE[mode];
  return (
    <div className="wrap auth-split">
      <section>
        <div className="micro">{side.micro}</div>
        <h1 className="display" style={{ fontSize: 'clamp(1.8rem, 4vw, 3.2rem)', margin: 'var(--sp-3) 0 var(--sp-5)' }}>
          {side.h}
        </h1>
        <div className="idx">
          {side.points.map(([n, d]) => (
            <div key={n} style={{ cursor: 'default', padding: 'var(--sp-3) var(--sp-2)' }}>
              <span className="secnum" style={{ minWidth: 76 }}>
                {n}
              </span>
              <span
                className="d"
                style={{ display: 'block', maxWidth: '52ch', color: 'var(--tx2)', fontSize: 13, lineHeight: 1.6 }}
              >
                {d}
              </span>
            </div>
          ))}
        </div>
      </section>
      <section className="card hl" style={{ padding: 'var(--sp-5)', position: 'sticky', top: 80 }}>
        <h2>{mode === 'login' ? 'Sign in' : 'Create account'}</h2>
        <form onSubmit={go} className="sheet" style={{ marginTop: 'var(--sp-4)' }} noValidate>
          {mode === 'register' && (
            <label className="f">
              Full name
              <input
                value={f.full_name}
                onChange={(e) => setF({ ...f, full_name: e.target.value })}
                autoComplete="name"
                required
              />
            </label>
          )}
          <label className="f">
            Email
            <input
              type="email"
              autoComplete="email"
              value={f.email}
              onChange={(e) => setF({ ...f, email: e.target.value })}
              required
            />
          </label>
          <label className="f">
            Password
            <input
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={f.password}
              onChange={(e) => setF({ ...f, password: e.target.value })}
              required
              minLength={8}
            />
          </label>
          {err && (
            <p className="err" role="alert">
              {err}
            </p>
          )}
          <button className="btn pri" type="submit" disabled={busy}>
            {busy ? 'Working…' : mode === 'login' ? 'Log in' : 'Create account · ₹500 credit'}
          </button>
          <span className="micro">
            {mode === 'login' ? (
              <>
                new here?{' '}
                <Link className="link" href="/signup">
                  create account
                </Link>
              </>
            ) : (
              <>
                have an account?{' '}
                <Link className="link" href="/login">
                  log in
                </Link>
              </>
            )}
          </span>
          {mode === 'login' && (
            <span className="micro" style={{ borderTop: '1px solid var(--hair)', paddingTop: 'var(--sp-3)' }}>
              demo — <span className="num">admin@volthub.in / Admin@123</span> ·{' '}
              <span className="num">arjun@volthub.in / Operator@123</span> · any seeded driver /{' '}
              <span className="num">Driver@123</span>
            </span>
          )}
        </form>
      </section>
    </div>
  );
}
