import { P, plan } from "./recap-duration.js";

function round1(n) {
  return Math.round(n * 10) / 10;
}

function byTimeThenId(a, b, time) {
  const delta = time(a) - time(b);
  if (delta) return delta;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Baut den Video-Entwurf aus Orten, Fotos und Notizen.
 * places: { id, day, name, ts, soft }
 * photos: { id, placeId, ts, type, uploadStatus }
 * notes: { id, placeId, createdAt, ts }
 */
export function buildVideoRecap({ places = [], photos = [], notes = [] } = {}) {
  const hard = places
    .filter((place) => place && !place.soft && place.id)
    .slice()
    .sort((a, b) => byTimeThenId(a, b, (item) => item.ts || 0));
  const hardIds = new Set(hard.map((place) => place.id));
  const photosByPlace = new Map();
  const notesByPlace = new Map();
  for (const photo of photos) {
    if (!photo?.id || !hardIds.has(photo.placeId)) continue;
    if (photo.type === "video") continue;
    const status = photo.uploadStatus || "uploaded";
    if (status !== "uploaded") continue;
    if (!photosByPlace.has(photo.placeId)) photosByPlace.set(photo.placeId, []);
    photosByPlace.get(photo.placeId).push(photo);
  }
  for (const note of notes) {
    if (!note?.id || !hardIds.has(note.placeId)) continue;
    if (!notesByPlace.has(note.placeId)) notesByPlace.set(note.placeId, []);
    notesByPlace.get(note.placeId).push(note);
  }
  const inputs = hard.map((place) => ({
    photos: photosByPlace.get(place.id)?.length || 0,
    notes: notesByPlace.get(place.id)?.length || 0,
  }));
  const counts = {
    photos: inputs.reduce((sum, item) => sum + item.photos, 0),
    places: hard.length,
    notes: inputs.reduce((sum, item) => sum + item.notes, 0),
  };
  if (counts.photos < P.minPhotos) {
    return { ok: false, reason: "too-few-photos", counts };
  }
  const planned = plan(inputs);
  if (!planned.ok) return { ok: false, reason: planned.reason || "too-few-photos", counts };
  const scenes = [{ type: "title", seconds: P.introS }];
  hard.forEach((place, index) => {
    const chosenPhotos = (photosByPlace.get(place.id) || [])
      .slice()
      .sort((a, b) => byTimeThenId(a, b, (item) => item.ts || 0))
      .slice(0, planned.photosPerPlace);
    const chosenNotes = (notesByPlace.get(place.id) || [])
      .slice()
      .sort((a, b) => byTimeThenId(a, b, (item) => item.createdAt ?? item.ts ?? 0))
      .slice(0, P.maxNotesPerPlace);
    const seconds = round1(
      P.perPlaceS + chosenPhotos.length * planned.perPhotoS + chosenNotes.length * P.perNoteS
    );
    scenes.push({
      type: "place",
      date: place.day || "",
      waypoint_id: place.id,
      media_ids: chosenPhotos.map((photo) => photo.id),
      note_ids: chosenNotes.map((note) => note.id),
      seconds,
      _index: index,
    });
  });
  scenes.push({ type: "outro", seconds: P.outroS });
  const content = {
    formula: {
      perPhotoS: planned.perPhotoS,
      perPlaceS: P.perPlaceS,
      perNoteS: P.perNoteS,
      photosPerPlace: planned.photosPerPlace,
      minS: P.minS,
      maxS: P.maxS,
    },
    counts,
    seconds: planned.seconds,
    scenes: scenes.map((scene) => {
      if (scene.type !== "place") return { type: scene.type, seconds: scene.seconds };
      return {
        type: "place",
        date: scene.date,
        waypoint_id: scene.waypoint_id,
        media_ids: scene.media_ids,
        note_ids: scene.note_ids,
        seconds: scene.seconds,
      };
    }),
  };
  return { ok: true, counts, content, label: planned.label, photosUsed: planned.photosUsed };
}
