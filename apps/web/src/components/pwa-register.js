'use client';
import { useEffect } from 'react';

// Registers the service worker only in a production build: the Next dev server
// rewrites chunks on every save, and a cache in front of HMR produces phantom
// bugs. Installability is a production property.
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') return;
    const onLoad = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // A failed registration is not an app failure: the site still works
        // online, and we do not want a toast for a background capability.
      });
    };
    if (document.readyState === 'complete') onLoad();
    else window.addEventListener('load', onLoad, { once: true });
    return () => window.removeEventListener('load', onLoad);
  }, []);
  return null;
}
