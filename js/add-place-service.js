import { CloudNetworkError, CloudOfflineError } from "./cloud-errors.js";
import {
  deletePlace,
  getAssignablePhotos,
  getNotesForVacation,
  getPlace,
  getPlacesForVacation,
  listPlaceAttachmentIds,
  putPlace,
  restorePlace,
  updateMediaPlacement,
} from "./db.js";
import { fallbackPlaceName } from "./geo.js";
import { moveNoteToPlace } from "./note-service.js";
import { mediaOwnedBy } from "./photo-move.js";
import { createPlace } from "./places.js";
import { clampTitle } from "./utils.js";

const OHNE_ORT = "Ohne Ort";

let commitInflight = null;

export function isOhneOrtPlace(place) {
  return Boolean(place) && !place.soft && place.name === OHNE_ORT && place.lat == null && place.lng == null;
}

export function noteOwnedBy(note, userId) {
  return Boolean(note && userId && note.author === userId);
}

export function addPlaceErrorMessage(err) {
  if (!navigator.onLine || err instanceof CloudOfflineError) {
    return "Du bist offline. Änderungen sind erst wieder online möglich.";
  }
  if (err instanceof CloudNetworkError) {
    return "Der Ort konnte nicht angelegt werden. Bitte Verbindung prüfen.";
  }
  const msg = String(err?.message || "");
  if (msg.startsWith("Der Ort konnte nicht") || msg.startsWith("Dafür fehlt")) return msg;
  return "Der Ort konnte nicht angelegt werden. Bitte erneut versuchen.";
}

function placeDay(place) {
  return place?.day || place?.dayDate || "";
}

const ASSIGN_RETRY_MS = 600;

async function readAssignableOnce(vacationId) {
  const [places, photos, notes] = await Promise.allSettled([
    getPlacesForVacation(vacationId),
    getAssignablePhotos(vacationId),
    getNotesForVacation(vacationId),
  ]);
  return { places, photos, notes };
}

function preferFulfilled(first, second) {
  if (second?.status === "fulfilled") return second;
  return first;
}

export async function loadAssignableContent(vacationId) {
  let result = await readAssignableOnce(vacationId);
  const failed = (slot) => !slot || slot.status !== "fulfilled";
  if (failed(result.places) || failed(result.photos) || failed(result.notes)) {
    await new Promise((resolve) => setTimeout(resolve, ASSIGN_RETRY_MS));
    const retry = await readAssignableOnce(vacationId);
    result = {
      places: preferFulfilled(result.places, retry.places),
      photos: preferFulfilled(result.photos, retry.photos),
      notes: preferFulfilled(result.notes, retry.notes),
    };
  }
  const places = result.places.status === "fulfilled" ? result.places.value.filter((place) => !place.soft) : [];
  const photos = result.photos.status === "fulfilled" ? result.photos.value : [];
  const notes = result.notes.status === "fulfilled" ? result.notes.value : [];
  const loadFailed = failed(result.places) || failed(result.photos) || failed(result.notes);
  return { places, photos, notes, loadFailed };
}

export function groupAssignableContent({ places, photos, notes, day, userId }) {
  const byPlace = new Map();
  for (const place of places) {
    byPlace.set(place.id, { place, photos: [], notes: [] });
  }
  for (const photo of photos) {
    if (!photo || photo.type === "video") continue;
    const group = byPlace.get(photo.placeId);
    if (group) group.photos.push(photo);
  }
  for (const note of notes) {
    const group = note?.placeId ? byPlace.get(note.placeId) : null;
    if (group) group.notes.push(note);
  }
  const groups = [...byPlace.values()].filter((group) => group.photos.length || group.notes.length);
  groups.sort((a, b) => {
    const aHere = placeDay(a.place) === day ? 0 : 1;
    const bHere = placeDay(b.place) === day ? 0 : 1;
    if (aHere !== bHere) return aHere - bHere;
    const aOhne = isOhneOrtPlace(a.place) ? 0 : 1;
    const bOhne = isOhneOrtPlace(b.place) ? 0 : 1;
    if (aOhne !== bOhne) return aOhne - bOhne;
    return (a.place.ts || 0) - (b.place.ts || 0);
  });
  const selectedPhotoIds = new Set();
  const selectedNoteIds = new Set();
  for (const group of groups) {
    if (placeDay(group.place) !== day || !isOhneOrtPlace(group.place)) continue;
    for (const photo of group.photos) {
      if (mediaOwnedBy(photo, userId)) selectedPhotoIds.add(photo.id);
    }
    for (const note of group.notes) {
      if (noteOwnedBy(note, userId)) selectedNoteIds.add(note.id);
    }
  }
  return { groups, selectedPhotoIds, selectedNoteIds };
}

