/** @type {import('next').NextConfig} */
// SEC-009: CSP at the Next layer (API adds its own JSON-only CSP).
// Next.js (App Router) ships its RSC flight payload + hydration bootstrap as inline
// <script> tags, and `next dev` further needs 'unsafe-eval' for fast refresh — so a
// `default-src 'self'`-only policy blocks the app's own JS and breaks hydration in
// BOTH dev and prod (verified 2026-09-05: login form dead under the strict policy).
// Script allowances are therefore environment-aware: 'unsafe-inline' for Next's own
// inline scripts (prod), plus 'unsafe-eval' in dev only. Everything else stays strict.
module.exports = {
  reactStrictMode: true,
  env: { NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:4000/api/v1' },
  async headers() {
    const isProd = process.env.NODE_ENV === 'production';
    const scriptSrc = ["'self'", "'unsafe-inline'", ...(isProd ? [] : ["'unsafe-eval'"])];
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
          {
            key: 'Content-Security-Policy',
            value: [
              `default-src 'self'`,
              `script-src ${scriptSrc.join(' ')}`,
              "connect-src 'self' http://localhost:4000 https://api.volthub.example",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data:",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};
