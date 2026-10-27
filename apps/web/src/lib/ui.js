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

// The access token lives 15 minutes and the refresh token is an httpOnly cookie the
// server ROTATES on every use — presenting one twice is treated as theft and revokes
// the whole family (SEC-012), signing out every tab on the device. A dashboard fans out
// five requests, so at expiry instant they all 401 at once: without single-flighting,
// the second POST /auth/refresh replays the cookie the first one already burned and the
// user is logged out by their own polling. One refresh in flight; everyone awaits it.
let refreshing = null;
async function refreshAccessToken() {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const r = await fetch(`${API}/auth/refresh`, { method: 'POST', credentials: 'include' });
        if (!r.ok) {
          localStorage.removeItem('vh_token');
          return null;
        }
        const j = await r.json().catch(() => ({}));
        if (!j.accessToken) return null;
        setToken(j.accessToken);
        return j.accessToken;
      } catch {
        return null;
      }
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

// retry=false stops the 401→refresh→retry chain from recursing. Re-sending a mutating
// call after a 401 is safe: the auth middleware rejects before the route handler runs,
// so a 401 request never had a side effect to duplicate.
export async function api(path, opts = {}) {
  const { headers, retry = true, ...rest } = opts;
  const r = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...(headers || {}),
    },
  });
  if (r.status === 401 && retry && (await refreshAccessToken())) return api(path, { ...opts, retry: false });
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
// The console is India-first but viewed from anywhere: chart/table time labels render in
// a FIXED zone (Asia/Kolkata) so the "IST" suffix tells the truth for every visitor.
// (Pre-fix: toLocaleTimeString rendered the BROWSER's zone with "IST" hardcoded after it.)
export const IST = 'Asia/Kolkata';
export const fmtClock = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: IST })
    : '—';

// useCountUp: RAF-driven number tween for polled hero values (emil/animate: motion
// must earn its place — a big number that snaps every 5 s reads as broken; one that
// glides reads as alive). Respects prefers-reduced-motion by snapping.
export function useCountUp(target, { duration = 650 } = {}) {
  const [v, setV] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const to = Number(target) || 0;
    const from = Number(fromRef.current) || 0;
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    fromRef.current = to;
    if (reduce || !Number.isFinite(to) || Math.abs(to - from) < 0.005) {
      setV(to);
      return;
    }
    const t0 = performance.now();
    let raf;
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic (never ease-in on enter)
      setV(from + (to - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return v;
}

// usePoll: the console's one polling loop. Pages used to hand-roll
// `const t = setInterval(f, N)` — five copies, each missing a different hazard:
// a slow API answered AFTER the next tick went out (a laptop on a train stacks
// requests without bound), a backgrounded tab still hitting the gateway every
// 10 s (battery, and a real load multiplier on a public demo), and a response
// landing after unmount. Ticks are serialised (one in flight, always), paused
// while the document is hidden with an immediate catch-up on reveal, and every
// request gets an AbortSignal that is cancelled on unmount or when `enabled`
// flips. State is reported as the stale-data contract the pages already wanted:
// 'error' only until there is data on screen, 'stale' for every failure after it.
//
// `scope` names WHAT the poll is about (a station id, a session id) and `reset`
// hands the page its chance to drop the payload that belongs to the previous one.
// Without them a repick left the old interval running on the new closure, so the
// screen showed station B's label over station A's KPIs for up to a full interval
// — and if the new station then errored, `hadData` was already true, so the wrong
// numbers were dressed up as "last good data" and could sit there indefinitely.
export function usePoll(fn, { intervalMs = 10000, enabled = true, scope = null, reset } = {}) {
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const fnRef = useRef(fn);
  const resetRef = useRef(reset);
  const tickRef = useRef(null);
  useEffect(() => {
    fnRef.current = fn;
    resetRef.current = reset;
  });
  const scopeKey = JSON.stringify(scope === undefined ? null : scope);
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    // Anything on screen right now describes the PREVIOUS scope. Clear it before the
    // first tick so no render can pair a new label with the old entity's numbers.
    if (resetRef.current) resetRef.current();
    setStatus('loading');
    setError('');
    let dead = false;
    let hadData = false;
    let inFlight = null;
    let timer = null;
    let ctrl = null;
    const tick = async () => {
      if (inFlight) return; // backpressure: never overlap the same request
      ctrl = new AbortController();
      inFlight = (async () => {
        try {
          await fnRef.current({ signal: ctrl.signal });
          if (dead) return;
          hadData = true;
          setStatus('ok');
          setError('');
        } catch (e) {
          // An unmount/tab-switch abort is not an outage — do not show stale or error.
          if (dead || ctrl.signal.aborted) return;
          setStatus(hadData ? 'stale' : 'error');
          setError(e.message || String(e));
        } finally {
          inFlight = null;
        }
        if (!dead && !document.hidden) timer = setTimeout(tick, intervalMs);
      })();
    };
    const reveal = () => {
      if (document.hidden) {
        clearTimeout(timer);
        timer = null;
        return;
      }
      if (!timer) tick(); // catch up immediately instead of waiting out the interval
    };
    document.addEventListener('visibilitychange', reveal);
    tickRef.current = tick;
    tick();
    return () => {
      dead = true;
      tickRef.current = null;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', reveal);
      if (inFlight) ctrl.abort();
    };
  }, [intervalMs, enabled, scopeKey]);
  return { status, error, refresh: () => tickRef.current && tickRef.current() };
}

