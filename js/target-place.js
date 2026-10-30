import { deletePlace, getMediaForPlace, getNotesForPlace, getPlace, getPlacesForDay, putPlace, updateMediaRow } from "./db.js";
import { fallbackPlaceName, getCapturePosition, haversineMeters, isLocationUnavailable, reverseGeocodeName } from "./geo.js";
import { updatePlaceName } from "./place-service.js";
import {
  distanceFitsPlace,
  formatApproxMeters,
  GEOCODE_WAIT_MS,
  gpsIsUsable,
  nearestPlaceWithin,
  resolveCaptureDay,
} from "./photo-assign.js";
import {
  createPlace,
  findPlaceWithinMeters,
  newestHardPlace,
  normalizePlace,
} from "./places.js";
import { getRememberCaptureLocation, getSamePlaceRadiusM } from "./settings-store.js";
import { showToast } from "./toast.js";
import { clampTitle, todayIso } from "./utils.js";

const OHNE_ORT = "Ohne Ort";

function tsForDay(day) {
  if (day === todayIso()) return Date.now();
  return new Date(`${day}T12:00:00`).getTime();
}

function findOhneOrt(places) {
  return places.find(
    (p) => !p.soft && p.name === OHNE_ORT && p.lat == null && p.lng == null
  );
}

async function fallbackPlace({ vacationId, day, selectedPlaceId }) {
  const all = await getPlacesForDay(vacationId, day);
  const hard = all.filter((p) => !p.soft);

  if (selectedPlaceId) {
    const selected = hard.find((p) => p.id === selectedPlaceId);
    if (selected) return { place: selected, createdOhneOrt: false, toast: null };
  }

  const newest = newestHardPlace(hard);
  if (newest) return { place: newest, createdOhneOrt: false, toast: null };

  const existing = findOhneOrt(hard);
  if (existing) return { place: existing, createdOhneOrt: false, toast: null };

  const ts = tsForDay(day);
  const place = createPlace({
    vacationId,
    day,
    ts,
    lat: null,
    lng: null,
    name: OHNE_ORT,
    soft: false,
    source: "ohne-ort",
  });
  await putPlace(place);
  return {
    place,
    createdOhneOrt: true,
    toast: { title: "Ohne Ort gespeichert", line: "" },
  };
}

async function resolveWithGps({ vacationId, day }) {
  const { consumePrefetchedCaptureGps } = await import("./capture-gps-prefetch.js");
  const prefetched = await consumePrefetchedCaptureGps();
  let lat;
  let lng;
  let accuracy;
  if (prefetched) {
    lat = prefetched.latitude;
    lng = prefetched.longitude;
    accuracy = prefetched.accuracy;
  } else {
    const pos = await getCapturePosition();
    lat = pos.coords.latitude;
    lng = pos.coords.longitude;
    accuracy = pos.coords.accuracy;
  }
  const dedupM = await getSamePlaceRadiusM();
  const all = await getPlacesForDay(vacationId, day);
  const hard = all.filter((p) => !p.soft);
  const near = findPlaceWithinMeters(hard, lat, lng, dedupM);
  if (near) {
    return {
      place: normalizePlace(near),
      createdOhneOrt: false,
      toast: { line: `Zu «${near.name}» hinzugefügt`, kind: "matched" },
    };
  }
  const ts = Date.now();
  const name = fallbackPlaceName(ts);
  const place = createPlace({
    vacationId,
    day,
    ts,
    lat,
    lng,
    accuracy,
    name,
    soft: false,
    source: "capture",
  });
  await putPlace(place);
  return {
    place,
    createdOhneOrt: false,
    toast: {
      line: `Neuer Ort: ${name}`,
      kind: "new",
      placeName: name,
    },
  };
}

