import { CLOUD_MEDIA_ENABLED } from "./config.js";
import { uploadCloudPhoto } from "./cloud-photo-upload.js";
import { getMediaBySourceKey } from "./db.js";
import { processPhotoForCloud } from "./media-process.js";
import { pullPlaceTimeEarlier } from "./place-service.js";

export async function savePhotoForPlace({
  file,
  place,
  vacationId,
  day,
  ts = null,
  sourceKey,
  onStatus,
}) {
  if (!CLOUD_MEDIA_ENABLED) {
    throw new Error("Cloud-Fotos sind deaktiviert.");
  }
  if (sourceKey) {
    const existing = await getMediaBySourceKey(vacationId, sourceKey);
    if (existing) return existing;
  }
  const processed = await processPhotoForCloud(file);
  const ownTime = processed.takenAt ?? null;
  if (ownTime != null && place) {
    const next = await pullPlaceTimeEarlier(place, ownTime);
    if (next) {
      place.ts = next.ts;
      place.remoteUpdatedAt = next.remoteUpdatedAt;
    }
  }
  try {
    return await uploadCloudPhoto({
      place,
      vacationId,
      day,
      ts: ownTime,
      originalBlob: processed.blob,
      thumbBlob: processed.thumbBlob,
      width: processed.w,
      height: processed.h,
      sourceKey,
      onStatus,
    });
  } finally {
    processed.blob = null;
    processed.thumbBlob = null;
  }
}

export async function saveVideoForPlace() {
  throw new Error("Videos kommen in einem späteren Paket.");
}
