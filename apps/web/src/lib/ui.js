'use client';
// Minimal API client: token in localStorage, shared INR/kWh formatters.
export const API = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:4000/api/v1';
export const getToken = () => (typeof window === 'undefined' ? null : localStorage.getItem('vh_token'));
export const setToken = (t) => localStorage.setItem('vh_token', t);
export const logout = () => localStorage.removeItem('vh_token');

export async function api(path, opts = {}) {
  const { headers, ...rest } = opts;
  const r = await fetch(`${API}${path}`, {
    ...rest,
    headers: { 'content-type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}), ...(headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error?.message || `HTTP ${r.status}`); e.code = j.error?.code; e.status = r.status; throw e; }
  return j;
}
export const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
export const kwh = (n) => `${Number(n || 0).toFixed(2)} kWh`;
export function Pill({ s }) { return <span className={`pill p-${s}`}> <i />{s}</span>; }
// PageState (§9.5-1): one loading/error-with-retry/empty-with-action pattern for all pages.
export function PageState({ loading, error, empty, onRetry, retryLabel = 'Retry', children }) {
  if (loading) return <div className="skel" style={{ height: 120 }} aria-busy="true" aria-label="Loading" />;
  if (error) return (
    <div className="card" role="alert">
      <div className="micro">REQUEST FAILED</div>
      <p className="err">{String(error)}</p>
      {onRetry && <button className="btn" onClick={onRetry}>{retryLabel}</button>}
    </div>
  );
  if (empty) return <p style={{ color: 'var(--tx2)' }}>{empty}</p>;
  return children;
}
// Toasts (§9.5-2): API error codes are toast-ready (409 OVERLAP, 402 funds, 201 wins).
let _push = null;
export const toast = (msg, kind = 'info') => { try { _push?.({ msg, kind, id: Date.now() + Math.random() }); } catch {} };
export function Toasts() {
  const { useState, useEffect } = require('react');
  const [items, setItems] = useState([]);
  useEffect(() => {
    _push = (t) => {
      setItems((xs) => [...xs.slice(-3), t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 4200);
    };
    return () => { _push = null; };
  }, []);
  if (!items.length) return null;
  return (
    <div aria-live="polite" style={{ position: 'fixed', bottom: 16, right: 16, display: 'grid', gap: 8, zIndex: 50 }}>
      {items.map((t) => (
        <div key={t.id} className="card" style={{ borderColor: t.kind === 'err' ? 'var(--bad)' : 'var(--hair2)', maxWidth: 320 }}>
          <span className={t.kind === 'err' ? 'err' : 'okmsg'}>{t.msg}</span>
        </div>
      ))}
    </div>
  );
}
// AuthGate: client-side guard — unauthenticated /staff renders a login CTA, not silent 403s.
export function AuthGate({ error, children }) {
  const code = error?.code ?? error?.status;
  if (code === 401 || code === 'NO_TOKEN' || code === 'BAD_TOKEN' || /login/i.test(String(error?.message || ''))) {
    return (
      <div className="card" role="alert">
        <div className="micro">LOGIN REQUIRED</div>
        <p style={{ color: 'var(--tx2)' }}>This view needs a signed-in account.</p>
        <a href="/login"><button className="btn pri">Go to login</button></a>
      </div>
    );
  }
  return children;
}
export function Kpi({ l, v, sub }) {
  return <div className="card kpi"><div className="micro">{l}</div><div className="v num">{v}</div>{sub ? <div className="micro">{sub}</div> : null}</div>;
}
// Inline SVG line chart (no chart dep; IST axis labels).
export function Line({ pts, h = 160, stroke = '#C6F24E' }) {
  if (!pts?.length) return <div className="skel" style={{ height: h }} />;
  const W = 560, H = h, P = 24;
  const ys = pts.map(p => p.avg_kw ?? p.power_kw ?? 0);
  const mx = Math.max(...ys, 1);
  const X = (i) => P + (i * (W - 2 * P)) / Math.max(pts.length - 1, 1);
  const Y = (v) => H - P - (v / mx) * (H - 2 * P);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: h }}>
      {[0.25, 0.5, 0.75].map(f => <line key={f} x1={P} x2={W - P} y1={H * f} y2={H * f} stroke="rgba(255,255,255,.08)" />)}
      <path d={`${d} L${X(pts.length - 1).toFixed(1)},${H - P} L${P},${H - P} Z`} fill={stroke} opacity=".1" />
      <path d={d} fill="none" stroke={stroke} strokeWidth="2" />
      <text x={P} y={14} fill="#9AA3AD" fontSize="10">peak {Math.max(...ys).toFixed(1)} kW · IST</text>
    </svg>
  );
}
// 7x24 utilization heatmap (carbon -> cream -> lime scale).
export function Heatmap({ grid }) {
  if (!grid) return <div className="skel" style={{ height: 180 }} />;
  const mx = Math.max(1, ...grid.flat());
  const col = (v) => v === 0 ? '#171C23' : v / mx < .5 ? '#FFFDD0' : '#C6F24E';
  return (
    <svg viewBox="0 0 520 160" style={{ width: '100%' }}>
      {grid.map((row, d) => row.map((v, h) => (
        <rect key={`${d}-${h}`} x={40 + h * 19} y={10 + d * 20} width="17" height="17" rx="2"
          fill={col(v)} opacity={v ? .35 + .65 * (v / mx) : 1}><title>{`d${d} h${h}: ${v}`}</title></rect>
      )))}
      <text x="0" y="24" fill="#5C6670" fontSize="9">Su</text><text x="0" y="144" fill="#5C6670" fontSize="9">Sa</text>
    </svg>
  );
}
// Schematic Chennai corridor map (no tile key; positions projected from lat/lng).
export function CorridorMap({ stations, selected, onPick }) {
  const lats = stations.map(s => s.latitude), lngs = stations.map(s => s.longitude);
  const lo = [Math.min(...lats, 12.8), Math.min(...lngs, 79.9)], hi = [Math.max(...lats, 13.1), Math.max(...lngs, 80.3)];
  const X = (lng) => 30 + ((lng - lo[1]) / Math.max(hi[1] - lo[1], .01)) * 500;
  const Y = (lat) => 200 - ((lat - lo[0]) / Math.max(hi[0] - lo[0], .01)) * 170;
  const dot = (s) => s.available_count > 0 ? '#3ECF8E' : '#E5484D';
  return (
    <svg viewBox="0 0 560 220" style={{ width: '100%', background: '#11151A', border: '1px solid rgba(255,255,255,.08)', borderRadius: 8 }} role="img" aria-label="Chennai station corridor map">
      <path d="M40,180 L200,120 L360,90 L520,40" stroke="#5C6670" strokeDasharray="6 6" fill="none" />
      <text x="44" y="196" fill="#5C6670" fontSize="10">OMR CORRIDOR · CHENNAI</text>
      {stations.map(s => (
        <g key={s.station_id} className="pin" onClick={() => onPick?.(s)} style={{ cursor: 'pointer' }}>
          <circle cx={X(s.longitude)} cy={Y(s.latitude)} r={selected === s.station_id ? 12 : 9} fill={dot(s)} opacity=".9"
            stroke={selected === s.station_id ? '#FFFDD0' : 'none'} strokeWidth="2" />
          <text x={X(s.longitude) + 14} y={Y(s.latitude) + 4} fill="#E8EAED" fontSize="11">{s.name}</text>
          <text x={X(s.longitude) + 14} y={Y(s.latitude) + 18} fill="#9AA3AD" fontSize="10" className="num">{s.available_count}/{s.connector_count} free</text>
        </g>
      ))}
    </svg>
  );
}
