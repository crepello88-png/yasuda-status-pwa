/* sw.js — offline cache. shell=cache-first / status.json=stale-while-revalidate(+last-good). GET のみ。 */
var CACHE = "yasuda-status-v4";  // 2026-06-10: tier badge / hold display / new bot plugins 反映で bump
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
    // stale-while-revalidate: cache を即返し (速い)、 裏で network 更新 → 次回 fetch で fresh。
    // iOS Safari + Tailscale の一時 glitch で respondWith が reject せず、 app 側が offline 化しない。
    e.respondWith(caches.open(CACHE).then(function (cache) {
      return cache.match("status.json").then(function (cached) {
        var network = fetch(e.request).then(function (resp) {
          if (resp.ok) cache.put("status.json", resp.clone());
          return resp;
        }).catch(function () { return cached; });   // network 失敗時は cache に退避 (未処理 rejection も防ぐ)
        return cached || network;
      });
    }));
    return;
  }
  e.respondWith(caches.match(e.request).then(function (hit) { return hit || fetch(e.request); }));
});
