import { photoKeptMessage } from "./cloud-errors.js";
import { defaultActiveDay } from "./days.js";
import { resolveGalleryPhotoTarget } from "./target-place.js";
import { saveTripSelection, loadTripSelection } from "./trip-selection-store.js";
import { showToast, showWarnToast } from "./toast.js";
import { openPhotoUploadSheet } from "./ui-photo-upload-sheet.js";

const VIDEO_NAME = /\.(mov|mp4|m4v|webm|hevc)$/i;

export function splitGalleryFiles(files) {
  const all = [...(files || [])];
  const hasVideo = all.some(
    (file) => file.type?.startsWith("video/") || VIDEO_NAME.test(file.name || "")
  );
  const images = all.filter((file) => file.type?.startsWith("image/"));
  return { hasVideo, images };
}

/**
 * Gleicher Pfad wie der Galerie-Input der Reise: Mehrfachauswahl, Video-Hinweis,
 * Ziel = gewählter Ort (sonst Fallback), EXIF/HEIC im Upload-Sheet.
 */
export async function startGalleryPhotoUpload({
  vacation,
  vacationId,
  files,
  day,
  selectedPlaceId,
  onDone,
}) {
  const { hasVideo, images } = splitGalleryFiles(files);
  if (hasVideo) {
    showToast("Videos kommen in einem späteren Paket.", { icon: "none" });
  }
  if (!images.length) return null;
  const activeDay = day || (vacation ? defaultActiveDay(vacation) : null);
  if (!activeDay) {
    showWarnToast("Foto konnte nicht zugeordnet werden.");
    return null;
  }

  async function createTarget() {
    const target = await resolveGalleryPhotoTarget({
      vacationId,
      day: activeDay,
      selectedPlaceId,
    });
    const saved = (await loadTripSelection(vacationId)) || {
      selectedByDay: {},
      activeDay,
    };
    saved.activeDay = activeDay;
    saved.selectedByDay = { ...(saved.selectedByDay || {}), [activeDay]: target.place.id };
    await saveTripSelection(vacationId, saved);
    return target;
  }

  try {
    const target = await createTarget();
    openPhotoUploadSheet({
      files: images,
      place: target.place,
      vacationId,
      day: activeDay,
      onDone,
    });
    return target;
  } catch (err) {
    const message = photoKeptMessage(err);
    showWarnToast(message);
    openPhotoUploadSheet({
      files: images,
      place: null,
      vacationId,
      day: activeDay,
      heldMessage: message,
      ensurePlace: async () => (await createTarget()).place,
      onDone,
    });
    return null;
  }
}
