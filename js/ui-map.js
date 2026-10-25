import { assetUrl } from "./config.js";
import { dayColorFor, dayLegendLabel } from "./day-colors.js";
import { vacationDays } from "./days.js";
import { getMediaForPlace, getNotesForPlace, getPlacesForVacation, getVacation } from "./db.js";
import { formatTimeFromTs, getCurrentPosition } from "./geo.js";
import { ICON_BACK_CHEVRON } from "./icons.js";
import { getMapSegment, setMapSegment } from "./map-session.js";
import { navigate } from "./router.js";
import { setTripSelection } from "./ui-urlaub-detail.js";
import { mountTripFooter } from "./ui-trip-footer.js";
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

function queueFooterAction(action) {
  sessionStorage.setItem("vacrecap-pending-footer", action);
}

export async function renderMapScreen(appEl, vacationId) {
  const vacation = await getVacation(vacationId);
  if (!vacation) {
    navigate({ name: "urlaube" });
    return;
  }

  const days = vacationDays(vacation);
  let segment = getMapSegment(vacationId);
  const L = await loadLeaflet();

  appEl.className = "screen screen--map";
  appEl.dataset.testid = "map-screen";
  appEl.dataset.vacationId = vacationId;

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
    <div data-role="footer-mount"></div>
  `;

  appEl.querySelector('[data-action="back"]').addEventListener("click", () => {
    if (window.history.length > 1) {
      history.back();
    } else {
      navigate({ name: "urlaub-detail", id: vacationId }, { replace: true });
    }
  });

  const mapEl = appEl.querySelector('[data-role="map"]');
  const offlineHint = appEl.querySelector('[data-role="offline-hint"]');
  const emptyHint = appEl.querySelector('[data-role="empty-hint"]');
  const segmentsEl = appEl.querySelector('[data-role="segments"]');
  const legendEl = appEl.querySelector('[data-role="legend"]');

  const map = L.map(mapEl, {
    zoomControl: false,
    attributionControl: false,
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

  function drawMarkers() {
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
      const latlngs = sorted.map((p) => [p.lat, p.lng]);
      if (latlngs.length >= 2) {
        L.polyline(latlngs, {
          color: dayColorFor(vacation, dayIso),
          weight: 3.5,
          opacity: 0.9,
          lineCap: "round",
          lineJoin: "round",
        }).addTo(layerGroup);
      }
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
          navigate({ name: "urlaub-detail", id: vacationId });
          map.closePopup();
        });
      });
    });

    emptyHint.hidden = items.length > 0;
    fitView(items.map((e) => e.place));
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
    map.fitBounds(bounds, { padding: [40, 40], animate: false });
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
  requestAnimationFrame(() => map.invalidateSize());

  const dayForFooter = () => contextDay(vacationId, vacation, segment);
  mountTripFooter(appEl.querySelector('[data-role="footer-mount"]'), {
    onRememberPlace: async () => {
      const { rememberPlaceFromGps } = await import("./place-service.js");
      const day = dayForFooter();
      setTripSelection(vacationId, day, null);
      await rememberPlaceFromGps({ vacationId, day });
      mapData = await loadMapPlaces(vacationId);
      drawMarkers();
    },
    onCamera: () => {
      setTripSelection(vacationId, dayForFooter(), null);
      queueFooterAction("camera");
      navigate({ name: "urlaub-detail", id: vacationId });
    },
    onNote: () => {
      setTripSelection(vacationId, dayForFooter(), null);
      queueFooterAction("note");
      navigate({ name: "urlaub-detail", id: vacationId });
    },
    onGallery: () => {
      setTripSelection(vacationId, dayForFooter(), null);
      queueFooterAction("gallery");
      navigate({ name: "urlaub-detail", id: vacationId });
    },
  });

  appEl._mapCleanup = () => {
    map.remove();
    delete appEl._mapCleanup;
  };
}