/** Nur Anzeige in der Notiz-Ortsbox – legt keine Karte an. */
export async function previewNoteCaptureTarget({ vacationId, day, selectedPlaceId }) {
  const all = await getPlacesForDay(vacationId, day);
  const hard = all.filter((p) => !p.soft);

  if (selectedPlaceId) {
    const selected = hard.find((p) => p.id === selectedPlaceId);
    if (selected) return { label: selected.name, kind: "selected" };
  }

  if (await getRememberCaptureLocation()) {
    try {
      const pos = await getCapturePosition();
      const { latitude: lat, longitude: lng } = pos.coords;
      const dedupM = await getSamePlaceRadiusM();
      const near = findPlaceWithinMeters(hard, lat, lng, dedupM);
      if (near) return { label: near.name, kind: "gps-match" };
      return { label: "Neuer Ort", kind: "gps-new" };
    } catch {
      const newest = newestHardPlace(hard);
      if (newest) return { label: newest.name, kind: "fallback" };
      const existing = findOhneOrt(hard);
      if (existing) return { label: existing.name, kind: "fallback" };
      return { label: OHNE_ORT, kind: "fallback" };
    }
  }

  const newest = newestHardPlace(hard);
  if (newest) return { label: newest.name, kind: "fallback" };
  const existing = findOhneOrt(hard);
  if (existing) return { label: existing.name, kind: "fallback" };
  return { label: OHNE_ORT, kind: "fallback" };
}

/** Galerie: ausgewählter Ort vor GPS/Fallback. */
export async function resolveGalleryPhotoTarget({ vacationId, day, selectedPlaceId }) {
  const fb = await fallbackPlace({ vacationId, day, selectedPlaceId });
  return {
    ...fb,
    needsRefresh: fb.createdOhneOrt,
    toast: { title: "Foto gespeichert", line: `«${fb.place.name}»` },
  };
}

const GEOCODE_TIMEOUT = Symbol("geocode-timeout");

async function readCaptureFix() {
  const { consumePrefetchedCaptureGps } = await import("./capture-gps-prefetch.js");
  const prefetched = await consumePrefetchedCaptureGps();
  if (prefetched) {
    return {
      latitude: prefetched.latitude,
      longitude: prefetched.longitude,
      accuracy: prefetched.accuracy,
    };
  }
  const pos = await getCapturePosition();
  return {
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    accuracy: pos.coords.accuracy,
  };
}

/**
 * Neue Karte sofort mit Ortsnamen, sonst «Ort HH:MM» und Name nachziehen.
 * @returns {{ place: object, cancelRename: () => void }}
 */
export async function createCapturePlace({ vacationId, day, lat, lng, accuracy, ts = Date.now() }) {
  let cancelled = false;
  const fallback = fallbackPlaceName(ts);
  const geocode = reverseGeocodeName(lat, lng)
    .then((name) => (name ? clampTitle(name) : null))
    .catch(() => null);
  const quick = await Promise.race([
    geocode,
    new Promise((resolve) => setTimeout(() => resolve(GEOCODE_TIMEOUT), GEOCODE_WAIT_MS)),
  ]);
  const name = quick && quick !== GEOCODE_TIMEOUT ? quick : fallback;
  const place = createPlace({
    vacationId,
    day,
    ts,
    lat,
    lng,
    accuracy,
    name,
    soft: false,
    source: "capture",
  });
  const saved = await putPlace(place);
  const renamed =
    quick === GEOCODE_TIMEOUT
      ? geocode.then(async (late) => {
          if (!late || cancelled || late === saved.name) return null;
          try {
            return await updatePlaceName(saved, late);
          } catch {
            return null;
          }
        })
      : Promise.resolve(null);
  return {
    place: saved,
    renamed,
    cancelRename() {
      cancelled = true;
    },
  };
}

/**
 * Verschiebt Fotos auf eine andere Karte.
 * Mit `mediaIds` nur diese Aufnahme, sonst alle Fotos von `fromId`.
 */
export async function movePlacePhotos(fromId, toPlace, mediaIds = null) {
  if (!toPlace?.id) return [];
  const day = toPlace.day || toPlace.dayDate;
  if (Array.isArray(mediaIds)) {
    const moved = [];
    for (const id of mediaIds) {
      if (!id) continue;
      moved.push(await updateMediaRow(id, { waypoint_id: toPlace.id, day }));
    }
    return moved;
  }
  if (!fromId) return [];
  const media = await getMediaForPlace(fromId);
  const moved = [];
  for (const item of media) {
    moved.push(await updateMediaRow(item.id, { waypoint_id: toPlace.id, day }));
  }
  return moved;
}

export async function deletePlaceIfEmpty(placeId) {
  if (!placeId) return false;
  try {
    const place = await getPlace(placeId);
    if (!place) return false;
    const [media, notes] = await Promise.all([getMediaForPlace(placeId), getNotesForPlace(placeId)]);
    if (media.length || notes.length) return false;
    await deletePlace(placeId);
    return true;
  } catch {
    return false;
  }
}

function inaccurateToast(placeName) {
  return {
    variant: "warn",
    title: "Standort ungenau",
    line: `Foto bei «${placeName}»`,
    action: "change",
  };
}

