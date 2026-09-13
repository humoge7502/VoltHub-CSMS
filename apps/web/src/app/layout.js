import './globals.css';
import Link from 'next/link';
import { Inter, Space_Grotesk, IBM_Plex_Mono } from 'next/font/google';
import { Nav } from './nav';

// Self-hosted fonts (next/font): removes the render-blocking fonts.googleapis.com
// round-trip and lets CSP drop the Google font origins entirely.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const grotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '700'],
  variable: '--font-grotesk',
  display: 'swap',
});
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
});

const SITE = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

export const metadata = {
  metadataBase: new URL(SITE),
  title: 'VoltHub CSMS',
  description:
    'Two-engine EV charging management — Oracle 23ai money path, TimescaleDB telemetry, OCPP 1.6J gateway — race-tested in CI.',
  alternates: { canonical: '/' },
  robots: { index: true, follow: true },
  openGraph: {
    title: 'VoltHub CSMS',
    description: 'Oracle money-path + TimescaleDB telemetry + OCPP 1.6J — race-tested in CI',
    type: 'website',
    url: '/',
    siteName: 'VoltHub CSMS',
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${inter.variable} ${grotesk.variable} ${plexMono.variable}`}>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <header className="topbar">
          <Link href="/" className="brand" aria-label="VoltHub CSMS home">
            VOLT<b>HUB</b>
          </Link>
          <Nav />
          <span style={{ marginLeft: 'auto' }} className="micro">
            <Link href="/login">login</Link> · <Link href="/profile">profile</Link>
          </span>
        </header>
        <main id="main">{children}</main>
        <footer style={{ borderTop: '1px solid var(--hair)', marginTop: 48, padding: '20px 24px' }} className="micro">
          VOLTHUB CSMS · ORACLE OLTP + TIMESCALEDB TELEMETRY · SIMULATED CHARGERS, PREPAID WALLET (NO CARD DATA) ·
          BENCHMARKS: SEE docs/perf.md (MEASURED ONLY) · OPENAPI AT /api/v1/docs
        </footer>
      </body>
    </html>
  );
}
