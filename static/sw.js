/* ====================================================================
   XAUUSD Pro Order Flow & Bookmap - Service Worker (PWA Engine) v35.0
   Cache-Busting & Immediate Update Engine
   ==================================================================== */

const CACHE_NAME = 'gringgo-orderflow-v35.0';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          console.log('[SW v35.0] Deleting obsolete cache:', key);
          return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Pass through WebSockets, streaming APIs and POST mutations directly
  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/ws') ||
    url.pathname.includes('/stream')
  ) {
    return;
  }

  // 2. Strict Network-First for HTML and JavaScript files
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});
