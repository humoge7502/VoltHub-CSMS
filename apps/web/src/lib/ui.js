'use client';
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
// Minimal API client: 15-min access token in localStorage; the 30-day refresh
// rides an httpOnly cookie (SEC-012) — XSS can only steal a 15-min window, and
// POST /auth/logout revokes the whole refresh family server-side.
export const API = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:4000/api/v1';
export const getToken = () => (typeof window === 'undefined' ? null : localStorage.getItem('vh_token'));
export const setToken = (t) => localStorage.setItem('vh_token', t);
export async function logout() {
  // Best-effort server revocation (family-wide) + local token drop.
  try {
    await fetch(`${API}/auth/logout`, { method: 'POST', credentials: 'include' });
  } catch {
    /* offline: local drop still applies */
  }
  localStorage.removeItem('vh_token');
}

export async function api(path, opts = {}) {
  const { headers, ...rest } = opts;
  const r = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...(headers || {}),
    },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error?.message || `HTTP ${r.status}`);
    e.code = j.error?.code;
    e.status = r.status;
    throw e;
  }
  return j;
}
export const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
export const kwh = (n) => `${Number(n || 0).toFixed(2)} kWh`;

/* ---------------- primitives ---------------- */

export function Pill({ s }) {
  return (
    <span className={`pill p-${s}`}>
      <i />
      {s}
    </span>
  );
}

export function PageHead({ eyebrow, title, lede }) {
  return (
    <header className="rise" style={{ marginBottom: 'var(--sp-5)' }}>
      {eyebrow ? <div className="micro">{eyebrow}</div> : null}
      <h1 style={{ marginTop: eyebrow ? 'var(--sp-2)' : 0 }}>{title}</h1>
      {lede ? (
        <p className="lede" style={{ marginTop: 'var(--sp-3)' }}>
          {lede}
        </p>
      ) : null}
    </header>
  );
}

