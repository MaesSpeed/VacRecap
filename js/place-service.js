import {
  fallbackPlaceName,
  formatTimeFromTs,
  getCurrentPosition,
  haversineMeters,
  isLocationUnavailable,
  reverseGeocodeName,
} from "./geo.js";
import { deletePlace, getPlacesForDay, putPlace } from "./db.js";
import { createPlace, findPlaceWithinMeters, normalizePlace } from "./places.js";
import { getSamePlaceRadiusM } from "./settings-store.js";
import { showToast, showWarnToast } from "./toast.js";

async function resolveName(lat, lng, ts) {
  if (lat == null || lng == null) return fallbackPlaceName(ts);
  try {
    const name = await reverseGeocodeName(lat, lng);
    if (name) return name;
  } catch {
    /* offline */
  }
  return fallbackPlaceName(ts);
}

function bumpRememberStats(place) {
  const now = Date.now();
  const count = (place.rememberCount ?? 0) + 1;
  const first = place.rememberFirstTs ?? place.ts ?? now;
  return normalizePlace({
    ...place,
    rememberCount: count,
    rememberFirstTs: first,
    rememberLastTs: now,
    updatedAt: now,
  });
}

export async function rememberPlaceAtLocation({
  vacationId,
  day,
  lat,
  lng,
  accuracy,
  soft = false,
  source = "manual",
}) {
  const ts = Date.now();
  const dedupM = await getSamePlaceRadiusM();
  const existing = await getPlacesForDay(vacationId, day);
  const hard = existing.filter((p) => !p.soft);
  if (lat != null && lng != null) {
    const near = findPlaceWithinMeters(hard, lat, lng, dedupM);
    if (near && !soft) {
      const updated = bumpRememberStats(near);
      await putPlace(updated);
      return { place: updated, duplicate: true };
    }
  }

  const name = await resolveName(lat, lng, ts);
  const place = createPlace({
    vacationId,
    day,
    ts,
    lat,
    lng,
    accuracy,
    name,
    soft,
    source,
    rememberCount: soft ? 0 : 1,
    rememberFirstTs: soft ? null : ts,
    rememberLastTs: soft ? null : ts,
  });
  await putPlace(place);
  return { place, duplicate: false };
}

export async function rememberPlaceFromGps({ vacationId, day }) {
  try {
    const pos = await getCurrentPosition();
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    const result = await rememberPlaceAtLocation({
      vacationId,
      day,
      lat,
      lng,
      accuracy,
      soft: false,
      source: "manual",
    });
    return result;
  } catch (err) {
    if (!isLocationUnavailable(err)) throw err;
    const ts = Date.now();
    const name = fallbackPlaceName(ts);
    const place = createPlace({
      vacationId,
      day,
      ts,
      lat: null,
      lng: null,
      name,
      soft: false,
      source: "manual",
      rememberCount: 1,
      rememberFirstTs: ts,
      rememberLastTs: ts,
    });
    await putPlace(place);
    showWarnToast("Ort ohne Position gemerkt", {
      title: "Standort nicht verfügbar",
    });
    return { place, duplicate: false, noGps: true };
  }
}

export async function trySoftPointOnOpen({ vacationId, day, isToday }) {
  if (!isToday) return null;
  try {
    const pos = await getCurrentPosition({ maximumAge: 60000 });
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    const existing = await getPlacesForDay(vacationId, day);
    const dedupM = await getSamePlaceRadiusM();
    const hard = existing.filter((p) => !p.soft);
    if (hard.some((p) => p.lat != null && haversineMeters(lat, lng, p.lat, p.lng) <= dedupM)) {
      return null;
    }
    const hasSoftNearby = existing.some(
      (p) =>
        p.soft &&
        p.lat != null &&
        p.lng != null &&
        haversineMeters(lat, lng, p.lat, p.lng) <= dedupM
    );
    if (hasSoftNearby) return null;

    const result = await rememberPlaceAtLocation({
      vacationId,
      day,
      lat,
      lng,
      accuracy,
      soft: true,
      source: "open",
    });
    return result.place;
  } catch {
    return null;
  }
}

export async function promoteSoftPlace(place, { vacationId, day } = {}) {
  const vid = vacationId ?? place.vacationId;
  const d = day ?? place.day;
  if (place.lat != null && place.lng != null) {
    const dedupM = await getSamePlaceRadiusM();
    const existing = await getPlacesForDay(vid, d);
    const hard = existing.filter((p) => !p.soft && p.id !== place.id);
    const near = findPlaceWithinMeters(hard, place.lat, place.lng, dedupM);
    if (near) {
      const updated = bumpRememberStats(near);
      await putPlace(updated);
      await deletePlace(place.id);
      return { place: updated, duplicate: true, discardedSoftId: place.id };
    }
  }
  const updated = normalizePlace({
    ...place,
    soft: false,
    source: "manual",
    rememberCount: Math.max(place.rememberCount ?? 0, 1),
    rememberFirstTs: place.rememberFirstTs ?? place.ts,
    rememberLastTs: place.rememberLastTs ?? Date.now(),
    updatedAt: Date.now(),
  });
  await putPlace(updated);
  return { place: updated, duplicate: false };
}

export async function discardSoftPlace(placeId) {
  await deletePlace(placeId);
}

export async function filterSoftPointsHidden(items, vacationId, day) {
  const dedupM = await getSamePlaceRadiusM();
  const hard = items.map((i) => i.place).filter((p) => !p.soft);
  return items.filter(({ place }) => {
    if (!place.soft) return true;
    if (place.lat == null || place.lng == null) return true;
    return !hard.some(
      (h) => h.lat != null && haversineMeters(place.lat, place.lng, h.lat, h.lng) <= dedupM
    );
  });
}

export async function updatePlaceName(place, name) {
  const trimmed = name.trim();
  const updated = normalizePlace({
    ...place,
    name: trimmed,
    title: trimmed,
    updatedAt: Date.now(),
  });
  await putPlace(updated);
  return updated;
}

export function softPointLabel(place) {
  const time = formatTimeFromTs(place.ts);
  const street = place.name || "Unbekannt";
  return `${time} · Weicher Punkt · ${street} · beim Öffnen`;
}
