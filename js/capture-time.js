import { formatIsoDate, todayIso } from "./utils.js";

/** Kalendertag eines Zeitstempels in der Ortszeit des Geräts. */
export function calendarDayOf(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return "";
  return formatIsoDate(new Date(n));
}

/** Eigene Fotozeit zählt nur, wenn sie auf dem Tag des Orts liegt. */
export function exifOnPlaceDay(takenAt, day) {
  return Boolean(day) && calendarDayOf(takenAt) === day;
}

/**
 * Uhrzeit am gewählten Tag, wenn das Foto keine eigene Zeit auf diesem Tag hat.
 * Heute: jetzt. Sonst eine Minute nach dem spätesten Ort des Tags, sonst 12:00 Ortszeit.
 */
export function fallbackTsOnDay(day, places = [], now = Date.now()) {
  if (!day) return now;
  if (day === todayIso()) return now;
  let latest = null;
  for (const place of places) {
    if (!place) continue;
    const placeDay = place.day || place.dayDate || "";
    if (placeDay !== day) continue;
    const ts = Number(place.ts);
    if (!Number.isFinite(ts) || calendarDayOf(ts) !== day) continue;
    if (latest == null || ts > latest) latest = ts;
  }
  if (latest != null) {
    const next = latest + 60_000;
    if (calendarDayOf(next) === day) return next;
    return latest;
  }
  return new Date(`${day}T12:00:00`).getTime();
}

/** Ortszeit: EXIF nur auf demselben Kalendertag, sonst der Fallback auf diesem Tag. */
export function placeTsForCapture(day, takenAt, places = [], now = Date.now()) {
  if (exifOnPlaceDay(takenAt, day)) return Number(takenAt);
  return fallbackTsOnDay(day, places, now);
}
