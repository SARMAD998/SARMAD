/*
  Service worker — lets the web app open with no connection.

  Every file of the app is copied into the device's cache when it is first
  opened (and again whenever a new version is published), and served from
  there afterwards. Requests to MEGA are never touched: they always go
  straight to the network.

  The version and the list of files below are filled in by scripts/build-webapp.js.
*/

const VERSION = "38dbfd803d5a";
const CACHE = 'daxil-app-' + VERSION;
const FILES = [
  "./",
  "index.html",
  "vendor/xlsx.full.min.js",
  "vendor/fonts/noto-kufi-arabic.css",
  "vendor/fonts/files/noto-kufi-arabic-arabic-400-normal.woff2",
  "vendor/fonts/files/noto-kufi-arabic-math-400-normal.woff2",
  "vendor/fonts/files/noto-kufi-arabic-symbols-400-normal.woff2",
  "vendor/fonts/files/noto-kufi-arabic-latin-ext-400-normal.woff2",
  "vendor/fonts/files/noto-kufi-arabic-latin-400-normal.woff2",
  "vendor/fonts/files/noto-kufi-arabic-arabic-500-normal.woff2",
  "vendor/fonts/files/noto-kufi-arabic-math-500-normal.woff2",
  "vendor/fonts/files/noto-kufi-arabic-symbols-500-normal.woff2",
  "vendor/fonts/files/noto-kufi-arabic-latin-ext-500-normal.woff2",
  "vendor/fonts/files/noto-kufi-arabic-latin-500-normal.woff2",
  "vendor/fonts/files/noto-kufi-arabic-arabic-700-normal.woff2",
  "vendor/fonts/files/noto-kufi-arabic-math-700-normal.woff2",
  "vendor/fonts/files/noto-kufi-arabic-symbols-700-normal.woff2",
  "vendor/fonts/files/noto-kufi-arabic-latin-ext-700-normal.woff2",
  "vendor/fonts/files/noto-kufi-arabic-latin-700-normal.woff2",
  "vendor/mega.js",
  "web-shim.js",
  "mobile.css",
  "manifest.webmanifest",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png"
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // straight from the host, never from the browser's own short-term cache:
      // a new version must not be stored with an old copy of some file in it
      .then(cache => cache.addAll(FILES.map(file => new Request(file, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.indexOf('daxil-app-') === 0 && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(request, { ignoreSearch: true }).then(hit => {
        if (hit) return hit;
        // opening the app at its folder address is the same as opening index.html
        if (request.mode === 'navigate') {
          return cache.match('index.html').then(page => page || fetch(request));
        }
        return fetch(request);
      })
    )
  );
});
