import Link from 'next/link';

export const metadata = {
  title: 'Offline',
  robots: { index: false, follow: false },
};

export default function Offline() {
  return (
    <div className="wrap" style={{ padding: 'var(--sp-6) 0', maxWidth: 620 }}>
      <div className="eyebrow">NETWORK UNAVAILABLE</div>
      <h1 style={{ marginTop: 'var(--sp-2)' }}>You’re offline.</h1>
      <p style={{ color: 'var(--tx2)', marginTop: 'var(--sp-3)', lineHeight: 1.6 }}>
        VoltHub needs a live connection to show connector state, wallet balances or start a session. Nothing you did was
        lost — reconnect and try again.
      </p>
      <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-4)', flexWrap: 'wrap' }}>
        <Link href="/" className="btn pri">
          Try again
        </Link>
        <Link href="/discover" className="btn">
          Discover chargers
        </Link>
      </div>
    </div>
  );
}
