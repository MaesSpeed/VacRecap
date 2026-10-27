const thumbDecodeFailedIds = new Set();

export function isThumbDecodeFailed(mediaId) {
  return thumbDecodeFailedIds.has(mediaId);
}

export function markThumbDecodeFailed(mediaId) {
  if (mediaId) thumbDecodeFailedIds.add(mediaId);
}

export function clearThumbDecodeFailed(mediaId) {
  if (mediaId) thumbDecodeFailedIds.delete(mediaId);
}
