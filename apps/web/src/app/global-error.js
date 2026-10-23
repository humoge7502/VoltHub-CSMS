'use client';
// Global error boundary (layout itself crashed). globals.css cannot be assumed to
// have loaded here, so the fallback styles are inline and self-sufficient.
export default function GlobalError({ error, reset }) {
  return (
    <html lang="en">
      <body
        style={{
          background: '#0b0e11',
          color: '#e8eaed',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          padding: 48,
          margin: 0,
        }}
      >
        <div
          role="alert"
          style={{
            maxWidth: 560,
            margin: '0 auto',
            border: '1px solid rgba(255,255,255,.16)',
            borderRadius: 8,
            padding: 24,
          }}
        >
          <p style={{ fontSize: 11, letterSpacing: '.08em', color: '#a7b0ba', margin: '0 0 8px' }}>GLOBAL ERROR</p>
          <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>The console hit an unrecoverable render error.</h1>
          <p style={{ color: '#a7b0ba', margin: 0 }}>{String(error?.message || 'Unknown error')}</p>
          <button
            onClick={reset}
            style={{
              marginTop: 16,
              padding: '8px 14px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,.16)',
              background: 'transparent',
              color: '#e8eaed',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