// StaleChip: a poll failed but the last good payload is still on screen. Honest about
// freshness instead of wiping the charts (pre-fix: any transient blip replaced the
// whole dashboard with an error card).
export function StaleChip({ label = 'reconnecting — showing last good data' }) {
  return (
    <span className="stale-chip" role="status">
      <i />
      {label}
    </span>
  );
}

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

// `as` keeps the heading level correct wherever it lands: a card list under the page h1
// needs h2, a panel inside a Section (h2) needs h3. Hardcoding one level made every
// consumer skip a level, which screen-reader heading navigation reports as a broken outline.
export function EmptyState({ title, body, action, as: Tag = 'h3' }) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: 'var(--sp-7) var(--sp-5)' }}>
      <Tag>{title}</Tag>
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
  if (empty) return <EmptyState as="h2" title="Nothing here yet" body={empty} />;
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
  // The live region is mounted ALWAYS. With the old `if (!items.length) return null`,
  // the region and its first message appeared in the same commit, and assistive tech
  // does not announce content inserted into a node it has never seen — so the first
  // toast of every page visit (usually the error the user most needs to hear) was
  // silent. An empty fixed grid has no box and cannot be seen or tabbed into.
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
// `busy` is the in-flight guard for mutations: while it is true the dialog cannot be
// dismissed (Esc, backdrop or Cancel) and both actions are inert, so a double click
// cannot fire two `PATCH`es and a slow answer cannot be lost behind a closed dialog.
export function ConfirmDialog({
  open,
  eyebrow = 'CONFIRM',
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  busyLabel = 'Working…',
  danger = false,
  busy = false,
  children, // extra fields (e.g. prompt input) rendered above the actions
  onConfirm,
  onCancel,
}) {
  const ref = useRef(null);
  const cancel = () => {
    if (!busy) onCancel?.();
  };
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
        cancel();
      }}
      onClick={(e) => {
        if (e.target === ref.current) cancel(); // backdrop
      }}
    >
      <div className="micro dlg-h">{eyebrow}</div>
      <h2 style={{ fontSize: '1.25rem' }}>{title}</h2>
      {body ? <p style={{ color: 'var(--tx2)', margin: 'var(--sp-2) 0 0' }}>{body}</p> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) onConfirm?.();
        }}
      >
        {children}
        <div className="dlg-actions">
          <button type="button" className="btn" onClick={cancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="submit"
            className={danger ? 'btn danger' : 'btn pri'}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy ? busyLabel : confirmLabel}
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
// Reads as a chart, not a block: a y-axis with real values, hour labels on the x-axis,
// a gradient area under the line, and a marked last point. A constant series still
// looks like a line at the top of its band instead of a solid rectangle.
// WCAG 1.1.1: a chart is a picture of a series, and a picture is not a substitute for
// the numbers. The table is real DOM behind a `<details>` — collapsed, so it costs the
// visual layout nothing, but available to a screen reader, to find-in-page, and to
// anyone who wants to copy the series out.
export function ChartTable({ summary = 'Data table', head, rows, note }) {
  return (
    <details className="datatbl">
      <summary className="micro">{summary}</summary>
      <div className="tscroll">
        <table className="t">
          <caption className="sr-only">{summary}</caption>
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) =>
                  j === 0 ? (
                    <th key={j} scope="row" className="num">
                      {c}
                    </th>
                  ) : (
                    <td key={j} className="num">
                      {c}
                    </td>
                  )
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note ? (
        <p className="micro" style={{ marginTop: 6 }}>
          {note}
        </p>
      ) : null}
    </details>
  );
}

