import { normalizePresetId } from "./covers.js";
import { clampTitle } from "./utils.js";

export function coverFromTripRow(row) {
  const presetId = normalizePresetId(row?.cover_preset);
  const mediaId = row?.cover_media_id || null;
  if (mediaId) return { type: "media", mediaId, presetId };
  return { type: "preset", presetId };
}

export function coverMediaIdForVacation(vacation) {
  if (vacation?.cover?.type !== "media" || !vacation.cover.mediaId) return null;
  return vacation.cover.mediaId;
}

export function coverPresetForVacation(vacation) {
  return normalizePresetId(vacation?.cover?.presetId);
}

export function tripRowToVacation(row) {
  if (!row) return null;
  const companions = Array.isArray(row.companions) ? row.companions : [];
  return {
    id: row.id,
    createdAt: Date.parse(row.created_at) || Date.now(),
    updatedAt: Date.parse(row.updated_at) || Date.now(),
    author: row.created_by,
    title: row.title || "",
    startDate: row.start_date || "",
    endDate: row.end_date || "",
    cover: coverFromTripRow(row),
    companions: { tags: [], names: companions },
    stats: { places: 0, photos: 0, notes: 0 },
  };
}

export function vacationToTripRow(vacation) {
  const names = vacation.companions?.names?.filter(Boolean) ?? [];
  const row = {
    title: clampTitle(vacation.title || "") || "Reise",
    start_date: vacation.startDate || null,
    end_date: vacation.endDate || null,
    companions: names,
    cover_media_id: coverMediaIdForVacation(vacation),
    cover_preset: coverPresetForVacation(vacation),
  };
  if (vacation.id) row.id = vacation.id;
  return row;
}

export function waypointRowToPlace(row) {
  const day = row.day || "";
  const ts = Date.parse(row.visited_at) || Date.now();
  return {
    id: row.id,
    createdAt: Date.parse(row.created_at) || ts,
    updatedAt: Date.parse(row.updated_at) || ts,
    author: row.created_by,
    vacationId: row.trip_id,
    day,
    dayDate: day,
    ts,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    accuracy: row.accuracy_m ?? null,
    name: row.title || "",
    title: row.title || "",
    soft: Boolean(row.is_soft),
    source: row.source || "manual",
    kind: row.is_soft ? "soft" : "place",
    mediaIds: [],
    noteIds: [],
    rememberCount: 0,
    rememberFirstTs: null,
    rememberLastTs: null,
  };
}

const DB_WAYPOINT_SOURCES = new Set(["manual", "gps", "photo", "import"]);

/**
 * waypoints_source_check: nur manual | gps | photo | import.
 * App-Quellen capture / ohne-ort / open gibt es in der Datenbank nicht.
 */
export function waypointSourceForDb(place) {
  const source = place?.source || "manual";
  if (DB_WAYPOINT_SOURCES.has(source)) return source;
  if (source === "capture") return "photo";
  if (source === "open") return "gps";
  if (source === "ohne-ort") return "manual";
  if (place?.lat != null && place?.lng != null) return "gps";
  return "manual";
}

export function placeToWaypointRow(place) {
  const row = {
    trip_id: place.vacationId,
    day: place.day || place.dayDate,
    visited_at: new Date(place.ts || Date.now()).toISOString(),
    lat: place.lat ?? null,
    lng: place.lng ?? null,
    accuracy_m: place.accuracy ?? null,
    title: clampTitle(place.name || place.title || ""),
    is_soft: Boolean(place.soft),
    source: waypointSourceForDb(place),
  };
  if (place.id) row.id = place.id;
  return row;
}

export function noteRowToApp(row) {
  const createdAt = Date.parse(row.created_at) || Date.now();
  return {
    id: row.id,
    placeId: row.waypoint_id,
    vacationId: row.trip_id,
    day: row.day,
    createdAt,
    ts: Date.parse(row.updated_at) || createdAt,
    text: row.body || "",
    author: row.created_by,
  };
}

export function noteToRow(note) {
  const row = {
    trip_id: note.vacationId,
    waypoint_id: note.placeId || null,
    day: note.day,
    body: (note.text || "").trim(),
    updated_at: new Date().toISOString(),
  };
  if (note.id) row.id = note.id;
  return row;
}

export function mediaRowToApp(row) {
  if (!row) return null;
  const ts = Date.parse(row.taken_at) || Date.parse(row.created_at) || Date.now();
  return {
    id: row.id,
    placeId: row.waypoint_id,
    vacationId: row.trip_id,
    day: row.day,
    ts,
    type: row.kind === "video" ? "video" : "photo",
    uploadStatus: row.upload_status || "uploaded",
    storagePath: row.storage_path || null,
    thumbPath: row.thumb_path || null,
    mime: row.mime || "image/jpeg",
    w: row.width ?? null,
    h: row.height ?? null,
    sizeBytes: row.size_bytes ?? null,
    sourceKey: row.source_key ?? null,
    author: row.created_by ?? null,
    deletedAt: row.deleted_at || null,
  };
}

export function mediaToRow(media) {
  return {
    id: media.id,
    trip_id: media.vacationId,
    waypoint_id: media.placeId,
    day: media.day,
    taken_at: media.ts ? new Date(media.ts).toISOString() : null,
    kind: media.type === "video" ? "video" : "photo",
    storage_path: media.storagePath ?? null,
    thumb_path: media.thumbPath ?? null,
    mime: media.mime ?? "image/jpeg",
    size_bytes: media.sizeBytes ?? null,
    width: media.w ?? null,
    height: media.h ?? null,
    upload_status: media.uploadStatus ?? "pending",
    source_key: media.sourceKey ?? null,
  };
}
