import { dayRoleLabel, vacationDays } from "./days.js";
import { formatDatePart } from "./utils.js";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isLibraryPhoto(media) {
  if (!media || media.type === "video") return false;
  return (media.uploadStatus || "") === "uploaded";
}

/** Kalendertag aus taken_at (lokale Zeit), nicht aus der day-Spalte. */
export function photoTakenDayIso(media) {
  const ts = Number(media?.ts);
  if (Number.isFinite(ts) && ts > 0) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }
  }
  if (media?.day && DAY_RE.test(media.day)) return media.day;
  return "1970-01-01";
}

export function libraryDayTitle(vacation, iso) {
  const date = formatDatePart(iso, false);
  const days = vacation ? vacationDays(vacation) : [];
  const idx = days.indexOf(iso);
  if (idx < 0) return date;
  return `${date} · ${dayRoleLabel(idx + 1, days.length)}`;
}

/**
 * Hochgeladene Fotos, gruppiert nach Aufnahmetag und darunter nach Ort.
 * Tage aufsteigend, Orte nach dem frühesten Foto, Fotos nach taken_at.
 */
export function groupLibraryPhotos(photos, places) {
  const placeById = new Map((places || []).map((p) => [p.id, p]));
  const byDay = new Map();

  for (const photo of photos || []) {
    if (!isLibraryPhoto(photo)) continue;
    const day = photoTakenDayIso(photo);
    const placeKey = photo.placeId || "";
    if (!byDay.has(day)) byDay.set(day, new Map());
    const byPlace = byDay.get(day);
    if (!byPlace.has(placeKey)) byPlace.set(placeKey, []);
    byPlace.get(placeKey).push(photo);
  }

  return [...byDay.keys()].sort().map((day) => {
    const groups = [...byDay.get(day).entries()].map(([placeKey, items]) => {
      const sorted = items
        .slice()
        .sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id)));
      const place = placeKey ? placeById.get(placeKey) : null;
      return {
        placeId: placeKey || null,
        placeName: place?.name || place?.title || "Ohne Ort",
        photos: sorted,
        firstTs: sorted[0]?.ts ?? 0,
      };
    });
    groups.sort(
      (a, b) => a.firstTs - b.firstTs || a.placeName.localeCompare(b.placeName, "de")
    );
    return { day, places: groups };
  });
}
