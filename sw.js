/* J.Law Notepad Service Worker — offline-first (cache-first + background refresh) */
const VERSION = 'v2.0.0';
const CACHE = 'jl-notepad-' + VERSION;
const ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './css/style.css', './js/config.js', './js/app.js',
  './vendor/html2canvas.min.js', './vendor/jspdf.umd.min.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(ASSETS.map((u) => c.add(u).catch(() => {})))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('jl-notepad-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // Supabase / 其他網域：直連網路，不快取

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const refresh = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    });
    if (cached) { refresh.catch(() => {}); return cached; }   // 先回快取（離線秒開），背景更新
    try { return await refresh; }
    catch (_) {
      if (req.mode === 'navigate') return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      return Response.error();
    }
  })());
});