// Editorial section: number, ruled top edge, optional aside on the rule line.
export function Section({ n, title, aside, children, className = '', style }) {
  return (
    <section className={`sec ${className}`} style={style}>
      <div className="sec-h">
        {n ? <span className="secnum">{n}</span> : null}
        <h2>{title}</h2>
        {aside ? <p>{aside}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function Statband({ items }) {
  return (
    <div className="statband">
      {items.map((it) => (
        <div key={it.l}>
          <div className="micro">{it.l}</div>
          <div className="v num">{it.v}</div>
          {it.sub ? (
            <div className="micro" style={{ marginTop: 'var(--sp-1)' }}>
              {it.sub}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function Kpi({ l, v, sub }) {
  return (
    <div className="card kpi">
      <div className="micro">{l}</div>
      <div className="v num">{v}</div>
      {sub ? <div className="micro">{sub}</div> : null}
    </div>
  );
}

export function EmptyState({ title, body, action }) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: 'var(--sp-7) var(--sp-5)' }}>
      <h3>{title}</h3>
      {body ? (
        <p style={{ color: 'var(--tx2)', maxWidth: '48ch', margin: 'var(--sp-2) auto var(--sp-4)' }}>{body}</p>
      ) : null}
      {action}
    </div>
  );
}

/* ---------------- states ---------------- */

// PageState (§9.5-1): one loading/error-with-retry/empty-with-action pattern for all pages.
export function PageState({ loading, error, empty, onRetry, retryLabel = 'Retry', children }) {
  if (loading)
    return (
      <div aria-busy="true" aria-label="Loading" style={{ display: 'grid', gap: 12 }}>
        <div className="skel" style={{ height: 92 }} />
        <div className="skel" style={{ height: 180 }} />
      </div>
    );
  if (error)
    return (
      <div className="card" role="alert">
        <div className="micro">REQUEST FAILED</div>
        <p className="err">{String(error)}</p>
        {onRetry && (
          <button className="btn" onClick={onRetry} style={{ marginTop: 'var(--sp-2)' }}>
            {retryLabel}
          </button>
        )}
      </div>
    );
  if (empty) return <EmptyState title="Nothing here yet" body={empty} />;
  return children;
}

// Toasts (§9.5-2): API error codes are toast-ready (409 OVERLAP, 402 funds, 201 wins).
let _push = null;
export const toast = (msg, kind = 'info') => {
  try {
    _push?.({ msg, kind, id: Date.now() + Math.random() });
  } catch {}
};
export function Toasts() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    _push = (t) => {
      setItems((xs) => [...xs.slice(-3), t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 4200);
    };
    return () => {
      _push = null;
    };
  }, []);
  if (!items.length) return null;
  return (
    <div
      aria-live="polite"
      style={{ position: 'fixed', bottom: 16, right: 16, display: 'grid', gap: 8, zIndex: 'var(--z-toast, 80)' }}
    >
      {items.map((t) => (
        <div
          key={t.id}
          className="card toast"
          role="status"
          style={{
            borderColor: t.kind === 'err' ? 'var(--bad)' : 'var(--hair2)',
            maxWidth: 340,
            boxShadow: 'var(--sh-2)',
          }}
        >
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
      <div className="card" role="alert" style={{ textAlign: 'center', padding: 'var(--sp-6) var(--sp-4)' }}>
        <div className="micro">LOGIN REQUIRED</div>
        <p style={{ color: 'var(--tx2)' }}>This view needs a signed-in account.</p>
        <Link className="btn pri" href="/login">
          Go to login
        </Link>
      </div>
    );
  }
  return children;
}

/* ---------------- dialog (replaces window.confirm / window.prompt) ---------------- */

// Native <dialog>: focus trap + Esc for free. Backdrop click = cancel.
export function ConfirmDialog({
  open,
  eyebrow = 'CONFIRM',
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  children, // extra fields (e.g. prompt input) rendered above the actions
  onConfirm,
  onCancel,
}) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      const t = setTimeout(() => {
        const field = d.querySelector('input, select, textarea');
        if (field) field.focus();
        else d.querySelector('.btn.pri, .btn.danger')?.focus();
      }, 0);
      return () => clearTimeout(t);
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dlg"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault(); // keep Esc semantic: route it through onCancel
        onCancel?.();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onCancel?.(); // backdrop
      }}
    >
      <div className="micro dlg-h">{eyebrow}</div>
      <h2 style={{ fontSize: '1.25rem' }}>{title}</h2>
      {body ? <p style={{ color: 'var(--tx2)', margin: 'var(--sp-2) 0 0' }}>{body}</p> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm?.();
        }}
      >
        {children}
        <div className="dlg-actions">
          <button type="button" className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="submit" className={danger ? 'btn danger' : 'btn pri'}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/* ---------------- shared controls ---------------- */

export function StationPicker({ id, label = 'Station', stations, value, onChange, hint }) {
  return (
    <div style={{ display: 'grid', gap: 6, maxWidth: 360 }}>
      <label className="micro" htmlFor={id}>
        {label}
      </label>
      <select id={id} value={value || ''} onChange={(e) => onChange(Number(e.target.value))}>
        {stations.map((s) => (
          <option key={s.station_id} value={s.station_id}>
            {s.name}
          </option>
        ))}
      </select>
      {hint ? <span className="micro">{hint}</span> : null}
    </div>
  );
}

/* ---------------- charts (inline SVG — zero chart dependencies) ---------------- */

// Inline SVG line chart (no chart dep; IST axis labels). Flat fill per §21.4.
export function Line({ pts, h = 160, stroke = '#C6F24E', id = 'lg' }) {
  if (!pts?.length) return <div className="skel" style={{ height: h }} />;
  const W = 560,
    H = h,
    P = 24;
  const ys = pts.map((p) => p.avg_kw ?? p.power_kw ?? 0);
  const mx = Math.max(...ys, 1);
  const X = (i) => P + (i * (W - 2 * P)) / Math.max(pts.length - 1, 1);
  const Y = (v) => H - P - (v / mx) * (H - 2 * P);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(' ');
  const lastX = X(pts.length - 1).toFixed(1),
    lastY = Y(ys[ys.length - 1]).toFixed(1);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: h, display: 'block' }}
      role="img"
      aria-label={`Load curve, ${pts.length} points, peak ${Math.max(...ys).toFixed(1)} kW`}
    >
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={P} x2={W - P} y1={H * f} y2={H * f} stroke="rgba(255,255,255,.08)" />
      ))}
      <path d={`${d} L${lastX},${H - P} L${P},${H - P} Z`} fill={stroke} opacity=".1" />
      <path d={d} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r="3" fill={stroke} />
      <text x={P} y={14} fill="#A7B0BA" fontSize="10">
        peak {Math.max(...ys).toFixed(1)} kW · IST
      </text>
    </svg>
  );
}

