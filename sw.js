const CACHE_VERSION = "vacrecap-v3";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/styles.css",
  "./js/app.js",
  "./js/config.js",
  "./js/db.js",
  "./js/router.js",
  "./js/utils.js",
  "./js/vacation.js",
  "./js/covers.js",
  "./js/toast.js",
  "./js/days.js",
  "./js/settings-store.js",
  "./js/places.js",
  "./js/icons.js",
  "./js/ui-urlaube.js",
  "./js/ui-urlaub-form.js",
  "./js/ui-urlaub-detail.js",
  "./js/ui-urlaub-settings.js",
  "./js/ui-trip-footer.js",
  "./js/ui-trip-day-calendar.js",
  "./js/ui-calendar.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./assets/covers/stadt.svg",
  "./assets/covers/strand.svg",
  "./assets/covers/berge.svg",
  "./assets/covers/wald.svg",
  "./assets/covers/roadtrip.svg",
  "./assets/covers/winter.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok && response.type === "basic") {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
