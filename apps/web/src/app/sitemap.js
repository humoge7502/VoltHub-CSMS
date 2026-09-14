// Static marketing/ops surfaces. Dynamic detail routes (/session/[id],
// /stations/[id]) are auth-scoped operational views and intentionally excluded.
const PATHS = [
  '',
  '/discover',
  '/reservations',
  '/history',
  '/invoices',
  '/notifications',
  '/dashboard',
  '/telemetry',
  '/analytics',
  '/admin',
  '/login',
  '/signup',
  '/profile',
];

export default function sitemap() {
  const SITE = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
  const lastModified = new Date();
  return PATHS.map((p) => ({
    url: `${SITE}${p || '/'}`,
    lastModified,
    changeFrequency: p === '' ? 'weekly' : 'monthly',
    priority: p === '' ? 1 : p === '/discover' ? 0.9 : 0.5,
  }));
}
