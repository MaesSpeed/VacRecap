import { formatTimeFromTs } from "./geo.js";

export function buildPlaceMetaLine(ts, { photos = 0, videos = 0, notes = 0 }) {
  const parts = [formatTimeFromTs(ts)];
  if (photos > 0) parts.push(`${photos} Foto${photos === 1 ? "" : "s"}`);
  if (videos > 0) parts.push(`${videos} Video${videos === 1 ? "" : "s"}`);
  if (notes > 0) parts.push(`${notes} Notiz${notes === 1 ? "" : "en"}`);
  return parts.join(" · ");
}
