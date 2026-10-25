import { getPlacesForDay, putPlace } from "./db.js";
import { rememberPlaceFromGps } from "./place-service.js";
import { createPlace, newestHardPlace, normalizePlace } from "./places.js";
import { showToast } from "./toast.js";
import { todayIso } from "./utils.js";

const OHNE_ORT = "Ohne Ort";

function tsForDay(day) {
  if (day === todayIso()) return Date.now();
  return new Date(`${day}T12:00:00`).getTime();
}

function findOhneOrt(places) {
  return places.find(
    (p) => !p.soft && p.name === OHNE_ORT && p.lat == null && p.lng == null
  );
}

export async function ensureTargetPlace({ vacationId, day, selectedPlaceId }) {
  const all = await getPlacesForDay(vacationId, day);
  const hard = all.filter((p) => !p.soft);

  if (selectedPlaceId) {
    const selected = hard.find((p) => p.id === selectedPlaceId);
    if (selected) return { place: selected, createdOhneOrt: false };
  }

  const newest = newestHardPlace(hard);
  if (newest) return { place: newest, createdOhneOrt: false };

  if (day === todayIso()) {
    const gps = await rememberPlaceFromGps({ vacationId, day });
    if (gps?.place) {
      return { place: normalizePlace(gps.place), createdOhneOrt: false };
    }
  }

  const existing = findOhneOrt(hard);
  if (existing) {
    return { place: existing, createdOhneOrt: false };
  }

  const ts = tsForDay(day);
  const place = createPlace({
    vacationId,
    day,
    ts,
    lat: null,
    lng: null,
    name: OHNE_ORT,
    soft: false,
    source: "ohne-ort",
  });
  await putPlace(place);
  showToast("Ohne Ort gespeichert");
  return { place, createdOhneOrt: true };
}
