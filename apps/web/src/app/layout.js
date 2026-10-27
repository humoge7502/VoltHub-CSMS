import './globals.css';
import Link from 'next/link';
import { IBM_Plex_Sans, Bricolage_Grotesque, IBM_Plex_Mono } from 'next/font/google';
import { Nav } from './nav';
import { SessionLinks } from './session-links';
import { PwaRegister } from '../components/pwa-register';
import { CommandPalette } from './cmdk';

// Self-hosted fonts (next/font): removes the render-blocking fonts.googleapis.com
// round-trip and lets CSP drop the Google font origins entirely.
// Body: IBM Plex Sans — pairs with the mono numerals, corporate but not generic.
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
  display: 'swap',
});
// Display: Bricolage Grotesque — a display face with personality at large sizes.
const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-display', display: 'swap' });
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
  applicationName: 'VoltHub CSMS',
  formatDetection: { telephone: false, email: false, address: false },
  appleWebApp: { capable: true, title: 'VoltHub', statusBarStyle: 'black-translucent' },
  icons: { apple: '/icons/apple-touch-icon.png' },
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

export const viewport = {
  themeColor: '#0B0E11',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  // The console is installed as a PWA and used on phones at the charger. Without cover
  // the whole app is letterboxed away from the notch; with it the safe-area insets in
  // globals.css (.wrap, .topbar) are what keep content out of the camera bar and the
  // home indicator.
  viewportFit: 'cover',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${plexMono.variable}`}>
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
        <PwaRegister />
        <CommandPalette />
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
