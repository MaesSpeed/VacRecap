import { assetUrl } from "./config.js";
import { dayColorFor, dayLegendLabel } from "./day-colors.js";
import { vacationDays } from "./days.js";
import { getMediaForPlace, getNotesForPlace, getPlacesForVacation, getVacation } from "./db.js";
import { formatTimeFromTs, getCurrentPosition } from "./geo.js";
import { peekRouteSegment, resolveRouteSegment } from "./route-service.js";
import { getMapRoutesEnabled } from "./settings-store.js";
import { ICON_BACK_CHEVRON } from "./icons.js";
import { getMapSegment, setMapSegment } from "./map-session.js";
import { prefetchCaptureGps } from "./capture-gps-prefetch.js";
import { savePhotoForPlace, saveVideoForPlace } from "./media-service.js";
import { leaveMapScreen, returnToTripFromMap } from "./map-nav.js";
import { queuePendingFooter } from "./pending-footer.js";
import { navigate } from "./router.js";
import { resolveFooterCaptureTarget } from "./target-place.js";
import { loadTripSelection } from "./trip-selection-store.js";
import { storeTripSelection, setTripSelection } from "./ui-urlaub-detail.js";
import { mountTripFooter } from "./ui-trip-footer.js";
import { dismissActiveToast, showToast, showTwoLineToast } from "./toast.js";
import { escapeHtml } from "./utils.js";

const PARIS = { lat: 48.8566, lng: 2.3522 };
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

let leafletPromise = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      if (!document.querySelector('link[data-leaflet-css]')) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = assetUrl("vendor/leaflet/leaflet.css");
        link.dataset.leafletCss = "1";
        document.head.appendChild(link);
      }
      const script = document.createElement("script");
      script.src = assetUrl("vendor/leaflet/leaflet.js");
      script.onload = () => resolve(window.L);
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }
  return leafletPromise;
}

function hasPosition(place) {
  return place.lat != null && place.lng != null;
}

function placeDay(place) {
  return place.day || place.dayDate;
}

async function loadMapPlaces(vacationId) {
  const places = await getPlacesForVacation(vacationId);
  const enriched = await Promise.all(
    places.map(async (place) => {
      if (place.soft) {
        return { place, photos: 0, videos: 0, notes: 0 };
      }
      const [media, notes] = await Promise.all([
        getMediaForPlace(place.id),
        getNotesForPlace(place.id),
      ]);
      const photos = media.filter((m) => m.type !== "video").length;
      const videos = media.filter((m) => m.type === "video").length;
      return { place, photos, videos, notes: notes.length };
    })
  );
  const hardWithPos = enriched
    .filter((e) => !e.place.soft && hasPosition(e.place))
    .sort((a, b) => a.place.ts - b.place.ts);
  const numberById = new Map(hardWithPos.map((e, i) => [e.place.id, i + 1]));
  return { enriched, numberById };
}

function statsLine({ photos, videos, notes }) {
  const parts = [];
  if (photos > 0) parts.push(`${photos} Foto${photos === 1 ? "" : "s"}`);
  if (videos > 0) parts.push(`${videos} Video${videos === 1 ? "" : "s"}`);
  if (notes > 0) parts.push(`${notes} Notiz${notes === 1 ? "" : "en"}`);
  return parts.join(" · ") || "Keine Medien";
}

function contextDay(vacationId, vacation, segment) {
  if (segment !== "all") return segment;
  const days = vacationDays(vacation);
  return days[0];
}

