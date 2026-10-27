const CACHE_VERSION = "vacrecap-v38";
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
  "./js/safe.js",
  "./js/boot-stable.js",
  "./js/app-version.js",
  "./js/config.js",
  "./js/db.js",
  "./js/router.js",
  "./js/utils.js",
  "./js/vacation.js",
  "./js/covers.js",
  "./js/toast.js",
  "./js/days.js",
  "./js/day-colors.js",
  "./js/map-session.js",
  "./js/settings-store.js",
  "./js/places.js",
  "./js/geo.js",
  "./js/place-service.js",
  "./js/place-stats.js",
  "./js/icons.js",
  "./js/gesture-guard.js",
  "./js/visual-viewport.js",
  "./js/overlay-stack.js",
  "./js/ui-urlaube.js",
  "./js/ui-urlaub-form.js",
  "./js/ui-urlaub-detail.js",
  "./js/ui-urlaub-settings.js",
  "./js/ui-map.js",
  "./vendor/leaflet/leaflet.js",
  "./vendor/leaflet/leaflet.css",
  "./assets/map-tile-placeholder.png",
  "./js/ui-trip-footer.js",
  "./js/ui-place-list.js",
  "./js/ui-place-sheets.js",
  "./js/media-process.js",
  "./js/media-service.js",
  "./js/note-service.js",
  "./js/target-place.js",
  "./js/vacation-stats.js",
  "./js/trip-selection-store.js",
  "./js/ui-confirm.js",
  "./js/capture-gps-prefetch.js",
  "./js/ui-note-sheet.js",
  "./js/media-source.js",
  "./js/mediathek-session.js",
  "./js/ui-mediathek.js",
  "./js/ui-mediathek-place-sheet.js",
  "./js/ui-media-viewer.js",
  "./js/ui-calendar.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./assets/covers/stadt.jpg",
  "./assets/covers/stadt-thumb.jpg",
  "./assets/covers/strand.jpg",
  "./assets/covers/strand-thumb.jpg",
  "./assets/covers/berge.jpg",
  "./assets/covers/berge-thumb.jpg",
  "./assets/covers/wald.jpg",
  "./assets/covers/wald-thumb.jpg",
  "./assets/covers/roadtrip.jpg",
  "./assets/covers/roadtrip-thumb.jpg",
  "./assets/covers/winter.jpg",
  "./assets/covers/winter-thumb.jpg",
  "./js/ui-cover-credits.js",
  "./js/backup-service.js",
  "./js/zip-reader.js",
  "./js/restore-service.js",
  "./js/ui-restore-sheet.js",
  "./js/ui-backup-sheet.js",
  "./js/zip-builder.js",
  "./js/storage-format.js",
  "./js/media-file-meta.js",
  "./js/route-cache.js",
  "./js/route-service.js",
  "./js/map-nav.js",
  "./js/pending-footer.js",
  "./js/resume-policy.js",
  "./js/thumb-repair-queue.js",
  "./js/thumb-decode-state.js",
  "./js/ui-global-settings.js",
  "./js/migration-recovery.js",
];

function isPrecachedAsset(url) {
  try {
    const path = new URL(url, self.location.href).pathname;
    return ASSETS.some((a) => {
      const rel = a.replace(/^\.\//, "");
      return path.endsWith(rel) || path.endsWith("/" + rel);
    });
  } catch {
    return false;
  }
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      Promise.all(
        ASSETS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch((err) => {
            console.warn("[vacrecap-sw] precache failed:", url, err);
            return null;
          })
        )
      )
    ).then(() => self.skipWaiting())
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
      caches.open(CACHE_VERSION).then((cache) =>
        cache.match("./index.html", { ignoreSearch: true }).then((cached) => {
          if (cached) return cached;
          return fetch(request).catch(() => cache.match("./index.html", { ignoreSearch: true }));
        })
      )
    );
    return;
  }

  if (!isPrecachedAsset(request.url)) {
    event.respondWith(fetch(request).catch(() => caches.match(request)));
    return;
  }

  event.respondWith(
    caches.open(CACHE_VERSION).then((cache) =>
      cache.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok && response.type === "basic") {
            return cache.put(request, response.clone()).then(() => response);
          }
          return response;
        });
      })
    )
  );
});
