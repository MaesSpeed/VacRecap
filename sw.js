/**
 * Transitional kill-switch (Build 42): replaces legacy vacrecap-v38 SW.
 * No fetch handler — unregister first (avoid Chromium navigate/activate deadlock),
 * clear vacrecap-* caches, then navigate clients without awaiting.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.registration.unregister();
      if (self.caches) {
        const keys = await caches.keys();
        await Promise.all(
          keys.filter((k) => k.startsWith("vacrecap-")).map((k) => caches.delete(k))
        );
      }
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        void client.navigate(client.url).catch(() => {
          try {
            client.postMessage({ type: "vacrecap-sw-reload" });
          } catch {
            /* ignore */
          }
        });
      }
    })()
  );
});