export async function renderMapScreen(appEl, vacationId) {
  const vacation = await getVacation(vacationId);
  if (!vacation) {
    navigate({ name: "urlaube" });
    return;
  }

  const days = vacationDays(vacation);
  let segment = getMapSegment(vacationId);

  appEl.className = "screen screen--map";
  appEl.dataset.testid = "map-screen";
  appEl.dataset.vacationId = vacationId;

  const L = await loadLeaflet();

  appEl.innerHTML = `
    <header class="map-header">
      <button type="button" class="map-header__back" data-action="back">${ICON_BACK_CHEVRON}<span class="map-header__trip">${escapeHtml(vacation.title)}</span></button>
      <h1 class="map-header__title">Karte</h1>
      <span class="map-header__spacer" aria-hidden="true"></span>
    </header>
    <div class="map-segments-wrap">
      <div class="map-segments" data-role="segments" role="tablist"></div>
    </div>
    <div class="map-stage">
      <div class="map-canvas" data-role="map"></div>
      <p class="map-offline-hint" data-role="offline-hint" hidden>Kartenbild braucht Internet</p>
      <p class="map-empty-hint" data-role="empty-hint" hidden>Noch keine Orte mit Position</p>
    </div>
    <div class="map-legend" data-role="legend"></div>
    <input type="file" accept="image/*" capture="environment" hidden data-role="capture-photo-input" data-testid="map-capture-photo-input" />
    <input type="file" accept="video/*" capture="environment" hidden data-role="capture-video-input" data-testid="map-capture-video-input" />
    <div data-role="footer-mount"></div>
  `;

  appEl.querySelector('[data-action="back"]').addEventListener("click", () => {
    leaveMapScreen(vacationId);
  });

  const capturePhotoInput = appEl.querySelector('[data-role="capture-photo-input"]');
  const captureVideoInput = appEl.querySelector('[data-role="capture-video-input"]');
  let captureBusy = false;
  const VIDEO_LONGPRESS_HINT_KEY = "vacrecap-video-longpress-hint";

  const mapEl = appEl.querySelector('[data-role="map"]');
  const offlineHint = appEl.querySelector('[data-role="offline-hint"]');
  const emptyHint = appEl.querySelector('[data-role="empty-hint"]');
  const segmentsEl = appEl.querySelector('[data-role="segments"]');
  const legendEl = appEl.querySelector('[data-role="legend"]');

  const map = L.map(mapEl, {
    zoomControl: false,
    attributionControl: false,
    zoomSnap: 0.25,
  });

  L.control
    .attribution({ position: "bottomright", prefix: false })
    .addAttribution(
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap-Mitwirkende</a>'
    )
    .addTo(map);

  const tileLayer = L.tileLayer(TILE_URL, {
    maxZoom: 19,
    detectRetina: true,
  });
  tileLayer.on("tileerror", () => {
    offlineHint.hidden = false;
  });
  tileLayer.addTo(map);

  const layerGroup = L.layerGroup().addTo(map);
  let mapData = await loadMapPlaces(vacationId);
  let drawGeneration = 0;
  let lastFitPlaces = [];

  function renderSegments() {
    const items = [
      { id: "all", label: "Alle Tage" },
      ...days.map((iso) => ({
        id: iso,
        label: dayLegendLabel(vacation, iso),
      })),
    ];
    segmentsEl.innerHTML = items
      .map(
        (item) => `
      <button type="button" class="map-segment${segment === item.id ? " map-segment--active" : ""}" data-segment="${item.id}" role="tab" aria-selected="${segment === item.id}">${escapeHtml(item.label)}</button>`
      )
      .join("");
    segmentsEl.querySelectorAll("[data-segment]").forEach((btn) => {
      btn.addEventListener("click", () => {
        segment = btn.dataset.segment;
        setMapSegment(vacationId, segment);
        renderSegments();
        renderLegend();
        drawMarkers();
      });
    });
  }

  function renderLegend() {
    const legendDays = segment === "all" ? days : [segment];
    legendEl.innerHTML = legendDays
      .map(
        (iso) => `
      <span class="map-legend-chip">
        <span class="map-legend-chip__dot" style="background:${dayColorFor(vacation, iso)}"></span>
        ${escapeHtml(dayLegendLabel(vacation, iso))}
      </span>`
      )
      .join("");
  }

  function filteredPlaces() {
    return mapData.enriched.filter((e) => {
      if (!hasPosition(e.place)) return false;
      if (segment === "all") return true;
      return placeDay(e.place) === segment;
    });
  }

  function straightStyle(color) {
    return {
      color,
      weight: 3,
      opacity: 0.9,
      lineCap: "round",
      lineJoin: "round",
      dashArray: "7 9",
    };
  }

  function routedStyle(color) {
    return {
      color,
      weight: 3.5,
      opacity: 0.9,
      lineCap: "round",
      lineJoin: "round",
    };
  }

  async function drawSegmentRoutes(sorted, dayIso, gen) {
    if (sorted.length < 2) return;
    const color = dayColorFor(vacation, dayIso);
    const routesEnabled = await getMapRoutesEnabled();
    const online = navigator.onLine;

    for (let i = 0; i < sorted.length - 1; i++) {
      const from = sorted[i];
      const to = sorted[i + 1];
      const fallback = [[from.lat, from.lng], [to.lat, to.lng]];
      let layer = L.polyline(fallback, straightStyle(color)).addTo(layerGroup);

      if (!routesEnabled) continue;

      const peek = await peekRouteSegment(
        { lat: from.lat, lng: from.lng },
        { lat: to.lat, lng: to.lng }
      );
      if (peek?.kind === "routed") {
        layer.remove();
        layer = L.polyline(peek.latlngs, routedStyle(color)).addTo(layerGroup);
        continue;
      }

      if (!online || peek?.kind === "straight") continue;

      void resolveRouteSegment(
        { lat: from.lat, lng: from.lng },
        { lat: to.lat, lng: to.lng },
        { routesEnabled, online }
      ).then((result) => {
        if (gen !== drawGeneration) return;
        if (!layerGroup.hasLayer(layer)) return;
        layer.remove();
        const style = result.kind === "routed" ? routedStyle(color) : straightStyle(color);
        L.polyline(result.latlngs, style).addTo(layerGroup);
      });
    }
  }

  function drawMarkers() {
    drawGeneration += 1;
    const gen = drawGeneration;
    layerGroup.clearLayers();
    const items = filteredPlaces();
    const hardItems = items.filter((e) => !e.place.soft);
    const byDay = new Map();
    hardItems.forEach((e) => {
      const d = placeDay(e.place);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(e.place);
    });
    byDay.forEach((places, dayIso) => {
      const sorted = places.slice().sort((a, b) => a.ts - b.ts);
      void drawSegmentRoutes(sorted, dayIso, gen);
    });

    items.forEach((entry) => {
      const { place, photos, videos, notes } = entry;
      const dayIso = placeDay(place);
      const color = dayColorFor(vacation, dayIso);
      const latlng = [place.lat, place.lng];

      if (place.soft) {
        const icon = L.divIcon({
          className: "map-marker-wrap",
          html: `<span class="map-marker map-marker--soft" style="border-color:${color}"></span>`,
          iconSize: [12, 12],
          iconAnchor: [6, 6],
        });
        L.marker(latlng, { icon }).addTo(layerGroup);
        return;
      }

      const num = mapData.numberById.get(place.id);
      const icon = L.divIcon({
        className: "map-marker-wrap",
        html: `<span class="map-marker map-marker--hard" style="background:${color}"><span>${num}</span></span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      const marker = L.marker(latlng, { icon }).addTo(layerGroup);
      const popupHtml = `
        <div class="map-popup">
          <strong>${escapeHtml(place.name)}</strong>
          <span>${escapeHtml(formatTimeFromTs(place.ts))}</span>
          <span>${escapeHtml(statsLine({ photos, videos, notes }))}</span>
          <button type="button" class="map-popup__btn" data-place-id="${place.id}" data-day="${dayIso}">Zur Karte</button>
        </div>`;
      marker.bindPopup(popupHtml);
      marker.on("popupopen", () => {
        const root = marker.getPopup().getElement();
        const btn = root?.querySelector(".map-popup__btn");
        btn?.addEventListener("click", () => {
          setTripSelection(vacationId, dayIso, place.id);
          map.closePopup();
          returnToTripFromMap(vacationId);
        });
      });
    });

    emptyHint.hidden = items.length > 0;
    lastFitPlaces = items.map((e) => e.place);
    scheduleFitView(lastFitPlaces);
  }

  function scheduleFitView(places) {
    const run = () => fitView(places);
    run();
    requestAnimationFrame(() => {
      map.invalidateSize();
      run();
    });
    setTimeout(() => {
      map.invalidateSize();
      run();
    }, 350);
  }

  function fitView(places) {
    const coords = places.filter(hasPosition);
    if (!coords.length) {
      void centerDefault();
      return;
    }
    if (coords.length === 1) {
      map.setView([coords[0].lat, coords[0].lng], 15, { animate: false });
      return;
    }
    const bounds = L.latLngBounds(coords.map((p) => [p.lat, p.lng]));
    map.fitBounds(bounds, { padding: [24, 24], animate: false });
  }

  async function centerDefault() {
    try {
      const pos = await getCurrentPosition({ timeout: 4000, maximumAge: 60000 });
      map.setView([pos.coords.latitude, pos.coords.longitude], 12, { animate: false });
    } catch {
      map.setView([PARIS.lat, PARIS.lng], 12, { animate: false });
    }
  }

  renderSegments();
  renderLegend();
  drawMarkers();

  const dayForFooter = () => contextDay(vacationId, vacation, segment);

  async function resolveMapCaptureDayPlace() {
    const day = dayForFooter();
    const saved = await loadTripSelection(vacationId);
    const activeDay = saved?.activeDay ?? day;
    const selectedPlaceId = saved?.selectedByDay?.[activeDay] ?? null;
    return { day: activeDay, selectedPlaceId };
  }

  async function saveMapCapture(file, kind) {
    if (!file || captureBusy) return;
    captureBusy = true;
    showToast("Wird gespeichert…", { sticky: true, icon: "none" });
    try {
      const { day, selectedPlaceId } = await resolveMapCaptureDayPlace();
      const r = await resolveFooterCaptureTarget({
        vacationId,
        day,
        selectedPlaceId,
        mediaKind: kind,
      });
      if (kind === "video") {
        await saveVideoForPlace({ file, place: r.place, vacationId, day });
      } else {
        await savePhotoForPlace({ file, place: r.place, vacationId, day });
      }
      dismissActiveToast();
      if (r.toast?.line) {
        showTwoLineToast(r.toast.title || (kind === "video" ? "Video gespeichert" : "Foto gespeichert"), r.toast.line);
      } else {
        showToast(kind === "video" ? "Video gespeichert" : "Foto gespeichert");
      }
      returnToTripFromMap(vacationId);
    } catch {
      dismissActiveToast();
      showToast("Speichern fehlgeschlagen");
    } finally {
      captureBusy = false;
    }
  }

  capturePhotoInput.addEventListener("change", () => {
    const file = capturePhotoInput.files?.[0];
    capturePhotoInput.value = "";
    void saveMapCapture(file, "photo");
  });

  captureVideoInput.addEventListener("change", () => {
    const file = captureVideoInput.files?.[0];
    captureVideoInput.value = "";
    void saveMapCapture(file, "video");
  });

  mountTripFooter(appEl.querySelector('[data-role="footer-mount"]'), {
    onRememberPlace: async () => {
      const { rememberPlaceFromGps } = await import("./place-service.js");
      const day = dayForFooter();
      await storeTripSelection(vacationId, day, null);
      setTripSelection(vacationId, day, null);
      await rememberPlaceFromGps({ vacationId, day });
      mapData = await loadMapPlaces(vacationId);
      drawMarkers();
    },
    onCamera: () => {
      const day = dayForFooter();
      setTripSelection(vacationId, day, null);
      void storeTripSelection(vacationId, day, null);
      prefetchCaptureGps();
      capturePhotoInput?.click();
    },
    onCameraVideo: () => {
      const day = dayForFooter();
      setTripSelection(vacationId, day, null);
      void storeTripSelection(vacationId, day, null);
      if (!localStorage.getItem(VIDEO_LONGPRESS_HINT_KEY)) {
        localStorage.setItem(VIDEO_LONGPRESS_HINT_KEY, "1");
        showToast("Lange drücken = Video");
      }
      prefetchCaptureGps();
      captureVideoInput?.click();
    },
    onNote: () => {
      const day = dayForFooter();
      void storeTripSelection(vacationId, day, null).then(() => {
        setTripSelection(vacationId, day, null);
        queuePendingFooter("note");
        returnToTripFromMap(vacationId);
      });
    },
    onGallery: () => {
      const day = dayForFooter();
      void storeTripSelection(vacationId, day, null).then(() => {
        setTripSelection(vacationId, day, null);
        queuePendingFooter("gallery");
        returnToTripFromMap(vacationId);
      });
    },
  });

  appEl._mapCleanup = () => {
    map.remove();
    delete appEl._mapCleanup;
  };
}
