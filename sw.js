/* Reckon service worker.

   HTML / navigations  -> network-first: when online you always get the
   freshest app; when offline you get the last cached copy. A `git push`
   therefore goes live on the next online launch with NO cache-name bump.

   Other assets (icons, manifest) -> cache-first: instant load, offline-safe.

   You only need to bump CACHE below if you change THIS file's logic
   (or an icon / the manifest). Normal app edits to index.html / app-logic.js
   need nothing — both are served network-first. */
const CACHE = 'reckon-v5';
const ASSETS = [
  './',
  './index.html',
  './app-logic.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];
const NET_TIMEOUT = 3500;   // ms before a slow launch falls back to cache

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isHTML(req) {
  return req.mode === 'navigate' ||
         (req.headers.get('accept') || '').includes('text/html');
}
/* app-logic.js carries the same fast-changing app code as index.html, so it
   gets the same network-first treatment (no cache bump needed on edits) */
function isAppScript(req) {
  return new URL(req.url).pathname.endsWith('/app-logic.js');
}

/* network-first with a timeout, falling back to a cached copy.
   `key` is the cache entry to refresh and fall back to. */
async function netFirst(req, key) {
  const net = fetch(req);
  /* refresh the cached copy whenever the network eventually answers */
  net.then(r => {
    if (r && r.ok) caches.open(CACHE).then(c => c.put(key, r.clone()));
  }).catch(() => {});
  try {
    const r = await Promise.race([
      net,
      new Promise((_, rej) => setTimeout(rej, NET_TIMEOUT))
    ]);
    if (r && r.ok) return r;
  } catch (e) { /* timed out or offline — fall through to the cache */ }
  return (await caches.match(key)) || (await caches.match(req)) || net;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  if (isHTML(req)) {
    e.respondWith(netFirst(req, './index.html'));
    return;
  }
  if (isAppScript(req)) {
    e.respondWith(netFirst(req, './app-logic.js'));
    return;
  }

  /* cache-first for everything else */
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(resp => {
      if (resp && resp.ok && new URL(req.url).origin === location.origin) {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return resp;
    }))
  );
});
