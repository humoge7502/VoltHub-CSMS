// PWA manifest. Next.js serves this at /manifest.webmanifest and links it from
// every page automatically. Icons are generated from app/icon.svg by
// scripts/gen-pwa-icons.py so the installed app matches the browser tab.
export default function manifest() {
  return {
    name: 'VoltHub CSMS — EV charging management',
    short_name: 'VoltHub',
    description:
      'Two-engine EV charging management — prepaid wallet, live OCPP sessions, carbon receipts and operator controls.',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['window-controls-overlay', 'standalone', 'minimal-ui'],
    orientation: 'portrait-primary',
    background_color: '#0B0E11',
    theme_color: '#0B0E11',
    lang: 'en-IN',
    dir: 'ltr',
    categories: ['utilities', 'productivity', 'travel'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Discover chargers', short_name: 'Discover', url: '/discover' },
      { name: 'My sessions', short_name: 'History', url: '/history' },
      { name: 'Operator dashboard', short_name: 'Dashboard', url: '/dashboard' },
      { name: 'Carbon intensity', short_name: 'Carbon', url: '/carbon' },
    ],
  };
}
