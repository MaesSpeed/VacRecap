let session = null;

export function createMediathekSession({ vacationId, day, selectedPlaceId, files }) {
  const items = [...files].map((file, index) => ({
    id: `m-${index}-${file.lastModified}`,
    file,
    sourceKey: `${file.name}|${file.size}|${file.lastModified}`,
    type: file.type.startsWith("video/") ? "video" : "photo",
    thumbUrl: null,
    durationLabel: null,
    ready: false,
  }));
  session = {
    vacationId,
    day,
    selectedPlaceId,
    items,
    selectedIds: items.map((i) => i.id),
    place: null,
    ohneOrtPending: false,
    saving: false,
  };
  return session;
}

export function getMediathekSession() {
  return session;
}

export function clearMediathekSession() {
  if (session) {
    session.items.forEach((i) => {
      if (i.thumbUrl) URL.revokeObjectURL(i.thumbUrl);
    });
  }
  session = null;
}

export function setMediathekPlace(place, { ohneOrtPending = false } = {}) {
  if (!session) return;
  session.place = place;
  session.ohneOrtPending = ohneOrtPending;
  if (place) session.selectedPlaceId = place.id;
}
