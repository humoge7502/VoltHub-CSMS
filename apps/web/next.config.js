/** @type {import('next').NextConfig} */
// SEC-009: CSP at the Next layer (API adds its own JSON-only CSP).
// Next.js (App Router) ships its RSC flight payload + hydration bootstrap as inline
// <script> tags, and `next dev` further needs 'unsafe-eval' for fast refresh — so a
// `default-src 'self'`-only policy blocks the app's own JS and breaks hydration in
// BOTH dev and prod (verified 2026-09-05: login form dead under the strict policy).
// Script allowances are therefore environment-aware: 'unsafe-inline' for Next's own
// inline scripts (prod), plus 'unsafe-eval' in dev only. Everything else stays strict.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:4000/api/v1';
// The browser bundle may point at a different origin (tunnel, Caddy, api.example.com).
// CSP must allow that exact origin or the console loads but every fetch is blocked —
// the public-demo tunnel is the first deployment mode where the API is not localhost.
let apiOrigin = null;
try {
  apiOrigin = new URL(API_BASE).origin;
} catch {
  // Relative API base (e.g. /api/v1 behind a same-origin proxy) needs no extra origin.
}
const connectSrc = [
  ...new Set(["'self'", 'http://localhost:4000', 'https://api.volthub.example', apiOrigin].filter(Boolean)),
];

module.exports = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The dev overlay badge is a screenshot artefact in docs/video captures.
  devIndicators: false,
  env: { NEXT_PUBLIC_API_BASE: API_BASE },
  async headers() {
    const isProd = process.env.NODE_ENV === 'production';
    const scriptSrc = ["'self'", "'unsafe-inline'", ...(isProd ? [] : ["'unsafe-eval'"])];
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
          {
            key: 'Content-Security-Policy',
            value: [
              `default-src 'self'`,
              `script-src ${scriptSrc.join(' ')}`,
              `connect-src ${connectSrc.join(' ')}`,
              "style-src 'self' 'unsafe-inline'",
              "font-src 'self'",
              "img-src 'self' data:",
              "manifest-src 'self'",
              "worker-src 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
              "frame-src 'none'",
            ].join('; '),
          },
        ],
      },
      {
        // The service worker must revalidate on every navigation, or a shipped
        // security fix sits behind a stale cache. Icons are not fingerprinted, so
        // they get a bounded day rather than immutable.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        source: '/icons/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' }],
      },
    ];
  },
};
