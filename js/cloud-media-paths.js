export function mediaStoragePath(tripId, mediaId) {
  return `${tripId}/${mediaId}.jpg`;
}

export const BUCKET_ORIGINALS = "media-originals";
export const BUCKET_THUMBS = "media-thumbs";
