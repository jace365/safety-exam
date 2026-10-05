/* 오프라인 지원 서비스 워커 — 한 번 접속하면 인터넷 없이도 열립니다.
 * 내용을 수정해 다시 배포할 때는 CACHE 버전을 올려 주세요. */
const CACHE = 'ise-pwa-v20';
const FILES = [
  './', 'index.html', 'manifest.webmanifest',
  'assets/style.css', 'assets/app.js',
  'assets/icon-192.png', 'assets/icon-512.png', 'assets/icon-maskable-512.png', 'assets/apple-touch-icon.png',
  'data/00-core.js',
  'data/written-01.js', 'data/written-02.js', 'data/written-03.js', 'data/written-04.js', 'data/written-05.js', 'data/written-06.js', 'data/written-07.js',
  'data/mock-01.js', 'data/mock-02.js', 'data/mock-03.js', 'data/mock-04.js', 'data/mock-05.js',
  'data/mock-p-01.js', 'data/mock-p-02.js', 'data/mock-p-03.js', 'data/mock-p-04.js', 'data/mock-p-05.js',
  'data/practical-01.js', 'data/practical-02.js', 'data/practical-03.js', 'data/practical-04.js', 'data/practical-05.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
/* 같은 출처 파일: 캐시 우선 + 백그라운드 갱신. 다른 출처(Anthropic API 등)는 건드리지 않음 */
self.addEventListener('fetch', function (e) {
  var r = e.request;
  if (r.method !== 'GET') return;
  var u = new URL(r.url);
  if (u.origin !== location.origin) return;
  e.respondWith(caches.match(r, { ignoreSearch: true }).then(function (hit) {
    var net = fetch(r).then(function (res) {
      if (res && res.ok) { var cp = res.clone(); caches.open(CACHE).then(function (c) { c.put(r, cp); }); }
      return res;
    }).catch(function () {
      return hit || (r.mode === 'navigate' ? caches.match('index.html') : undefined);
    });
    return hit || net;
  }));
});
