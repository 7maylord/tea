const CACHE = "tea-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/favicon.ico"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("tea-shell-") && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/" && request.mode === "navigate") {
    event.respondWith(fetch(request).then(async (response) => {
      if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());
      return response;
    }).catch(() => caches.match("/")));
    return;
  }
  if (url.pathname.startsWith("/_next/static/") || SHELL.slice(1).includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    }));
  }
});
