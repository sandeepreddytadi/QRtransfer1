/* Service Worker — caches all app assets for offline use */
const CACHE  = 'qrft-v1';
const ASSETS = [
  '/', '/index.html', '/sender.html', '/receiver.html',
  '/css/app.css',
  '/js/protocol.js', '/js/sender.js', '/js/receiver.js',
  '/libs/bootstrap.min.css', '/libs/bootstrap.bundle.min.js',
  '/libs/jsQR.min.js', '/libs/qrcode.min.js', '/libs/pako.min.js',
  '/manifest.json'
];

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

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).catch(() => cached))
  );
});
