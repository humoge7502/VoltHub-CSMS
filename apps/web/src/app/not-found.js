import Link from 'next/link';

export const metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <div className="wrap">
      <div className="micro">404 · NO SUCH BAY</div>
      <h1 className="display" style={{ fontSize: 'clamp(2.4rem, 7vw, 4.5rem)', margin: 'var(--sp-3) 0' }}>
        Unplugged.
      </h1>
      <p className="lede">This route has no connector. It may have been moved, or the address is wrong.</p>
      <div style={{ display: 'flex', gap: 8, marginTop: 'var(--sp-4)' }}>
        <Link href="/discover" className="btn pri">
          Find a charger
        </Link>
        <Link href="/" className="btn">
          Back home
        </Link>
      </div>
    </div>
  );
}
