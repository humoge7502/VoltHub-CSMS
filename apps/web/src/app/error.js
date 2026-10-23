'use client';
// Route-level error boundary: an uncaught render error used to white-screen the
// console with Next's default crash page (there were zero error.js files). This
// keeps the shell, names the failure, and offers a reset — same voice as PageState.
export default function Error({ error, reset }) {
  return (
    <div className="wrap" style={{ paddingTop: 'var(--sp-8)' }}>
      <div className="card" role="alert" style={{ maxWidth: 560 }}>
        <div className="micro">RENDER FAILED</div>
        <p className="err">{String(error?.message || 'Unexpected render error')}</p>
        <button className="btn" onClick={reset} style={{ marginTop: 'var(--sp-2)' }}>
          Try again
        </button>
      </div>
    </div>
  );
}
