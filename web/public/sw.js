// Offline support: after the first visit the app shell and instrument files are served from
// cache when the network is unavailable. Network first, so updates arrive when online.
const CACHE = 'beginners-v1';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './index.html', './instruments/index.json'])).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then((r) => r || caches.match('./index.html'))),
  );
});
// The page sends the URLs it loaded before this worker took control, so the first visit is
// enough to work offline afterwards.
self.addEventListener('message', (e) => {
  const urls = (e.data && e.data.cache) || [];
  const same = urls.filter((u) => { try { return new URL(u).origin === self.location.origin; } catch { return false; } });
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(same.map((u) => c.add(u).catch(() => {})))));
});
