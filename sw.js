/**
 * Transitional kill-switch (Build 41): replaces legacy vacrecap-v38 SW.
 * No fetch handler — only clears vacrecap-* caches, unregisters, reloads clients.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      if (self.caches) {
        const keys = await caches.keys();
        await Promise.all(
          keys.filter((k) => k.startsWith("vacrecap-")).map((k) => caches.delete(k))
        );
      }
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        try {
          await client.navigate(client.url);
        } catch {
          client.postMessage({ type: "vacrecap-sw-reload" });
        }
      }
      await self.registration.unregister();
    })()
  );
});
