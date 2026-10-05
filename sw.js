/* SetFrameR service worker — network-first, cache as offline fallback.
   Bump CACHE when the shell changes. vendor/ (three.js) is cached on first use. */
const CACHE = 'setframer-v17';
const ASSETS = ['./', './index.html', './output.html', './casa-estilo.css', './styles.css', './app.js', './viewer.js',
  './vmixset.js', './project.js', './demo.js', './lenses.json', './manifest.webmanifest', './icon.svg', './report.js',
  './vendor/three/build/three.module.js', './vendor/three/build/three.core.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) return;
  // cache: 'no-cache' = always ask the server (ETag → a quick 304 when unchanged). GitHub Pages lets
  // browsers keep files 10 min without asking, which mixed old and new modules after a deploy.
  e.respondWith(fetch(request, { cache: 'no-cache' }).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
    return res;
  }).catch(() => caches.match(request)));
});
