const CACHE_VERSION = "vacrecap-v9";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/fonts.css",
  "./css/styles.css",
  "./fonts/nunito-sans-latin-400-normal.woff2",
  "./fonts/nunito-sans-latin-600-normal.woff2",
  "./fonts/nunito-sans-latin-700-normal.woff2",
  "./fonts/nunito-sans-latin-800-normal.woff2",
  "./fonts/nunito-sans-latin-900-normal.woff2",
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
  "./js/geo.js",
  "./js/place-service.js",
  "./js/place-stats.js",
  "./js/icons.js",
  "./js/gesture-guard.js",
  "./js/overlay-stack.js",
  "./js/ui-urlaube.js",
  "./js/ui-urlaub-form.js",
  "./js/ui-urlaub-detail.js",
  "./js/ui-urlaub-settings.js",
  "./js/ui-trip-footer.js",
  "./js/ui-trip-day-calendar.js",
  "./js/ui-place-list.js",
  "./js/ui-place-sheets.js",
  "./js/media-process.js",
  "./js/media-service.js",
  "./js/note-service.js",
  "./js/target-place.js",
  "./js/ui-camera-sheet.js",
  "./js/ui-note-sheet.js",
  "./js/ui-media-viewer.js",
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

  if (request.mode === "navigate") {
    event.respondWith(
      caches.match("./index.html", { ignoreSearch: true }).then((cached) => {
        if (cached) return cached;
        return fetch(request).catch(() => caches.match("./index.html", { ignoreSearch: true }));
      })
    );
    return;
  }

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
