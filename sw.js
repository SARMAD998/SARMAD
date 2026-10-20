/*
  Service worker — lets the web app open with no connection.

  Every file of the app is copied into the device's cache when it is first
  opened (and again whenever a new version is published), and served from
  there afterwards. Requests to MEGA are never touched: they always go
  straight to the network.

  The version and the list of files below are filled in by scripts/build-webapp.js.
*/

const VERSION = "36dcfd040d2d";
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
  "update-bar.js",
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
      .then(() => waitForThePersonOrTakeOver())
  );
});

/*
  A new version does not normally take over by itself: it waits, the open page
  shows "a new version is ready", and it takes over when the person presses
  "update now" (the message below).

  But that only works if the open page knows how to show the bar. A page from
  an early version does not — it would leave this version waiting for ever. So
  the open pages are asked first; if none answers, this version takes over at
  once and is what the app opens with next time.
*/
function waitForThePersonOrTakeOver() {
  return new Promise(resolve => {
    let channel;
    try { channel = new BroadcastChannel('daxil-update'); }
    catch (e) { self.skipWaiting(); resolve(); return; }

    let answered = false;
    channel.onmessage = event => { if (event.data === 'page-will-offer') answered = true; };
    channel.postMessage('new-version-ready');
    setTimeout(() => {
      channel.close();
      console.log('daxil app ' + VERSION + (answered ? ': waiting for "update now"' : ': no page could offer it, taking over'));
      if (!answered) self.skipWaiting();
      resolve();
    }, 2000);
  });
}

self.addEventListener('message', event => {
  if (event.data === 'daxil:activate') self.skipWaiting();
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
