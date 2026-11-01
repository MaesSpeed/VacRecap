import { haversineMeters } from "./geo.js";
import { createId } from "./utils.js";

export function normalizePlace(raw) {
  const day = raw.day || raw.dayDate || "";
  return {
    id: raw.id || createId(),
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? Date.now(),
    author: raw.author ?? "ich",
    remoteUpdatedAt: raw.remoteUpdatedAt || null,
    updatedBy: raw.updatedBy || null,
    vacationId: raw.vacationId,
    day,
    dayDate: day,
    ts: raw.ts ?? raw.createdAt ?? Date.now(),
    lat: raw.lat ?? null,
    lng: raw.lng ?? null,
    accuracy: raw.accuracy ?? null,
    name: raw.name ?? raw.title ?? "",
    title: raw.name ?? raw.title ?? "",
    soft: Boolean(raw.soft),
    source: raw.source ?? "manual",
    kind: raw.soft ? "soft" : "place",
    mediaIds: raw.mediaIds ?? [],
    noteIds: raw.noteIds ?? [],
    rememberCount: raw.rememberCount ?? 0,
    rememberFirstTs: raw.rememberFirstTs ?? null,
    rememberLastTs: raw.rememberLastTs ?? null,
  };
}

export function createPlace({
  vacationId,
  day,
  ts = Date.now(),
  lat,
  lng,
  accuracy,
  name,
  soft = false,
  source = "manual",
  rememberCount = 0,
  rememberFirstTs = null,
  rememberLastTs = null,
}) {
  const now = Date.now();
  return normalizePlace({
    id: createId(),
    createdAt: now,
    updatedAt: now,
    author: "ich",
    vacationId,
    day,
    ts,
    lat,
    lng,
    accuracy,
    name,
    soft,
    source,
    rememberCount,
    rememberFirstTs,
    rememberLastTs,
  });
}

export function sortPlacesChronologicalDesc(places) {
  return places.slice().sort((a, b) => b.ts - a.ts);
}

export function newestHardPlace(places) {
  return sortPlacesChronologicalDesc(places).find((p) => !p.soft) ?? null;
}

export function findPlaceWithinMeters(places, lat, lng, meters = 150) {
  return places.find(
    (p) =>
      p.lat != null &&
      p.lng != null &&
      haversineMeters(lat, lng, p.lat, p.lng) <= meters
  );
}