/**
 * Footer-Kamera und Kamera auf der Karte: dieselbe Distanzregel.
 * Passt nicht = Abstand zur ausgewählten Karte > Radius «Gleicher Ort» und > 2× GPS-Genauigkeit.
 */
export async function resolvePhotoCaptureTarget({
  vacation = null,
  vacationId,
  day,
  selectedPlaceId,
  takenAt = Date.now(),
  mediaKind = "photo",
}) {
  const captureDay = resolveCaptureDay(takenAt, day, vacation);
  const radiusM = await getSamePlaceRadiusM();
  const all = await getPlacesForDay(vacationId, captureDay);
  const hard = all.filter((p) => !p.soft);
  const selectedOnCaptureDay = hard.find((p) => p.id === selectedPlaceId) || null;
  let previousPlace = selectedOnCaptureDay;
  if (!previousPlace && selectedPlaceId && captureDay !== day) {
    const viewed = await getPlacesForDay(vacationId, day);
    previousPlace = viewed.find((p) => p.id === selectedPlaceId && !p.soft) || null;
  }

  let fix = null;
  try {
    fix = await readCaptureFix();
  } catch (err) {
    if (!isLocationUnavailable(err)) throw err;
  }

  const usable = Boolean(fix) && gpsIsUsable(fix.accuracy);
  if (!usable) {
    const fb = await fallbackPlace({
      vacationId,
      day: captureDay,
      selectedPlaceId: selectedOnCaptureDay?.id || (captureDay === day ? selectedPlaceId : null),
    });
    return {
      place: fb.place,
      day: captureDay,
      createdOhneOrt: fb.createdOhneOrt,
      createdNew: false,
      previousPlace: previousPlace && previousPlace.id !== fb.place.id ? previousPlace : null,
      distanceM: null,
      inaccurate: true,
      position: fix,
      radiusM,
      needsRefresh: fb.createdOhneOrt || captureDay !== day,
      toast: inaccurateToast(fb.place.name),
      mediaKind,
    };
  }

  const { latitude: lat, longitude: lng, accuracy } = fix;
  if (selectedOnCaptureDay?.lat != null && selectedOnCaptureDay?.lng != null) {
    const distanceM = haversineMeters(lat, lng, selectedOnCaptureDay.lat, selectedOnCaptureDay.lng);
    if (distanceFitsPlace(distanceM, radiusM, accuracy)) {
      return {
        place: normalizePlace(selectedOnCaptureDay),
        day: captureDay,
        createdOhneOrt: false,
        createdNew: false,
        previousPlace: null,
        distanceM,
        inaccurate: false,
        position: fix,
        radiusM,
        matchedSelected: true,
        needsRefresh: captureDay !== day,
        toast: null,
        mediaKind,
      };
    }
  }

  const near = nearestPlaceWithin(hard, lat, lng, radiusM, selectedOnCaptureDay?.id);
  if (near) {
    return {
      place: normalizePlace(near.place),
      day: captureDay,
      createdOhneOrt: false,
      createdNew: false,
      previousPlace: selectedOnCaptureDay,
      distanceM: near.distanceM,
      inaccurate: false,
      position: fix,
      radiusM,
      matchedOther: true,
      needsRefresh: true,
      toast: {
        title: mediaKind === "video" ? "Video gespeichert" : "Foto gespeichert",
        line: `Zu «${near.place.name}» hinzugefügt`,
      },
      mediaKind,
    };
  }

  let distanceM = null;
  if (selectedOnCaptureDay?.lat != null && selectedOnCaptureDay?.lng != null) {
    distanceM = haversineMeters(lat, lng, selectedOnCaptureDay.lat, selectedOnCaptureDay.lng);
  }
  const created = await createCapturePlace({
    vacationId,
    day: captureDay,
    lat,
    lng,
    accuracy,
    ts: takenAt || Date.now(),
  });
  const line = distanceM != null ? `${formatApproxMeters(distanceM)} entfernt` : "aus dem Foto-Standort";
  return {
    place: created.place,
    day: captureDay,
    createdOhneOrt: false,
    createdNew: true,
    previousPlace: selectedOnCaptureDay,
    distanceM,
    inaccurate: false,
    position: fix,
    radiusM,
    cancelRename: created.cancelRename,
    renamed: created.renamed,
    needsRefresh: true,
    toast: {
      title: `Neue Karte «${created.place.name}»`,
      line,
      action: previousPlace ? "undo" : null,
    },
    mediaKind,
  };
}

