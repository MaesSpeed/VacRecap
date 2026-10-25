import { getPlacesForDay, putPlace } from "./db.js";
import { fallbackPlaceName, getCapturePosition } from "./geo.js";
import {
  createPlace,
  findPlaceWithinMeters,
  newestHardPlace,
  normalizePlace,
} from "./places.js";
import { getRememberCaptureLocation, getSamePlaceRadiusM } from "./settings-store.js";
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

async function fallbackPlace({ vacationId, day, selectedPlaceId }) {
  const all = await getPlacesForDay(vacationId, day);
  const hard = all.filter((p) => !p.soft);

  if (selectedPlaceId) {
    const selected = hard.find((p) => p.id === selectedPlaceId);
    if (selected) return { place: selected, createdOhneOrt: false, toast: null };
  }

  const newest = newestHardPlace(hard);
  if (newest) return { place: newest, createdOhneOrt: false, toast: null };

  const existing = findOhneOrt(hard);
  if (existing) return { place: existing, createdOhneOrt: false, toast: null };

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
  return {
    place,
    createdOhneOrt: true,
    toast: { title: "Ohne Ort gespeichert", line: "" },
  };
}

async function resolveWithGps({ vacationId, day }) {
  const { consumePrefetchedCaptureGps } = await import("./capture-gps-prefetch.js");
  const prefetched = await consumePrefetchedCaptureGps();
  let lat;
  let lng;
  let accuracy;
  if (prefetched) {
    lat = prefetched.latitude;
    lng = prefetched.longitude;
    accuracy = prefetched.accuracy;
  } else {
    const pos = await getCapturePosition();
    lat = pos.coords.latitude;
    lng = pos.coords.longitude;
    accuracy = pos.coords.accuracy;
  }
  const dedupM = await getSamePlaceRadiusM();
  const all = await getPlacesForDay(vacationId, day);
  const hard = all.filter((p) => !p.soft);
  const near = findPlaceWithinMeters(hard, lat, lng, dedupM);
  if (near) {
    return {
      place: normalizePlace(near),
      createdOhneOrt: false,
      toast: { line: `Zu «${near.name}» hinzugefügt`, kind: "matched" },
    };
  }
  const ts = Date.now();
  const name = fallbackPlaceName(ts);
  const place = createPlace({
    vacationId,
    day,
    ts,
    lat,
    lng,
    accuracy,
    name,
    soft: false,
    source: "capture",
  });
  await putPlace(place);
  return {
    place,
    createdOhneOrt: false,
    toast: {
      line: `Neuer Ort: ${name}`,
      kind: "new",
      placeName: name,
    },
  };
}

/** Nur Anzeige in der Notiz-Ortsbox – legt keine Karte an. */
export async function previewNoteCaptureTarget({ vacationId, day, selectedPlaceId }) {
  const all = await getPlacesForDay(vacationId, day);
  const hard = all.filter((p) => !p.soft);

  if (selectedPlaceId) {
    const selected = hard.find((p) => p.id === selectedPlaceId);
    if (selected) return { label: selected.name, kind: "selected" };
  }

  if (await getRememberCaptureLocation()) {
    try {
      const pos = await getCapturePosition();
      const { latitude: lat, longitude: lng } = pos.coords;
      const dedupM = await getSamePlaceRadiusM();
      const near = findPlaceWithinMeters(hard, lat, lng, dedupM);
      if (near) return { label: near.name, kind: "gps-match" };
      return { label: "Neuer Ort", kind: "gps-new" };
    } catch {
      const newest = newestHardPlace(hard);
      if (newest) return { label: newest.name, kind: "fallback" };
      const existing = findOhneOrt(hard);
      if (existing) return { label: existing.name, kind: "fallback" };
      return { label: OHNE_ORT, kind: "fallback" };
    }
  }

  const newest = newestHardPlace(hard);
  if (newest) return { label: newest.name, kind: "fallback" };
  const existing = findOhneOrt(hard);
  if (existing) return { label: existing.name, kind: "fallback" };
  return { label: OHNE_ORT, kind: "fallback" };
}

export async function resolveCaptureTarget({
  vacationId,
  day,
  selectedPlaceId,
  mediaKind = "photo",
}) {
  const title =
    mediaKind === "video"
      ? "Video gespeichert"
      : mediaKind === "note"
        ? "Notiz gespeichert"
        : "Foto gespeichert";

  if (await getRememberCaptureLocation()) {
    try {
      const gps = await resolveWithGps({ vacationId, day });
      if (gps.toast) gps.toast.title = title;
      return { ...gps, needsRefresh: true };
    } catch {
      const fb = await fallbackPlace({ vacationId, day, selectedPlaceId });
      return {
        ...fb,
        needsRefresh: fb.createdOhneOrt,
        toast: {
          title,
          line: "Ohne Position (Standort nicht verfügbar)",
          variant: "warn",
        },
      };
    }
  }

  const fb = await fallbackPlace({ vacationId, day, selectedPlaceId });
  return { ...fb, needsRefresh: fb.createdOhneOrt };
}

export async function getOrCreateOhneOrtPlace({ vacationId, day, showToastOnCreate = true }) {
  const all = await getPlacesForDay(vacationId, day);
  const hard = all.filter((p) => !p.soft);
  const existing = findOhneOrt(hard);
  if (existing) return { place: existing, created: false };

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
  if (showToastOnCreate) showToast("Ohne Ort gespeichert");
  return { place, created: true };
}

export async function resolveMediathekTarget({ vacationId, day, selectedPlaceId }) {
  const all = await getPlacesForDay(vacationId, day);
  const hard = all.filter((p) => !p.soft);

  if (selectedPlaceId) {
    const selected = hard.find((p) => p.id === selectedPlaceId);
    if (selected) return { place: selected, ohneOrtPending: false };
  }
  const newest = newestHardPlace(hard);
  if (newest) return { place: newest, ohneOrtPending: false };
  return { place: null, ohneOrtPending: true };
}

export async function ensureTargetPlace({ vacationId, day, selectedPlaceId }) {
  const r = await resolveCaptureTarget({ vacationId, day, selectedPlaceId });
  return {
    place: r.place,
    createdOhneOrt: r.createdOhneOrt,
    toast: r.toast,
    needsRefresh: r.needsRefresh,
  };
}
