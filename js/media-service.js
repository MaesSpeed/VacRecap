import {
  putMedia,
  requestPersistentStorage,
} from "./db.js";
import { processPhotoFile, processVideoFile } from "./media-process.js";
import { createId } from "./utils.js";

let persistRequested = false;

async function ensurePersist() {
  if (persistRequested) return;
  persistRequested = true;
  await requestPersistentStorage();
}

function isQuotaError(err) {
  return (
    err?.name === "QuotaExceededError" ||
    err?.code === 22 ||
    err?.code === 20
  );
}

export async function savePhotoForPlace({ file, place, vacationId, day }) {
  await ensurePersist();
  const processed = await processPhotoFile(file);
  const record = {
    id: createId(),
    placeId: place.id,
    vacationId,
    day,
    ts: Date.now(),
    type: "photo",
    blob: processed.blob,
    thumbBlob: processed.thumbBlob,
    w: processed.w,
    h: processed.h,
  };
  try {
    await putMedia(record);
    return record;
  } catch (err) {
    if (isQuotaError(err)) throw Object.assign(new Error("quota"), { quota: true });
    throw err;
  }
}

export async function saveVideoForPlace({ file, place, vacationId, day }) {
  await ensurePersist();
  const processed = await processVideoFile(file);
  const record = {
    id: createId(),
    placeId: place.id,
    vacationId,
    day,
    ts: Date.now(),
    type: "video",
    blob: processed.blob,
    thumbBlob: processed.thumbBlob,
    w: processed.w,
    h: processed.h,
    duration: processed.duration,
    durationLabel: processed.durationLabel,
  };
  try {
    await putMedia(record);
    return record;
  } catch (err) {
    if (isQuotaError(err)) throw Object.assign(new Error("quota"), { quota: true });
    throw err;
  }
}
