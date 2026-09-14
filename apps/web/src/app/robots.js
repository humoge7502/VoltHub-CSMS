// Default: crawl everything. The API (port 4000) is a different origin and sets
// its own headers; this only governs the console origin.
export default function robots() {
  const SITE = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
  return {
    rules: [{ userAgent: '*', allow: '/' }],
    sitemap: `${SITE}/sitemap.xml`,
  };
}
