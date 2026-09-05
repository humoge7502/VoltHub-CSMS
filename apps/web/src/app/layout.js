import './globals.css';

export const metadata = { title: 'VoltHub CSMS', description: 'Two-engine EV charging management — Oracle OLTP + TimescaleDB telemetry' };
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <span className="brand">VOLT<b>HUB</b></span>
          <nav className="nav">
            <a href="/discover">Discover</a><a href="/reservations">Reservations</a>
            <a href="/history">History</a><a href="/invoices">Wallet</a>
            <a href="/notifications">Alerts</a>
            <a href="/dashboard">Operator</a><a href="/telemetry">Telemetry</a><a href="/admin">Admin</a>
          </nav>
          <span style={{ marginLeft: 'auto' }} className="micro"><a href="/login">login</a> · <a href="/profile">profile</a></span>
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
