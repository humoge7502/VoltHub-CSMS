'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

// Two experiences, one language (§31 of the masterplan): driver surfaces first,
// operator surfaces grouped behind a labelled cluster.
const DRIVER = [
  ['/', 'Home'],
  ['/discover', 'Discover'],
  ['/reservations', 'Reservations'],
  ['/history', 'History'],
  ['/invoices', 'Wallet'],
  ['/notifications', 'Alerts'],
];
const OPERATOR = [
  ['/dashboard', 'Dashboard'],
  ['/telemetry', 'Telemetry'],
  ['/analytics', 'Analytics'],
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

  // Route change closes the drawer; Escape does too (WCAG 2.1.2).
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
        aria-expanded={open}
        aria-controls="mobile-drawer"
        onClick={() => setOpen((v) => !v)}
      >
        MENU {open ? '×' : '+'}
      </button>
      {open && (
        <nav id="mobile-drawer" className="drawer" aria-label="Primary">
          <span className="micro group">Driver</span>
          {DRIVER.map(([href, label]) => (
            <NavLink key={href} href={href} label={label} path={path} />
          ))}
          <span className="micro group">Operator</span>
          {OPERATOR.map(([href, label]) => (
            <NavLink key={href} href={href} label={label} path={path} />
          ))}
          <span className="end">
            <Link href="/login">Log in</Link>
            <Link href="/profile">Profile</Link>
          </span>
        </nav>
      )}
    </>
  );
}
