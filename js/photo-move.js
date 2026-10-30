import { updateMediaPlacement } from "./db.js";
import { canEditTripMedia } from "./trip-role.js";

/** Eigenes, hochgeladenes Foto. Fremde Zeilen und Videos bleiben liegen. */
export function mediaOwnedBy(media, userId) {
  if (!media || !userId) return false;
  if (media.author !== userId) return false;
  if (media.type === "video") return false;
  return (media.uploadStatus || "uploaded") === "uploaded";
}

/** Bildunterschrift: nur eigene Fotos, und nur Owner/Editor wie beim übrigen Medien-Update. */
export function canCaptionMedia(media, role, userId) {
  if (!canEditTripMedia(role)) return false;
  return mediaOwnedBy(media, userId);
}

/**
 * Schreibt nur die Orts- und Tag-Referenz.
 * Schlägt ein Update fehl, werden die bereits verschobenen IDs zurückgesetzt.
 * Der Autor bleibt auf dem Server, weil created_by nicht im Patch steht.
 */
export async function movePhotosToPlace(photos, place) {
  const day = place?.day || place?.dayDate;
  const waypointId = place?.id;
  if (!waypointId || !day) throw new Error("Zielort fehlt.");
  const previous = photos.map((media) => ({
    id: media.id,
    waypoint_id: media.placeId,
    day: media.day,
  }));
  const applied = [];
  try {
    for (const snap of previous) {
      if (!snap.id) continue;
      await updateMediaPlacement(snap.id, { waypointId, day });
      applied.push(snap);
    }
    return previous;
  } catch (err) {
    let undoFailed = false;
    for (const snap of applied) {
      try {
        await updateMediaPlacement(snap.id, { waypointId: snap.waypoint_id, day: snap.day });
      } catch {
        undoFailed = true;
      }
    }
    const wrapped = err instanceof Error ? err : new Error("Die Fotos konnten nicht verschoben werden.");
    wrapped.placementRolledBack = !undoFailed;
    throw wrapped;
  }
}

/** Stellt genau diese Schnappschüsse wieder her, keine anderen Fotos. */
export async function restorePhotoPlacement(snapshots) {
  const applied = [];
  try {
    for (const snap of snapshots) {
      if (!snap?.id) continue;
      await updateMediaPlacement(snap.id, { waypointId: snap.placeId, day: snap.day });
      applied.push(snap.id);
    }
    return applied;
  } catch (err) {
    const wrapped = err instanceof Error ? err : new Error("Rückgängig ist fehlgeschlagen.");
    wrapped.restoredIds = applied;
    throw wrapped;
  }
}
