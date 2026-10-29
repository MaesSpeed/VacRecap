import { dayChipDateLine, dayIndexInTrip, dayRoleLabel, isDayInVacation, vacationDays } from "./days.js";
import { fallbackPlaceName, haversineMeters } from "./geo.js";
import { formatIsoDate } from "./utils.js";

/** Standort gilt als unbrauchbar, wenn die Genauigkeit schlechter als dieser Wert ist. */
export const GPS_ACCURACY_LIMIT_M = 100;

/** Reverse-Geocoding blockiert die neue Karte höchstens so lange. */
export const GEOCODE_WAIT_MS = 900;

export function gpsIsUsable(accuracy) {
  const n = Number(accuracy);
  if (!Number.isFinite(n)) return true;
  return n <= GPS_ACCURACY_LIMIT_M;
}

/** Passt nicht, wenn der Abstand größer als der Radius UND größer als 2× Genauigkeit ist. */
export function distanceFitsPlace(distanceM, radiusM, accuracyM) {
  if (!Number.isFinite(distanceM)) return false;
  const acc = Number.isFinite(Number(accuracyM)) ? Number(accuracyM) : 0;
  return !(distanceM > radiusM && distanceM > acc * 2);
}

export function formatApproxMeters(meters) {
  const n = Math.max(0, Math.round(Number(meters) || 0));
  return `ca. ${n} m`;
}

export function fotoCountLabel(count, { ohneGps = false } = {}) {
  const n = Number(count) || 0;
  const base = n === 1 ? "1 Foto" : `${n} Fotos`;
  return ohneGps ? `${base} ohne GPS` : base;
}

/**
 * Aufnahmetag innerhalb der Reise, sonst der gerade gezeigte Tag.
 * Ohne Zeitstempel bleibt es beim angezeigten Tag (Galerie ohne EXIF).
 * Mit Zeitstempel (EXIF oder Kamera = jetzt) zählt dessen Kalendertag.
 */
export function resolveCaptureDay(takenAt, activeDay, vacation) {
  if (takenAt == null || !vacation?.startDate) return activeDay;
  const iso = formatIsoDate(new Date(takenAt));
  if (isDayInVacation(vacation, iso)) return iso;
  return activeDay;
}

export function nearestPlaceWithin(places, lat, lng, radiusM, excludeId = null) {
  let best = null;
  let bestD = Infinity;
  for (const place of places) {
    if (!place || place.soft || place.id === excludeId) continue;
    if (place.lat == null || place.lng == null) continue;
    const distanceM = haversineMeters(lat, lng, place.lat, place.lng);
    if (distanceM <= radiusM && distanceM < bestD) {
      best = place;
      bestD = distanceM;
    }
  }
  return best ? { place: best, distanceM: bestD } : null;
}

/** Greedy: jedes Foto zum ersten Cluster, dessen Startpunkt innerhalb des Radius liegt. */
export function clusterPhotos(photos, radiusM) {
  const clusters = [];
  const sorted = photos.slice().sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0) || String(a.key).localeCompare(String(b.key)));
  for (const photo of sorted) {
    let hit = null;
    for (const cluster of clusters) {
      const seed = cluster.photos[0];
      if (haversineMeters(photo.lat, photo.lng, seed.lat, seed.lng) <= radiusM) {
        hit = cluster;
        break;
      }
    }
    if (hit) {
      hit.photos.push(photo);
      const n = hit.photos.length;
      hit.lat = hit.photos.reduce((sum, p) => sum + p.lat, 0) / n;
      hit.lng = hit.photos.reduce((sum, p) => sum + p.lng, 0) / n;
    } else {
      clusters.push({ photos: [photo], lat: photo.lat, lng: photo.lng });
    }
  }
  return clusters;
}

function hardPlacesOnDay(places, day) {
  return places.filter((p) => !p.soft && (p.day || p.dayDate) === day);
}

