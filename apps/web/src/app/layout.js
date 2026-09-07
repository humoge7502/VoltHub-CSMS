import './globals.css';
import Link from 'next/link';
import { Nav } from './nav';

export const metadata = {
  title: 'VoltHub CSMS',
  description: 'Two-engine EV charging management — Oracle OLTP + TimescaleDB telemetry',
  openGraph: {
    title: 'VoltHub CSMS',
    description: 'Oracle money-path + TimescaleDB telemetry + OCPP 1.6J — race-tested in CI',
    type: 'website',
  },
};
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <span className="brand">
            VOLT<b>HUB</b>
          </span>
          <Nav />
          <span style={{ marginLeft: 'auto' }} className="micro">
            <Link href="/login">login</Link> · <Link href="/profile">profile</Link>
          </span>
        </header>
        <main>{children}</main>
        <footer style={{ borderTop: '1px solid var(--hair)', marginTop: 48, padding: '20px 24px' }} className="micro">
          VOLTHUB CSMS · ORACLE OLTP + TIMESCALEDB TELEMETRY · SIMULATED CHARGERS, PREPAID WALLET (NO CARD DATA) ·
          BENCHMARKS: SEE docs/perf.md (MEASURED ONLY) · OPENAPI AT /api/v1/docs
        </footer>
      </body>
    </html>
  );
}
