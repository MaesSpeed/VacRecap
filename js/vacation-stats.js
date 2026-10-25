import { getAllMediaForVacation, getNotesForPlace, getPlacesForVacation } from "./db.js";

export function formatCountLabel(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural}`;
}

export async function computeVacationStats(vacationId) {
  const places = (await getPlacesForVacation(vacationId)).filter((p) => !p.soft);
  const media = await getAllMediaForVacation(vacationId);
  let notes = 0;
  for (const p of places) {
    notes += (await getNotesForPlace(p.id)).length;
  }
  const photos = media.filter((m) => m.type !== "video").length;
  const videos = media.filter((m) => m.type === "video").length;
  return {
    places: places.length,
    photos,
    videos,
    media: photos + videos,
    notes,
  };
}

export function formatVacationStatsLine(stats) {
  const parts = [formatCountLabel(stats.places, "Ort", "Orte")];
  if (stats.photos > 0) {
    parts.push(formatCountLabel(stats.photos, "Foto", "Fotos"));
  }
  if (stats.videos > 0) {
    parts.push(formatCountLabel(stats.videos, "Video", "Videos"));
  }
  if (stats.notes > 0) {
    parts.push(formatCountLabel(stats.notes, "Notiz", "Notizen"));
  }
  return parts.join(" · ");
}
