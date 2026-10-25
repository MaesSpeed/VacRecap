import { formatTimeFromTs } from "./geo.js";

function rememberMetaPart(place) {
  const count = place.rememberCount ?? 0;
  if (count <= 0) return null;
  const first = place.rememberFirstTs ?? place.ts;
  const last = place.rememberLastTs ?? place.ts;
  if (count >= 2) {
    return `${formatTimeFromTs(first)}–${formatTimeFromTs(last)} · ${count}× Ort gemerkt`;
  }
  return `${formatTimeFromTs(first)} · Ort gemerkt`;
}

export function buildPlaceMetaLine(place, { photos = 0, videos = 0, notes = 0 }) {
  const parts = [];
  const remember = rememberMetaPart(place);
  if (remember) parts.push(remember);
  else parts.push(formatTimeFromTs(place.ts));

  if (photos > 0) parts.push(`${photos} Foto${photos === 1 ? "" : "s"}`);
  if (videos > 0) parts.push(`${videos} Video${videos === 1 ? "" : "s"}`);
  if (notes > 0) parts.push(`${notes} Notiz${notes === 1 ? "" : "en"}`);
  return parts.join(" · ");
}
