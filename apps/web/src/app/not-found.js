export default function NotFound() {
  return (
    <div className="wrap">
      <div className="micro">404 · NO SUCH BAY</div>
      <h1 className="display" style={{ fontSize: '3rem' }}>Unplugged.</h1>
      <p style={{ color: 'var(--tx2)' }}>This route has no connector. <a href="/discover">Back to Discover</a>.</p>
    </div>
  );
}
