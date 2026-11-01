import { updateMediaPlacement } from "./db.js";
import { canEditItem } from "./trip-role.js";

/** Eigenes, hochgeladenes Foto. Fremde Zeilen und Videos bleiben liegen. */
export function mediaOwnedBy(media, userId) {
  if (!media || !userId) return false;
  if (media.author !== userId) return false;
  if (media.type === "video") return false;
  return (media.uploadStatus || "uploaded") === "uploaded";
}

/** Bildunterschrift: nur eigene Fotos, und nur wenn die Rolle dieses Foto ändern darf. */
export function canCaptionMedia(media, role, userId) {
  if (!canEditItem(role, media, userId)) return false;
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
      const source = photos.find((item) => item.id === snap.id);
      const mapped = await updateMediaPlacement(snap.id, {
        waypointId,
        day,
        remoteUpdatedAt: source?.remoteUpdatedAt || null,
      });
      snap.afterUpdatedAt = mapped?.remoteUpdatedAt || null;
      if (source && mapped?.remoteUpdatedAt) source.remoteUpdatedAt = mapped.remoteUpdatedAt;
      applied.push(snap);
    }
    return previous;
  } catch (err) {
    let undoFailed = false;
    for (const snap of applied) {
      try {
        await updateMediaPlacement(snap.id, {
        waypointId: snap.waypoint_id,
        day: snap.day,
        remoteUpdatedAt: snap.afterUpdatedAt || null,
      });
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
      await updateMediaPlacement(snap.id, {
        waypointId: snap.placeId,
        day: snap.day,
        remoteUpdatedAt: snap.remoteUpdatedAt || snap.afterUpdatedAt || null,
      });
      applied.push(snap.id);
    }
    return applied;
  } catch (err) {
    const wrapped = err instanceof Error ? err : new Error("Rückgängig ist fehlgeschlagen.");
    wrapped.restoredIds = applied;
    throw wrapped;
  }
}
