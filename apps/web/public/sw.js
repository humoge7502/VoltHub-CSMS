/* VoltHub service worker.
 *
 * Deliberately small: this app is a live operations surface, not an offline-first
 * reader. Caching the HTML shell or API responses would show a driver a stale
 * connector state or an old wallet balance — worse than an honest offline page.
 *
 * Strategy:
 *   navigation  network-first, cache the last good page, fall back to /offline
 *   static      stale-while-revalidate for hashed Next assets, icons and fonts
 *   API/WS      never intercepted
 */
const CACHE = 'volthub-shell-v1';
const SHELL = ['/offline', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isStatic = (pathname) =>
  pathname.startsWith('/_next/static/') ||
  pathname.startsWith('/icons/') ||
  /\.(?:css|js|mjs|svg|png|jpg|jpeg|webp|avif|ico|woff2?|ttf)$/i.test(pathname);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin API/WS
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ocpp')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(req)) || (await caches.match('/offline')))
    );
    return;
  }

  if (isStatic(url.pathname)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(req, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});