// 7x24 utilization heatmap (carbon -> cream -> lime scale).
export function Heatmap({ grid }) {
  if (!grid) return <div className="skel" style={{ height: 180 }} />;
  const mx = Math.max(1, ...grid.flat());
  // three-stop scale: quiet carbon -> warm cream -> hot lime
  const col = (v) => {
    if (v === 0) return '#171C23';
    const r = v / mx;
    if (r < 0.34) return '#FFFDD0';
    if (r < 0.67) return '#E4EF9A';
    return '#C6F24E';
  };
  return (
    <svg
      viewBox="0 0 520 170"
      style={{ width: '100%' }}
      role="img"
      aria-label={`7-day by-hour utilization heatmap, peak ${mx}`}
    >
      {grid.map((row, d) =>
        row.map((v, h) => (
          <rect
            key={`${d}-${h}`}
            x={40 + h * 19}
            y={10 + d * 20}
            width="17"
            height="17"
            rx="2"
            fill={col(v)}
            opacity={v ? 0.35 + 0.65 * (v / mx) : 1}
          >
            <title>{`day ${d + 1}, ${String(h).padStart(2, '0')}:00 — ${v} sessions`}</title>
          </rect>
        ))
      )}
      {['Su', 'Sa'].map((t, i) => (
        <text key={t} x="0" y={i === 0 ? 24 : 144} fill="#6B7681" fontSize="9">
          {t}
        </text>
      ))}
      {[0, 6, 12, 18].map((h) => (
        <text key={h} x={40 + h * 19} y={166} fill="#6B7681" fontSize="9">
          {String(h).padStart(2, '0')}
        </text>
      ))}
    </svg>
  );
}

// Schematic Chennai corridor map (no tile key; positions projected from lat/lng).
// Pins are focusable buttons — selectable by keyboard, announced to screen readers.
export function CorridorMap({ stations, selected, onPick }) {
  const lats = stations.map((s) => s.latitude),
    lngs = stations.map((s) => s.longitude);
  const lo = [Math.min(...lats, 12.8), Math.min(...lngs, 79.9)],
    hi = [Math.max(...lats, 13.1), Math.max(...lngs, 80.3)];
  const X = (lng) => 30 + ((lng - lo[1]) / Math.max(hi[1] - lo[1], 0.01)) * 500;
  const Y = (lat) => 200 - ((lat - lo[0]) / Math.max(hi[0] - lo[0], 0.01)) * 170;
  const dot = (s) => (s.available_count > 0 ? '#3ECF8E' : '#E5484D');
  return (
    <svg
      viewBox="0 0 560 220"
      style={{ width: '100%', background: '#11151A', border: '1px solid rgba(255,255,255,.08)', borderRadius: 8 }}
      role="img"
      aria-label="Chennai station corridor map — each station is also listed beside the map"
    >
      <path d="M40,180 L200,120 L360,90 L520,40" stroke="#5C6670" strokeDasharray="6 6" fill="none" />
      <text x="44" y="196" fill="#6B7681" fontSize="10">
        OMR CORRIDOR · CHENNAI
      </text>
      {stations.map((s) => {
        const cx = X(s.longitude),
          cy = Y(s.latitude),
          on = selected === s.station_id;
        return (
          <g
            key={s.station_id}
            className="pin"
            role="button"
            tabIndex={0}
            aria-label={`${s.name} — ${s.available_count} of ${s.connector_count} connectors free${on ? ', selected' : ''}`}
            aria-pressed={on}
            onClick={() => onPick?.(s)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onPick?.(s);
              }
            }}
          >
            <circle
              cx={cx}
              cy={cy}
              r={on ? 12 : 9}
              fill={dot(s)}
              opacity=".9"
              stroke={on ? '#FFFDD0' : 'none'}
              strokeWidth="2"
            />
            <text x={cx + 14} y={cy + 4} fill="#E8EAED" fontSize="11">
              {s.name}
            </text>
            <text x={cx + 14} y={cy + 18} fill="#9AA3AD" fontSize="10" className="num">
              {s.available_count}/{s.connector_count} free
            </text>
          </g>
        );
      })}
    </svg>
  );
}
