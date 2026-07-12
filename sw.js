/* sw.js — offline cache.
   shell=cache-first / status.json=**network-first**+cache-fallback。 GET のみ。
   2026-07-09 v8: status.json を network-first に変更 (旧 stale-while-revalidate で
   iPhone PWA が古い data 見せ続ける問題を解消)。 network 失敗時のみ cache に退避、
   通常運用では常に fresh を取る。
   2026-07-12 v22: JPX 週次 margin cache lookup (公式 data 優先)
   2026-07-12 v23: 信用倍率 ∞ 表示 (完全 buy-only 銘柄用 🔥 marker)
*/
var CACHE = "yasuda-status-v23";
var SHELL = ["./", "index.html", "app.js", "style.css", "manifest.json",
             "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var url = new URL(e.request.url);
  if (url.pathname.endsWith("status.json")) {
    // network-first: 毎回 fresh を取りに行く。 network 失敗時のみ cache に退避。
    // 副次的に cache は「offline 時の緊急表示」用として最新版を保持。
    e.respondWith(
      fetch(e.request, { cache: "no-store" }).then(function (resp) {
        if (resp && resp.ok) {
          var respClone = resp.clone();
          caches.open(CACHE).then(function (cache) { cache.put("status.json", respClone); });
          return resp;
        }
        // non-ok 応答は cache フォールバック
        return caches.match("status.json").then(function (cached) { return cached || resp; });
      }).catch(function () {
        // network 完全失敗のみ cache 退避
        return caches.match("status.json");
      })
    );
    return;
  }
  e.resp