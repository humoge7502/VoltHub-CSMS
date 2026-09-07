'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  ['/', 'Home'],
  ['/discover', 'Discover'],
  ['/reservations', 'Reservations'],
  ['/history', 'History'],
  ['/invoices', 'Wallet'],
  ['/notifications', 'Alerts'],
  ['/dashboard', 'Operator'],
  ['/telemetry', 'Telemetry'],
  ['/admin', 'Admin'],
];

export function Nav() {
  const path = usePathname() || '/';
  return (
    <nav className="nav">
      {NAV.map(([href, label]) => (
        <Link key={href} href={href} className={path === href ? 'on' : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