/** Footer-Kamera/Video: dieselbe Regel wie der Kamera-Button auf der Karte. */
export async function resolveFooterCaptureTarget(args) {
  return resolvePhotoCaptureTarget(args);
}

export async function resolvePlaceCardCaptureTarget({
  vacation = null,
  vacationId,
  day,
  placeId,
  takenAt = Date.now(),
  mediaKind = "photo",
}) {
  const all = await getPlacesForDay(vacationId, day);
  const place = all.find((p) => p.id === placeId && !p.soft);
  if (!place) throw new Error("place missing");
  return resolvePhotoCaptureTarget({
    vacation,
    vacationId,
    day,
    selectedPlaceId: placeId,
    takenAt,
    mediaKind,
  });
}

/** Laufendes Upload-Ziel, damit Rückgängig und Ändern nicht mit dem Insert kollidieren. */
export function createPlaceRedirect(place) {
  let current = place;
  let chain = Promise.resolve();
  let retirePlaceId = null;
  let pending = 0;
  const captureMediaIds = [];
  function run(fn) {
    const next = chain.then(() => fn(), () => fn());
    chain = next.then(
      () => {},
      () => {}
    );
    return next;
  }
  return {
    get place() {
      return current;
    },
    set place(value) {
      current = value;
    },
    get retirePlaceId() {
      return retirePlaceId;
    },
    set retirePlaceId(id) {
      retirePlaceId = id;
    },
    get pending() {
      return pending;
    },
    hold() {
      pending += 1;
    },
    release() {
      pending = Math.max(0, pending - 1);
    },
    noteMedia(id) {
      if (id && !captureMediaIds.includes(id)) captureMediaIds.push(id);
    },
    captureMediaIds() {
      return captureMediaIds.slice();
    },
    run,
  };
}

export async function resolveCaptureTarget({
  vacationId,
  day,
  selectedPlaceId,
  mediaKind = "photo",
}) {
  const title =
    mediaKind === "video"
      ? "Video gespeichert"
      : mediaKind === "note"
        ? "Notiz gespeichert"
        : "Foto gespeichert";

  if (await getRememberCaptureLocation()) {
    try {
      const gps = await resolveWithGps({ vacationId, day });
      if (gps.toast) gps.toast.title = title;
      return { ...gps, needsRefresh: true };
    } catch (err) {
      if (!isLocationUnavailable(err)) throw err;
      const fb = await fallbackPlace({ vacationId, day, selectedPlaceId });
      return {
        ...fb,
        needsRefresh: fb.createdOhneOrt,
        toast: {
          title,
          line: "Ohne Position (Standort nicht verfügbar)",
          variant: "warn",
        },
      };
    }
  }

  const fb = await fallbackPlace({ vacationId, day, selectedPlaceId });
  return { ...fb, needsRefresh: fb.createdOhneOrt };
}

export async function getOrCreateOhneOrtPlace({ vacationId, day, showToastOnCreate = true }) {
  const all = await getPlacesForDay(vacationId, day);
  const hard = all.filter((p) => !p.soft);
  const existing = findOhneOrt(hard);
  if (existing) return { place: existing, created: false };

  const ts = tsForDay(day);
  const place = createPlace({
    vacationId,
    day,
    ts,
    lat: null,
    lng: null,
    name: OHNE_ORT,
    soft: false,
    source: "ohne-ort",
  });
  await putPlace(place);
  if (showToastOnCreate) showToast("Ohne Ort gespeichert");
  return { place, created: true };
}

export async function resolveMediathekTarget({ vacationId, day, selectedPlaceId }) {
  const all = await getPlacesForDay(vacationId, day);
  const hard = all.filter((p) => !p.soft);

  if (selectedPlaceId) {
    const selected = hard.find((p) => p.id === selectedPlaceId);
    if (selected) return { place: selected, ohneOrtPending: false };
  }
  const newest = newestHardPlace(hard);
  if (newest) return { place: newest, ohneOrtPending: false };
  return { place: null, ohneOrtPending: true };
}

export async function ensureTargetPlace({ vacationId, day, selectedPlaceId }) {
  const r = await resolveCaptureTarget({ vacationId, day, selectedPlaceId });
  return {
    place: r.place,
    createdOhneOrt: r.createdOhneOrt,
    toast: r.toast,
    needsRefresh: r.needsRefresh,
  };
}