function dayCaption(vacation, day) {
  if (!vacation) return dayChipDateLine(day);
  const total = vacationDays(vacation).length || 1;
  return `${dayChipDateLine(day)} · ${dayRoleLabel(dayIndexInTrip(vacation, day), total)}`;
}

/**
 * Ordnet Fotos den Karten eines Tages zu.
 * Innerhalb des Radius → diese Karte (ausgewählte zuerst), sonst Cluster → neue Karte.
 * Ohne GPS → ausgewählte Karte, bzw. Ohne Ort wenn es keine gibt oder der Tag ein anderer ist.
 */
export function planPhotoGroups({
  photos,
  places,
  activeDay,
  selectedPlaceId,
  radiusM,
  vacation,
}) {
  /** @type {Map<string, object>} */
  const groups = new Map();
  const unmatched = [];

  function pushPhoto(key, photo) {
    const group = groups.get(key);
    group.photoKeys.push(photo.key);
    if (photo.takenAt && (group.ts == null || photo.takenAt < group.ts)) group.ts = photo.takenAt;
  }

  for (const photo of photos) {
    const dayPlaces = hardPlacesOnDay(places, photo.day);
    const selected =
      photo.day === activeDay ? dayPlaces.find((p) => p.id === selectedPlaceId) || null : null;
    const hasGps = photo.lat != null && photo.lng != null;

    if (!hasGps) {
      if (selected) {
        const key = `place:${selected.id}:nogps`;
        if (!groups.has(key)) {
          groups.set(key, {
            id: key,
            kind: "place",
            day: photo.day,
            place: selected,
            lat: null,
            lng: null,
            name: selected.name,
            distanceM: null,
            photoKeys: [],
            ohneGps: true,
            gpsCount: 0,
            ohneCount: 0,
            ts: photo.takenAt || null,
            suggested: null,
          });
        }
        const group = groups.get(key);
        group.ohneCount = (group.ohneCount || 0) + 1;
        pushPhoto(key, photo);
      } else {
        const key = `ohne:${photo.day}`;
        if (!groups.has(key)) {
          groups.set(key, {
            id: key,
            kind: "ohne",
            day: photo.day,
            place: null,
            lat: null,
            lng: null,
            name: "Ohne Ort",
            distanceM: null,
            photoKeys: [],
            ohneGps: true,
            gpsCount: 0,
            ohneCount: 0,
            ts: photo.takenAt || null,
            suggested: null,
          });
        }
        groups.get(key).ohneCount = (groups.get(key).ohneCount || 0) + 1;
        pushPhoto(key, photo);
      }
      continue;
    }

    let matched = null;
    if (selected?.lat != null && selected?.lng != null) {
      const distanceM = haversineMeters(photo.lat, photo.lng, selected.lat, selected.lng);
      if (distanceM <= radiusM) matched = { place: selected, distanceM };
    }
    if (!matched) {
      matched = nearestPlaceWithin(dayPlaces, photo.lat, photo.lng, radiusM, selected?.id);
    }
    if (matched) {
      const key = `place:${matched.place.id}`;
      if (!groups.has(key)) {
        groups.set(key, {
          id: key,
          kind: "place",
          day: photo.day,
          place: matched.place,
          lat: photo.lat,
          lng: photo.lng,
          name: matched.place.name,
          distanceM: matched.distanceM,
          photoKeys: [],
          ohneGps: false,
          gpsCount: 0,
          ohneCount: 0,
          ts: photo.takenAt || null,
          suggested: null,
        });
      }
      const group = groups.get(key);
      group.gpsCount = (group.gpsCount || 0) + 1;
      if (group.distanceM == null || matched.distanceM < group.distanceM) group.distanceM = matched.distanceM;
      pushPhoto(key, photo);
      continue;
    }
    unmatched.push(photo);
  }

  const byDay = new Map();
  for (const photo of unmatched) {
    const list = byDay.get(photo.day) || [];
    list.push(photo);
    byDay.set(photo.day, list);
  }
  let clusterIndex = 0;
  for (const [day, list] of byDay) {
    for (const cluster of clusterPhotos(list, radiusM)) {
      clusterIndex += 1;
      const ts = cluster.photos.find((p) => p.takenAt)?.takenAt || Date.now();
      const selected = day === activeDay ? places.find((p) => p.id === selectedPlaceId && !p.soft) : null;
      const distanceM =
        selected?.lat != null && selected?.lng != null
          ? haversineMeters(cluster.lat, cluster.lng, selected.lat, selected.lng)
          : null;
      const id = `new:${day}:${clusterIndex}`;
      groups.set(id, {
        id,
        kind: "new",
        day,
        place: null,
        lat: cluster.lat,
        lng: cluster.lng,
        name: fallbackPlaceName(ts),
        distanceM,
        photoKeys: cluster.photos.map((p) => p.key),
        ohneGps: false,
        gpsCount: cluster.photos.length,
        ohneCount: 0,
        ts,
        suggested: {
          lat: cluster.lat,
          lng: cluster.lng,
          name: fallbackPlaceName(ts),
          ts,
        },
      });
    }
  }

  const list = [...groups.values()];
  for (const group of list) {
    group.ohneGps = group.kind !== "new" && !(group.gpsCount > 0);
  }
  const needsSheet = list.some((group) => !groupStaysOnSelected(group, activeDay, selectedPlaceId));
  return { groups: list, needsSheet };
}

