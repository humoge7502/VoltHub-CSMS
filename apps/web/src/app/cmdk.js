'use client';
// Command palette (Ctrl/Cmd+K): keyboard-first navigation + actions — the premium
// console marker. Fuzzy-ish filter, arrow-key navigation, ARIA combobox semantics,
// role-aware entries (drivers get driver surfaces, staff get operator surfaces).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search,
  CornerDownLeft,
  LayoutDashboard,
  Activity,
  MapPin,
  CalendarClock,
  Receipt,
  Bell,
  Wallet,
  Shield,
  FileText,
  LogOut,
  Copy,
  History,
  Zap,
  Wrench,
} from 'lucide-react';
import { API, logout } from '../lib/ui';

function role() {
  try {
    const t = localStorage.getItem('vh_token');
    if (!t) return 'anon';
    const p = JSON.parse(atob(t.split('.')[1]));
    return p.role || 'anon';
  } catch {
    return 'anon';
  }
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const items = useMemo(() => {
    const r = role();
    const routes = [
      {
        label: 'Discover stations',
        href: '/discover',
        icon: MapPin,
        hint: 'live availability',
        roles: ['anon', 'DRIVER', 'OPERATOR', 'ADMIN'],
      },
      {
        label: 'Reservations',
        href: '/reservations',
        icon: CalendarClock,
        hint: 'your booked windows',
        roles: ['DRIVER'],
      },
      {
        label: 'Charging history',
        href: '/history',
        icon: History,
        hint: 'every session',
        roles: ['DRIVER', 'OPERATOR', 'ADMIN'],
      },
      { label: 'Wallet', href: '/wallet', icon: Wallet, hint: 'signed top-ups, ledger', roles: ['DRIVER'] },
      {
        label: 'Invoices',
        href: '/invoices',
        icon: Receipt,
        hint: 'itemized billing',
        roles: ['DRIVER', 'OPERATOR', 'ADMIN'],
      },
      {
        label: 'Notifications',
        href: '/notifications',
        icon: Bell,
        hint: 'session + invoice events',
        roles: ['DRIVER', 'OPERATOR', 'ADMIN'],
      },
      {
        label: 'Operator dashboard',
        href: '/dashboard',
        icon: LayoutDashboard,
        hint: 'health grid, 15 s refresh',
        roles: ['OPERATOR', 'ADMIN'],
      },
      {
        label: 'Telemetry',
        href: '/telemetry',
        icon: Activity,
        hint: 'load curve + heatmap',
        roles: ['OPERATOR', 'ADMIN'],
      },
      { label: 'Analytics', href: '/analytics', icon: Zap, hint: 'station rollups', roles: ['OPERATOR', 'ADMIN'] },
      { label: 'Faults', href: '/faults', icon: Wrench, hint: 'triage queue', roles: ['OPERATOR', 'ADMIN'] },
      { label: 'Admin', href: '/admin', icon: Shield, hint: 'users, stations, tariffs', roles: ['ADMIN'] },
      {
        label: 'API docs (OpenAPI)',
        href: `${API}/docs`,
        icon: FileText,
        hint: 'live spec',
        roles: ['anon', 'DRIVER', 'OPERATOR', 'ADMIN'],
        external: true,
      },
    ].filter((i) => i.roles.includes(r));
    const actions = [
      r !== 'anon'
        ? {
            label: 'Copy API base URL',
            icon: Copy,
            hint: API,
            run: () => navigator.clipboard?.writeText(API).catch(() => {}),
          }
        : null,
      r !== 'anon'
        ? {
            label: 'Sign out',
            icon: LogOut,
            hint: 'revoke refresh family',
            run: async () => {
              await logout();
              router.push('/login');
            },
          }
        : null,
    ].filter(Boolean);
    return [...routes, ...actions];
  }, [router]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items
      .map((i) => {
        const l = i.label.toLowerCase();
        const score = l.startsWith(s) ? 0 : l.includes(s) ? 1 : (i.hint || '').toLowerCase().includes(s) ? 2 : 9;
        return { ...i, score };
      })
      .filter((i) => i.score < 9)
      .sort((a, b) => a.score - b.score);
  }, [items, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
    else setQ('');
  }, [open]);

  const onKey = useCallback(
    (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (!open) return;
      if (e.key === 'Escape') setOpen(false);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSel((s) => Math.min(s + 1, filtered.length - 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((s) => Math.max(s - 1, 0));
      }
      if (e.key === 'Enter') {
        const it = filtered[sel];
        if (!it) return;
        setOpen(false);
        if (it.run) it.run();
        else if (it.external) window.open(it.href, '_blank', 'noopener');
        else router.push(it.href);
      }
    },
    [open, filtered, sel, router]
  );
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    const openEv = () => setOpen(true);
    window.addEventListener('vh:cmdk', openEv);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('vh:cmdk', openEv);
    };
  }, [onKey]);

  useEffect(() => {
    listRef.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;
  return (
    <div
      className="cmdk-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cmdk-head">
          <Search size={15} aria-hidden="true" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Jump to… (stations, telemetry, wallet, actions)"
            aria-label="Search commands"
            autoComplete="off"
            spellCheck="false"
          />
          <kbd className="cmdk-kbd">esc</kbd>
        </div>
        <div className="cmdk-list" ref={listRef} role="listbox" aria-label="Commands">
          {filtered.length ? (
            filtered.map((it, i) => {
              const Icon = it.icon;
              return (
                <div
                  key={it.label}
                  role="option"
                  aria-selected={i === sel}
                  data-sel={i === sel}
                  className="cmdk-item"
                  onMouseEnter={() => setSel(i)}
                  onClick={() => {
                    setOpen(false);
                    if (it.run) it.run();
                    else if (it.external) window.open(it.href, '_blank', 'noopener');
                    else router.push(it.href);
                  }}
                >
                  <Icon size={15} aria-hidden="true" />
                  <span className="cmdk-label">{it.label}</span>
                  <span className="cmdk-hint">{it.hint}</span>
                  {i === sel && <CornerDownLeft size={13} aria-hidden="true" style={{ marginLeft: 'auto' }} />}
                </div>
              );
            })
          ) : (
            <div className="cmdk-item" style={{ cursor: 'default' }}>
              <span className="cmdk-hint">no matches — try “wallet”, “faults”, “telemetry”</span>
            </div>
          )}
        </div>
        <div className="cmdk-foot micro">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>{role() === 'anon' ? 'sign in for wallet + operator surfaces' : 'role-aware'}</span>
        </div>
      </div>
    </div>
  );
}
