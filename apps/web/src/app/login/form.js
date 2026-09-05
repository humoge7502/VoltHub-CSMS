'use client';
import { useState } from 'react';
import { api, setToken } from '../../lib/ui';

export function LoginForm({ mode }) {
  const [f, setF] = useState({ email: '', password: '', full_name: '' });
  const [err, setErr] = useState('');
  const go = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      const j =
        mode === 'login'
          ? await api('/auth/login', { method: 'POST', body: JSON.stringify(f) })
          : await api('/auth/register', { method: 'POST', body: JSON.stringify(f) });
      setToken(j.accessToken);
      window.location = '/discover';
    } catch (ex) {
      setErr(ex.message);
    }
  };
  return (
    <div className="wrap" style={{ maxWidth: 560 }}>
      <h1 className="display" style={{ fontSize: '2.4rem' }}>
        {mode === 'login' ? 'Welcome back' : 'Join VoltHub'}
      </h1>
      <form onSubmit={go} className="sheet" style={{ marginTop: 20 }}>
        {mode === 'register' && (
          <label className="f">
            Full name
            <input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
          </label>
        )}
        <label className="f">
          Email
          <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </label>
        <label className="f">
          Password
          <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </label>
        {err && <div className="err">{err}</div>}
        <button className="btn pri" type="submit">
          {mode === 'login' ? 'Log in' : 'Create account · ₹500 credit'}
        </button>
        <a className="micro" href={mode === 'login' ? '/signup' : '/login'}>
          {mode === 'login' ? 'new here? create account' : 'have an account? log in'}
        </a>
      </form>
    </div>
  );
}
