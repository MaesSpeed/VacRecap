import {
  fallbackPlaceName,
  formatTimeFromTs,
  getCurrentPosition,
  haversineMeters,
  reverseGeocodeName,
} from "./geo.js";
import { deletePlace, getPlacesForDay, putPlace } from "./db.js";
import { createPlace, findPlaceWithinMeters, normalizePlace } from "./places.js";
import { showToast } from "./toast.js";

const DEDUP_M = 150;

async function resolveName(lat, lng, ts) {
  try {
    const name = await reverseGeocodeName(lat, lng);
    if (name) return name;
  } catch {
    /* offline */
  }
  return fallbackPlaceName(ts);
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
  const existing = await getPlacesForDay(vacationId, day);
  const near = findPlaceWithinMeters(
    existing.filter((p) => !p.soft),
    lat,
    lng,
    DEDUP_M
  );
  if (near && !soft) {
    return { place: normalizePlace(near), duplicate: true };
  }

  const name = soft
    ? await resolveName(lat, lng, ts)
    : await resolveName(lat, lng, ts);

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
  } catch {
    showToast("Erlaube den Standort in den Browser-Einstellungen.", {
      title: "Standort nicht verfügbar",
    });
    return null;
  }
}

export async function trySoftPointOnOpen({ vacationId, day, isToday }) {
  if (!isToday) return null;
  try {
    const pos = await getCurrentPosition({ maximumAge: 60000 });
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    const existing = await getPlacesForDay(vacationId, day);
    const sorted = existing.slice().sort((a, b) => b.ts - a.ts);
    const last = sorted[0];
    if (last?.lat != null && last?.lng != null) {
      if (haversineMeters(lat, lng, last.lat, last.lng) <= DEDUP_M) {
        return null;
      }
    }
    const hasSoftNearby = existing.some(
      (p) =>
        p.soft &&
        p.lat != null &&
        p.lng != null &&
        haversineMeters(lat, lng, p.lat, p.lng) <= DEDUP_M
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

export async function promoteSoftPlace(place) {
  const updated = normalizePlace({
    ...place,
    soft: false,
    source: "manual",
    updatedAt: Date.now(),
  });
  await putPlace(updated);
  return updated;
}

export async function discardSoftPlace(placeId) {
  await deletePlace(placeId);
}

export async function updatePlaceName(place, name) {
  const updated = normalizePlace({
    ...place,
    name: name.trim(),
    title: name.trim(),
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