export function Line({ pts, h = 160, stroke = '#C6F24E', id = 'lg', unit = 'kW', live = false }) {
  if (!pts?.length) return <div className="skel" style={{ height: h }} />;
  const W = 960,
    H = h,
    PL = 38,
    PR = 14,
    PT = 26,
    PB = 22;
  const ys = pts.map((p) => p.avg_kw ?? p.power_kw ?? 0);
  const rawMax = Math.max(...ys, 1);
  // round the ceiling to a friendly number so the axis does not read 33.3
  const step = rawMax > 200 ? 100 : rawMax > 50 ? 20 : rawMax > 20 ? 10 : 5;
  const mx = Math.ceil(rawMax / step) * step;
  const X = (i) => PL + (i * (W - PL - PR)) / Math.max(pts.length - 1, 1);
  const Y = (v) => H - PB - (v / mx) * (H - PT - PB);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(' ');
  const lastX = X(pts.length - 1).toFixed(1),
    lastY = Y(ys[ys.length - 1]).toFixed(1);
  const gid = `grad-${id}`;
  const ticks = [0, 0.5, 1].map((f) => ({ v: mx * f, y: Y(mx * f) }));
  const label = (p) => fmtClock(p.bucket || p.ts);
  // ≤ 24 rows, always including the peak: a 5-minute load curve is 288 points, and a
  // 288-row table is not an accessibility aid. The sampled series plus the peak is.
  const stride = Math.max(1, Math.ceil(pts.length / 24));
  const peakIdx = ys.indexOf(rawMax);
  const keep = new Set([0, pts.length - 1, peakIdx]);
  for (let i = 0; i < pts.length; i += stride) keep.add(i);
  const tableRows = [...keep].sort((a, b) => a - b).map((i) => [label(pts[i]), ys[i].toFixed(1)]);
  return (
    <>
      {/* height:auto keeps the chart at its natural aspect ratio instead of letter-boxing a
          560-wide drawing inside a 1200-wide card — which shrank the axis labels to ~9px and
          left the plot floating in the middle of the panel. */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
        aria-label={`Load curve, ${pts.length} points, peak ${rawMax.toFixed(1)} ${unit}`}
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity=".16" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t.v}>
            <line x1={PL} x2={W - PR} y1={t.y} y2={t.y} stroke="rgba(255,255,255,.07)" />
            <text x={PL - 6} y={t.y + 3} fill="#8A94A0" fontSize="9" textAnchor="end">
              {Math.round(t.v)}
            </text>
          </g>
        ))}
        <path d={`${d} L${lastX},${H - PB} L${PL},${H - PB} Z`} fill={`url(#${gid})`} />
        <path
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth="1.8"
          strokeLinejoin="round"
          strokeLinecap="round"
          className="chart-line"
          pathLength="1"
        />
        <line x1={lastX} x2={lastX} y1={lastY} y2={H - PB} stroke={stroke} strokeOpacity=".35" strokeDasharray="2 3" />
        {live && <circle className="chart-pulse" cx={lastX} cy={lastY} r="3" fill={stroke} />}
        <circle cx={lastX} cy={lastY} r="3" fill={stroke} />
        <text x={PL} y={H - 6} fill="#8A94A0" fontSize="9">
          {label(pts[0])}
        </text>
        <text x={W - PR} y={H - 6} fill="#8A94A0" fontSize="9" textAnchor="end">
          {label(pts[pts.length - 1])} IST
        </text>
        <text x={W - PR} y={11} fill="#A7B0BA" fontSize="9.5" textAnchor="end">
          peak {rawMax.toFixed(1)} {unit}
        </text>
      </svg>
      <ChartTable
        summary={`Load curve as a table (${pts.length} ${unit} points)`}
        head={['Time (IST)', unit]}
        rows={tableRows}
        note={`Sampled every ${stride} point${stride > 1 ? 's' : ''}, plus the peak and both ends — the chart is drawn from all ${pts.length}.`}
      />
    </>
  );
}