function groupStaysOnSelected(group, activeDay, selectedPlaceId) {
  if (group.day !== activeDay) return false;
  if (group.kind === "place" && group.place?.id === selectedPlaceId) return true;
  if (group.kind === "ohne" && !selectedPlaceId) return true;
  return false;
}

export function groupTitle(group) {
  if (group.kind === "new") return `Neue Karte «${group.name}»`;
  return group.place?.name || group.name || "Ohne Ort";
}

export function groupSubtitle(group, { activeDay, selectedPlaceId } = {}) {
  if (group.ohneGps && group.kind !== "new") return "Foto ohne Standort";
  if (group.kind === "new") {
    return group.distanceM != null ? `${formatApproxMeters(group.distanceM)} entfernt` : "neuer Ort nach Standort";
  }
  if (group.kind === "ohne") return "keine Karte, nur der Tag";
  const onSelected = group.place?.id === selectedPlaceId && group.day === activeDay;
  if (onSelected) return "ausgewählt · Standort passt";
  if (group.distanceM != null) return `Standort passt (${Math.round(group.distanceM)} m)`;
  return "Standort passt";
}

export function otherDayLabel(vacation, day, activeDay) {
  if (!day || day === activeDay) return "";
  return dayCaption(vacation, day);
}

export function otherDaySummary(groups, activeDay) {
  const counts = new Map();
  for (const group of groups) {
    if (group.day === activeDay) continue;
    counts.set(group.day, (counts.get(group.day) || 0) + group.photoKeys.length);
  }
  return [...counts.entries()].map(([day, count]) => {
    const label = count === 1 ? "1 Foto" : `${count} Fotos`;
    return `${label} am ${dayChipDateLine(day)}`;
  });
}

export function mergeAssignableGroups(groups) {
  const out = [];
  for (const group of groups) {
    const mergeKey =
      group.kind === "place"
        ? `place:${group.place?.id}:${group.ohneGps ? "nogps" : "gps"}`
        : group.kind === "ohne"
          ? `ohne:${group.day}`
          : group.id;
    const hit = group.kind === "new" ? null : out.find((item) => item.mergeKey === mergeKey);
    if (hit) {
      hit.photoKeys.push(...group.photoKeys);
      if (group.ohneGps) hit.ohneGps = true;
      if (group.ts && (hit.ts == null || group.ts < hit.ts)) hit.ts = group.ts;
    } else {
      out.push({ ...group, mergeKey, photoKeys: [...group.photoKeys] });
    }
  }
  return out;
}
