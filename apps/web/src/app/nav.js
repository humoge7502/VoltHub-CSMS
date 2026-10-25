'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Command } from 'lucide-react';
import { SessionLinks } from './session-links';

// Two experiences, one language (§31 of the masterplan): driver surfaces first,
// operator surfaces grouped behind a labelled cluster.
const DRIVER = [
  ['/', 'Home'],
  ['/discover', 'Discover'],
  ['/reservations', 'Reservations'],
  ['/history', 'History'],
  ['/wallet', 'Wallet'],
  ['/invoices', 'Invoices'],
];
const OPERATOR = [
  ['/dashboard', 'Dashboard'],
  ['/telemetry', 'Telemetry'],
  ['/analytics', 'Analytics'],
  ['/carbon', 'Carbon'],
  ['/faults', 'Faults'],
  ['/admin', 'Admin'],
];

function isActive(path, href) {
  if (href === '/') return path === '/';
  return path === href || path.startsWith(`${href}/`);
}

function NavLink({ href, label, path }) {
  const on = isActive(path, href);
  return (
    <Link href={href} className={on ? 'on' : undefined} aria-current={on ? 'page' : undefined}>
      {label}
    </Link>
  );
}

export function Nav() {
  const path = usePathname() || '/';
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const drawerRef = useRef(null);
  const wasOpen = useRef(false);

  // Route change closes the drawer; Escape does too (WCAG 2.1.2).
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Focus moves into the drawer when it opens and returns to the trigger when it
  // closes, so keyboard users are never dropped at the top of the document.
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      const t = setTimeout(() => drawerRef.current?.querySelector('a, button')?.focus(), 0);
      return () => clearTimeout(t);
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      btnRef.current?.focus();
    }
  }, [open]);

  return (
    <>
      <nav className="nav" aria-label="Driver">
        {DRIVER.map(([href, label]) => (
          <NavLink key={href} href={href} label={label} path={path} />
        ))}
      </nav>
      <nav className="nav" aria-label="Operator" style={{ borderLeft: '1px solid var(--hair)', paddingLeft: 16 }}>
        {OPERATOR.map(([href, label]) => (
          <NavLink key={href} href={href} label={label} path={path} />
        ))}
      </nav>
      <button
        type="button"
        className="menu-btn"
        aria-label="Open command palette (Ctrl+K)"
        title="Command palette — Ctrl/Cmd+K"
        onClick={() => window.dispatchEvent(new Event('vh:cmdk'))}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <Command size={13} aria-hidden="true" />K
      </button>
      <button
        ref={btnRef}
        type="button"
        className="menu-btn"
        aria-expanded={open}
        aria-controls="mobile-drawer"
        aria-label={open ? 'Close navigation' : 'Open navigation'}
        onClick={() => setOpen((v) => !v)}
      >
        MENU {open ? '×' : '+'}
      </button>
      {open && (
        <nav id="mobile-drawer" ref={drawerRef} className="drawer" aria-label="Primary">
          <span className="micro group">Driver</span>
          {DRIVER.map(([href, label]) => (
            <NavLink key={href} href={href} label={label} path={path} />
          ))}
          <span className="micro group">Operator</span>
          {OPERATOR.map(([href, label]) => (
            <NavLink key={href} href={href} label={label} path={path} />
          ))}
          <SessionLinks className="end" />
        </nav>
      )}
    </>
  );
}
