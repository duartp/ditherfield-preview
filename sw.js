// ditherfield app - offline cache (built by tools/make_app.py; do not edit here).
// Cache first: the app opens with no network. A new build has a new VERSION: it installs in the background, fetching
// every file past the HTTP cache (GitHub Pages caches for 10 min), then takes over; old caches are removed.
var VERSION = 'ac608f8e1646';
var FILES = ["./", "index.html", "manifest.webmanifest", "css/app.css", "js/df.js", "js/tables.js", "js/gl.js", "js/params.js", "js/colour.js", "js/mod.js", "js/shaders.js", "js/engine.js", "js/synth.js", "js/state.js", "vendor/mp4-muxer.js", "js/export.js", "js/app.js", "vendor/mp4-muxer.LICENSE", "fonts/ChivoMono-Bold.ttf", "fonts/DMMono-Medium.ttf", "fonts/FragmentMono-Regular.ttf", "fonts/Gloock-Regular.ttf", "fonts/IBMPlexMono-SemiBold.ttf", "fonts/SpaceMono-Bold.ttf", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png"];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open('df-' + VERSION).then(function (c) {
    return Promise.all(FILES.map(function (f) { return fetch(new Request(f, { cache: 'reload' })).then(function (r) {
      if (!r.ok) throw new Error(f + ' ' + r.status); return c.put(f, r); }); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k.indexOf('df-') === 0 && k !== 'df-' + VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request; if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open('df-' + VERSION).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      if (req.mode === 'navigate') return c.match('index.html');
      return fetch(req);
    });
  }));
});
