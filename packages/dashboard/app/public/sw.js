const CACHE_NAME = "fusion-cache-v1";
const APP_SHELL_URLS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/logo.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL_URLS);
    } catch (error) {
      console.warn("[sw] install cache warmup failed", error);
    }
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    } catch (error) {
      console.warn("[sw] activate cleanup failed", error);
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  const isApiRequest = url.pathname.startsWith("/api/");

  if (isApiRequest) {
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(request);
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, networkResponse.clone());
        } catch (cacheError) {
          console.warn("[sw] api cache put failed", cacheError);
        }
        return networkResponse;
      } catch (networkError) {
        try {
          const cachedResponse = await caches.match(request);
          if (cachedResponse) {
            return cachedResponse;
          }
        } catch (cacheError) {
          console.warn("[sw] api cache lookup failed", cacheError);
        }
        throw networkError;
      }
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      const cachedResponse = await cache.match(request);
      if (cachedResponse) {
        return cachedResponse;
      }

      const networkResponse = await fetch(request);
      await cache.put(request, networkResponse.clone());
      return networkResponse;
    } catch (error) {
      console.warn("[sw] static cache flow failed", error);
      return fetch(request);
    }
  })());
});