// 7x24 utilization heatmap (near-black -> moss -> lime scale).
// Cell value = average bays in use in that hour (from Timescale), so the diagonal
// rhythm of a real corridor is visible instead of a uniform wash.
// HEAT_RAMP is exported so legends elsewhere (telemetry) render the SAME scale —
// the legend used to be a hand-copied array that drifted from this one.
export const HEAT_RAMP = ['#151A20', '#23301C', '#3F5A23', '#79A62F', '#C6F24E'];
export function Heatmap({ grid, unit = 'bays busy' }) {
  if (!grid) return <div className="skel" style={{ height: 180 }} />;
  const flat = grid.flat().filter((v) => v > 0);
  const mx = Math.max(1e-9, ...flat);
  // Normalise across the *observed* range, not 0..max: a corridor that runs 0.4–2.5 bays
  // busy collapsed into the darkest stop when zero was the floor, so the matrix read as
  // an empty grid with one bright cell. Gamma 0.6 lifts the quiet hours into view.
  const mn = Math.min(mx, ...flat);
  const RAMP = HEAT_RAMP;
  const col = (v) => {
    if (!v) return RAMP[0];
    const r = Math.min(1, Math.max(0, (v - mn) / Math.max(mx - mn, 1e-9))) ** 0.6;
    const i = Math.min(RAMP.length - 2, Math.floor(r * (RAMP.length - 1)));
    const t = r * (RAMP.length - 1) - i;
    const hex = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
    const a = hex(RAMP[i]),
      b = hex(RAMP[i + 1]);
    return `rgb(${a.map((x, k) => Math.round(x + (b[k] - x) * t)).join(',')})`;
  };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // Where the peak is, not just how big it is — the root label used to quote the number
  // alone, so the one fact a heatmap exists to convey was only reachable by hovering.
  let peak = { d: 0, h: 0, v: 0 };
  grid.forEach((row, d) =>
    row.forEach((v, h) => {
      if (v > peak.v) peak = { d, h, v };
    })
  );
  return (
    <>
      <svg
        viewBox="0 0 560 190"
        style={{ width: '100%' }}
        // role="img" makes the whole subtree presentational, which is why every per-cell
        // <title> below was invisible to assistive tech. A group keeps the summary label
        // and exposes each cell (graphics-symbol) to AT, while hover tooltips still work.
        role="group"
        aria-label={`Utilization heatmap, 7 days by hour, ${unit}. ${
          flat.length
            ? `Peak ${peak.v} ${unit} at ${String(peak.h).padStart(2, '0')}:00 on ${DAYS[peak.d]}.`
            : 'No utilization recorded this week.'
        }`}
      >
        {grid.map((row, d) =>
          row.map((v, h) => (
            <rect
              key={`${d}-${h}`}
              x={44 + h * 20}
              y={12 + d * 22}
              width="18"
              height="19"
              rx="2"
              fill={col(v)}
              role="graphics-symbol"
              aria-label={`${DAYS[d]} ${String(h).padStart(2, '0')}:00 — ${v} ${unit}`}
            >
              <title>{`${DAYS[d]} ${String(h).padStart(2, '0')}:00 — ${v} ${unit}`}</title>
            </rect>
          ))
        )}
        {DAYS.map((t, i) => (
          <text key={t} x="0" y={12 + i * 22 + 13} fill="#6B7681" fontSize="9">
            {t}
          </text>
        ))}
        {[0, 6, 12, 18, 23].map((h) => (
          <text key={h} x={44 + h * 20} y={186} fill="#6B7681" fontSize="9">
            {String(h).padStart(2, '0')}
          </text>
        ))}
        <text x={44 + 24 * 20} y={186} fill="#8A94A0" fontSize="9" textAnchor="end">
          peak {mx.toFixed(1)} {unit}
        </text>
      </svg>
      <ChartTable
        summary="Utilization as a table (per day)"
        head={['Day', 'Busiest hour', 'Peak', 'Avg across 24 h']}
        rows={grid.map((row, d) => {
          const peakH = row.indexOf(Math.max(...row));
          const avg = row.reduce((a, v) => a + v, 0) / Math.max(row.length, 1);
          return [DAYS[d], `${String(peakH).padStart(2, '0')}:00`, `${row[peakH]} ${unit}`, avg.toFixed(2)];
        })}
        note="Every cell of the 7×24 grid is individually labelled in the chart; this is the per-day reading of the same numbers."
      />
    </>
  );
}

