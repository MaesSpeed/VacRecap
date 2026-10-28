import { CloudNetworkError, CloudOfflineError, isFetchNetworkFailure } from "./cloud-errors.js";
import { BUCKET_ORIGINALS, BUCKET_THUMBS, mediaStoragePath } from "./cloud-media-paths.js";
import { insertMediaRow, updateMediaRow } from "./db.js";
import { getSupabase } from "./supabase-client.js";
import { createId } from "./utils.js";

const RETRY_DELAYS_MS = [500, 1500, 3500];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function uploadBlobWithRetry(bucket, path, blob, contentType) {
  const supabase = getSupabase();
  let lastErr = null;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (!navigator.onLine) throw new CloudOfflineError();
    try {
      const { error } = await supabase.storage.from(bucket).upload(path, blob, {
        contentType,
        upsert: true,
      });
      if (error) throw error;
      return;
    } catch (err) {
      lastErr = err;
      if (!navigator.onLine || isFetchNetworkFailure(err)) {
        throw new CloudOfflineError();
      }
      if (attempt < RETRY_DELAYS_MS.length - 1) {
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw lastErr || new CloudNetworkError();
}

export async function uploadCloudPhoto({
  place,
  vacationId,
  day,
  ts = Date.now(),
  originalBlob,
  thumbBlob,
  width,
  height,
  sourceKey = null,
  onStatus,
}) {
  const mediaId = createId();
  const path = mediaStoragePath(vacationId, mediaId);
  const record = {
    id: mediaId,
    placeId: place.id,
    vacationId,
    day,
    ts,
    type: "photo",
    uploadStatus: "pending",
    storagePath: path,
    thumbPath: path,
    mime: "image/jpeg",
    w: width,
    h: height,
    sizeBytes: originalBlob.size,
    sourceKey,
  };

  onStatus?.({ phase: "db", mediaId, status: "pending" });
  await insertMediaRow(record);

  try {
    onStatus?.({ phase: "thumb", mediaId, status: "uploading" });
    await uploadBlobWithRetry(BUCKET_THUMBS, path, thumbBlob, "image/jpeg");
    onStatus?.({ phase: "original", mediaId, status: "uploading" });
    await uploadBlobWithRetry(BUCKET_ORIGINALS, path, originalBlob, "image/jpeg");
    record.uploadStatus = "uploaded";
    await updateMediaRow(mediaId, { upload_status: "uploaded" });
    onStatus?.({ phase: "done", mediaId, status: "uploaded" });
    return record;
  } catch (err) {
    record.uploadStatus = "failed";
    await updateMediaRow(mediaId, { upload_status: "failed" }).catch(() => {});
    onStatus?.({ phase: "failed", mediaId, status: "failed", error: err });
    throw err;
  }
}

export async function retryCloudPhotoUpload(media, { originalBlob, thumbBlob, onStatus }) {
  const path = media.storagePath || mediaStoragePath(media.vacationId, media.id);
  await updateMediaRow(media.id, { upload_status: "pending" });
  try {
    onStatus?.({ phase: "thumb", mediaId: media.id, status: "uploading" });
    await uploadBlobWithRetry(BUCKET_THUMBS, path, thumbBlob, "image/jpeg");
    onStatus?.({ phase: "original", mediaId: media.id, status: "uploading" });
    await uploadBlobWithRetry(BUCKET_ORIGINALS, path, originalBlob, "image/jpeg");
    await updateMediaRow(media.id, { upload_status: "uploaded" });
    onStatus?.({ phase: "done", mediaId: media.id, status: "uploaded" });
    return { ...media, uploadStatus: "uploaded" };
  } catch (err) {
    await updateMediaRow(media.id, { upload_status: "failed" }).catch(() => {});
    onStatus?.({ phase: "failed", mediaId: media.id, status: "failed", error: err });
    throw err;
  }
}
