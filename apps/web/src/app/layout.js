import './globals.css';
import Link from 'next/link';
import { Inter, Space_Grotesk, IBM_Plex_Mono } from 'next/font/google';
import { Nav } from './nav';
import { SessionLinks } from './session-links';

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
  title: {
    default: 'VoltHub CSMS — certainty is a database property',
    template: '%s — VoltHub CSMS',
  },
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
  twitter: {
    card: 'summary',
    title: 'VoltHub CSMS',
    description: 'Oracle money-path + TimescaleDB telemetry + OCPP 1.6J — race-tested in CI',
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
          <div className="topbar-in">
            <Link href="/" className="brand" aria-label="VoltHub CSMS home">
              VOLT<b>HUB</b>
            </Link>
            <Nav />
            <SessionLinks className="end" />
          </div>
        </header>
        <main id="main">{children}</main>
        <footer className="sitefooter">
          <div className="sitefooter-in micro">
            <span>
              VOLT<b>HUB</b> CSMS
            </span>
            <span>ORACLE OLTP + TIMESCALEDB TELEMETRY</span>
            <span>
              SIMULATED CHARGERS · PREPAID WALLET (NO CARD DATA, EVER) · <Link href="/login">demo logins</Link>
            </span>
            <span>
              BENCHMARKS: MEASURED ONLY — <code className="num">docs/perf.md</code>
            </span>
            <span className="grow">
              <a href="https://github.com/humoge7502/VoltHub-CSMS">source</a> ·{' '}
              <a href="https://humoge7502.github.io/VoltHub-CSMS/">docs site</a>
            </span>
            <span>MIT</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
