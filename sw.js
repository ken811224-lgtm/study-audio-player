/* 学習音声プレーヤー Service Worker：画面の部品を端末にしまって、機内モードでも開けるようにする
 * 音声そのものは IndexedDB に入っているので、ここではしまわない
 * 版を上げたら CACHE の名前も変える（変えると新しい部品に入れかわる）
 */
var CACHE = 'sap-v1.7.3';
var FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  // cache: 'reload' … ブラウザの一時保存（古い版のこともある）を使わず、公開先から取り直す
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(FILES.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                       // GAS への送信などはそのまま通す
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // ほかのサイトは触らない
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).catch(function () {
        if (req.mode === 'navigate') return caches.match('index.html');
        return new Response('', { status: 504 });
      });
    })
  );
});
