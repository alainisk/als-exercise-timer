const CACHE_NAME = 'als-timer-v19';
const ASSETS = ['./cloud-config.js?v=20260913-12', './account-sync.js?v=20260913-12', './account-media.js?v=20260913-12', './sync-merge.js?v=20260913-12', './video-sources.js?v=20260913-12', './stopwatch-32.png', './stopwatch-180.png', './stopwatch-192.png', './stopwatch-512.png', './index.html', './styles.css', './redesign.css?v=20260913-12', './app.js?v=20260913-12', './manifest.json?v=20260913-12'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith('als-timer-') && k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Keep API calls, third-party requests and streamed video out of the app cache.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || e.request.headers.has('range')) return;
  if (!ASSETS.some(asset => new URL(asset, self.registration.scope).pathname === url.pathname) && url.pathname !== new URL(self.registration.scope).pathname) return;
  e.respondWith(
    fetch(e.request).then(resp => {
      if (resp.ok) {
        const clone = resp.clone();
        e.waitUntil(caches.open(CACHE_NAME).then(c => c.put(e.request, clone)));
      }
      return resp;
    }).catch(async () => (await caches.match(e.request)) || (e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error()))
  );
});
