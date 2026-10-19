const CACHE = "starisle-shell-icons-20261019";
const SHELL = ["/", "/styles.v0.46.css", "/topbar.css?v=0.9", "/app.v0.61.js", "/solar-system", "/solar-system.css?v=0.33", "/solar-system.js?v=0.35", "/moon-calendar", "/moon-calendar.css?v=1.1", "/moon-calendar.js?v=1.3", "/moon-nasa-clementine.jpg", "/manifest.webmanifest", "/icon.svg?v=star-trails-20261017", "/icon-32.png?v=star-trails-20261017", "/icon-192.png?v=star-trails-20261017", "/icon-512.png?v=star-trails-20261017", "/apple-touch-icon.png?v=star-trails-20261017", "/apple-touch-icon-152.png?v=star-trails-20261017", "/apple-touch-icon-167.png?v=star-trails-20261017"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        // 只有页面导航才回退到缓存的首页。脚本或样式一旦缺少缓存就让请求失败，
        // 绝不能把 HTML 当作 JS/CSS 返回，否则整页脚本会因语法错误而失效。
        if (event.request.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