// Schematic Chennai corridor map (no tile key; positions projected from lat/lng).
// Numbered pins + a legend, because station names printed next to pins collided at
// corridor density (two names on one line is worse than no name at all).
export function CorridorMap({ stations, selected, onPick }) {
  const lats = stations.map((s) => s.latitude),
    lngs = stations.map((s) => s.longitude);
  const lo = [Math.min(...lats, 12.8), Math.min(...lngs, 79.9)],
    hi = [Math.max(...lats, 13.1), Math.max(...lngs, 80.3)];
  const X = (lng) => 60 + ((lng - lo[1]) / Math.max(hi[1] - lo[1], 0.01)) * 430;
  const Y = (lat) => 178 - ((lat - lo[0]) / Math.max(hi[0] - lo[0], 0.01)) * 130;
  const dot = (s) => (s.available_count > 0 ? '#3ECF8E' : '#E5484D');
  return (
    <svg
      viewBox="0 0 560 236"
      style={{ width: '100%', background: '#11151A', border: '1px solid rgba(255,255,255,.08)', borderRadius: 8 }}
      // NOT role="img": that makes the subtree presentational, which hid every pin below
      // from assistive tech while they stayed in the TAB ORDER — keyboard users landed on
      // controls a screen reader said did not exist. A labelled group exposes both.
      role="group"
      aria-label="Chennai station corridor map — numbered pins, legend below"
    >
      <path d="M40,190 L200,120 L360,90 L520,40" stroke="#5C6670" strokeDasharray="6 6" fill="none" />
      <text x="44" y="206" fill="#6B7681" fontSize="10">
        OMR CORRIDOR · CHENNAI
      </text>
      {stations.map((s, i) => {
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
            {on ? <circle cx={cx} cy={cy} r="18" fill={dot(s)} opacity=".18" /> : null}
            <circle cx={cx} cy={cy} r="12" fill={dot(s)} stroke={on ? '#FFFDD0' : '#0B0E11'} strokeWidth="2" />
            <text
              x={cx}
              y={cy + 4}
              fill="#0B0E11"
              fontSize="11"
              fontWeight="700"
              textAnchor="middle"
              style={{ pointerEvents: 'none' }}
            >
              {i + 1}
            </text>
          </g>
        );
      })}
      {stations.map((s, i) => {
        const col = i % 2,
          row = Math.floor(i / 2);
        return (
          <g key={`lg-${s.station_id}`} opacity={selected === s.station_id ? 1 : 0.72}>
            <text x={44 + col * 258} y={26 + row * 15} fill="#A7B0BA" fontSize="10">
              <tspan fill="#6B7681">{i + 1}</tspan> {s.name.length > 24 ? `${s.name.slice(0, 23)}…` : s.name}
              <tspan fill={s.available_count ? '#3ECF8E' : '#E5484D'} dx="6">
                {s.available_count}/{s.connector_count}
              </tspan>
            </text>
          </g>
        );
      })}
    </svg>
  );
}