function summaryLine(name, photoCount, noteCount) {
  const bits = [];
  if (photoCount) bits.push(`${photoCount} Foto${photoCount === 1 ? "" : "s"}`);
  if (noteCount) bits.push(`${noteCount} Notiz${noteCount === 1 ? "" : "en"}`);
  return bits.length ? `${name} · ${bits.join(", ")}` : name;
}

function snapshotNote(note) {
  return {
    id: note.id,
    placeId: note.placeId || null,
    vacationId: note.vacationId,
    day: note.day,
    text: note.text || "",
    ts: note.ts,
    author: note.author,
  };
}

async function removeOhneOrtIfEmpty(placeId) {
  const place = await getPlace(placeId);
  if (!isOhneOrtPlace(place)) return null;
  const { mediaIds, noteIds } = await listPlaceAttachmentIds(placeId);
  if (mediaIds.length || noteIds.length) return null;
  await deletePlace(placeId);
  return place;
}

async function commitBackfilledPlaceNow({ vacationId, day, lat, lng, name, ts, photos, notes }) {
  const title = clampTitle(name) || fallbackPlaceName(ts);
  const created = createPlace({
    vacationId,
    day,
    ts,
    lat,
    lng,
    name: title,
    soft: false,
    source: "manual",
  });
  const place = await putPlace(created);
  const appliedMedia = [];
  const appliedNotes = [];
  const removedPlaces = [];
  try {
    for (const photo of photos) {
      const placement = {
        waypointId: place.id,
        day,
      };
      if (!photo.hasOwnTime) placement.takenAt = ts;
      await updateMediaPlacement(photo.id, placement);
      appliedMedia.push({
        id: photo.id,
        placeId: photo.placeId,
        day: photo.day,
        hasOwnTime: Boolean(photo.hasOwnTime),
      });
    }
    for (const note of notes) {
      const snap = snapshotNote(note);
      await moveNoteToPlace(note, place, { day, vacationId });
      appliedNotes.push(snap);
    }
    const sourceIds = new Set(
      [...appliedMedia.map((item) => item.placeId), ...appliedNotes.map((item) => item.placeId)].filter(Boolean)
    );
    for (const sourceId of sourceIds) {
      const removed = await removeOhneOrtIfEmpty(sourceId);
      if (removed) removedPlaces.push(removed);
    }
  } catch (err) {
    await rollbackPartial({ placeId: place.id, appliedMedia, appliedNotes, removedPlaces });
    throw err;
  }
  return {
    place,
    summaryLine: summaryLine(place.name, appliedMedia.length, appliedNotes.length),
    snapshot: {
      placeId: place.id,
      vacationId,
      day,
      media: appliedMedia,
      notes: appliedNotes,
      removedPlaces,
    },
  };
}

async function rollbackPartial({ placeId, appliedMedia, appliedNotes, removedPlaces }) {
  for (const removed of removedPlaces) {
    try {
      await restorePlace(removed);
    } catch {
      /* der ursprüngliche Fehler bleibt führend */
    }
  }
  for (const snap of appliedMedia) {
    try {
      const placement = { waypointId: snap.placeId, day: snap.day };
      if (!snap.hasOwnTime) placement.takenAt = null;
      await updateMediaPlacement(snap.id, placement);
    } catch {
      /* siehe oben */
    }
  }
  for (const note of appliedNotes) {
    try {
      await moveNoteToPlace(note, { id: note.placeId }, { day: note.day, vacationId: note.vacationId });
    } catch {
      /* siehe oben */
    }
  }
  try {
    await deletePlace(placeId);
  } catch {
    /* siehe oben */
  }
}

export function commitBackfilledPlace(input) {
  if (commitInflight) return commitInflight;
  commitInflight = commitBackfilledPlaceNow(input).finally(() => {
    commitInflight = null;
  });
  return commitInflight;
}

export async function undoBackfilledPlace(snapshot) {
  if (!snapshot?.placeId) return;
  const failures = [];
  for (const removed of snapshot.removedPlaces || []) {
    try {
      await restorePlace(removed);
    } catch (err) {
      failures.push(err);
    }
  }
  for (const snap of snapshot.media || []) {
    try {
      const placement = { waypointId: snap.placeId, day: snap.day };
      if (!snap.hasOwnTime) placement.takenAt = null;
      await updateMediaPlacement(snap.id, placement);
    } catch (err) {
      failures.push(err);
    }
  }
  for (const note of snapshot.notes || []) {
    try {
      await moveNoteToPlace(note, { id: note.placeId }, { day: note.day, vacationId: note.vacationId });
    } catch (err) {
      failures.push(err);
    }
  }
  try {
    await deletePlace(snapshot.placeId);
  } catch (err) {
    failures.push(err);
  }
  if (failures.length) {
    const err = failures[0] instanceof Error ? failures[0] : new Error("Rückgängig ist fehlgeschlagen.");
    throw err;
  }
}
