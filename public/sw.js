/**
 * 静的アセットだけをキャッシュする最小構成の Service Worker。
 * 検索結果(/api/*)は鮮度が命なのでキャッシュしない。オフライン時はアプリの殻だけ開く。
 */
const CACHE = "chuko-hunter-v1";
const SHELL = ["/", "/styles.css", "/app.js", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // 取得できたものは次回のオフライン用に置き換えておく
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit ?? caches.match("/"))),
  );
});
