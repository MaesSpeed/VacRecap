import { CloudOfflineError, mapApiError } from "./cloud-errors.js";
import {
  noteRowToApp,
  noteToRow,
  placeToWaypointRow,
  tripRowToVacation,
  vacationToTripRow,
  waypointRowToPlace,
} from "./cloud-mappers.js";
import { isOfflineReadOnly, readCache, writeCache } from "./local-cache.js";
import { getSupabase } from "./supabase-client.js";
import { normalizePlace } from "./places.js";
import { normalizeVacation } from "./vacation.js";

const SETTINGS_PREFIX = "vr-setting:";

function assertWritable() {
  if (isOfflineReadOnly() || !navigator.onLine) {
    throw new CloudOfflineError();
  }
}

function cacheTrips(rows) {
  const trips = rows.map(tripRowToVacation);
  writeCache({ trips });
  return trips;
}

export async function requestPersistentStorage() {
  /* Cloud-Modus: kein IDB-Persist */
}

export async function putVacation(vacation) {
  assertWritable();
  const v = normalizeVacation(vacation);
  const supabase = getSupabase();
  const row = vacationToTripRow(v);
  if (v.id) {
    const { data: existing } = await supabase.from("trips").select("id").eq("id", v.id).maybeSingle();
    if (existing?.id) {
      const { data, error } = await supabase
        .from("trips")
        .update(row)
        .eq("id", v.id)
        .select()
        .single();
      if (error) throw mapApiError(error);
      const mapped = tripRowToVacation(data);
      writeCache({ trips: (readCache()?.trips || []).map((t) => (t.id === mapped.id ? mapped : t)) });
      window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
      return mapped;
    }
  }
  const insertRow = v.id ? { ...row, id: v.id } : row;
  const { data, error } = await supabase.from("trips").insert(insertRow).select().single();
  if (error) throw mapApiError(error);
  const mapped = tripRowToVacation(data);
  const prev = readCache()?.trips || [];
  writeCache({ trips: [...prev, mapped] });
  window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
  return mapped;
}

export async function getVacation(id) {
  if (!id) return null;
  if (!navigator.onLine) {
    const cached = readCache()?.trips?.find((t) => t.id === id);
    return cached ? normalizeVacation(cached) : null;
  }
  const { data, error } = await getSupabase().from("trips").select("*").eq("id", id).maybeSingle();
  if (error) throw mapApiError(error);
  if (!data) return null;
  return normalizeVacation(tripRowToVacation(data));
}

export async function getAllVacations() {
  if (!navigator.onLine) {
    const cached = readCache()?.trips || [];
    return cached.map(normalizeVacation);
  }
  const { data, error } = await getSupabase()
    .from("trips")
    .select("*")
    .order("start_date", { ascending: true });
  if (error) {
    const cached = readCache()?.trips;
    if (cached?.length) return cached.map(normalizeVacation);
    throw mapApiError(error);
  }
  return cacheTrips(data || []).map(normalizeVacation);
}

export async function deleteVacation(id) {
  assertWritable();
  const { error } = await getSupabase().from("trips").delete().eq("id", id);
  if (error) throw mapApiError(error);
  const cache = readCache();
  if (cache) {
    writeCache({
      trips: (cache.trips || []).filter((t) => t.id !== id),
      waypoints: { ...cache.waypoints, [id]: [] },
      notes: { ...cache.notes, [id]: [] },
    });
  }
  window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
}

export async function deleteVacationData(vacationId) {
  await deleteVacation(vacationId);
}

export async function putBlob() {
  return null;
}
export async function getBlob() {
  return null;
}
export async function deleteBlob() {
  /* noop */
}

export async function getSetting(key) {
  try {
    const raw = localStorage.getItem(SETTINGS_PREFIX + key);
    if (raw == null) return undefined;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export async function putSetting(key, value) {
  localStorage.setItem(SETTINGS_PREFIX + key, JSON.stringify(value));
}

export async function getRouteCacheRecord(key) {
  return (await getSetting(`route:${key}`)) ?? null;
}

export async function putRouteCacheRecord(entry) {
  await putSetting(`route:${entry.key}`, entry);
}

async function fetchWaypointsForTrip(tripId) {
  if (!navigator.onLine) {
    return (readCache()?.waypoints?.[tripId] || []).map((p) => normalizePlace(p));
  }
  const { data, error } = await getSupabase()
    .from("waypoints")
    .select("*")
    .eq("trip_id", tripId)
    .is("deleted_at", null)
    .order("visited_at", { ascending: true });
  if (error) {
    const cached = readCache()?.waypoints?.[tripId];
    if (cached) return cached.map((p) => normalizePlace(p));
    throw mapApiError(error);
  }
  const places = (data || []).map((r) => normalizePlace(waypointRowToPlace(r)));
  writeCache({ waypoints: { [tripId]: places } });
  return places;
}

export async function getPlacesForVacation(vacationId) {
  return fetchWaypointsForTrip(vacationId);
}

export async function getPlacesForDay(vacationId, dayDate) {
  const all = await fetchWaypointsForTrip(vacationId);
  return all.filter((p) => (p.day || p.dayDate) === dayDate);
}

export async function getPlace(id) {
  if (!navigator.onLine) {
    const cache = readCache();
    for (const list of Object.values(cache?.waypoints || {})) {
      const hit = list.find((p) => p.id === id);
      if (hit) return normalizePlace(hit);
    }
    return null;
  }
  const { data, error } = await getSupabase()
    .from("waypoints")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw mapApiError(error);
  return data ? normalizePlace(waypointRowToPlace(data)) : null;
}

export async function putPlace(place) {
  assertWritable();
  const p = normalizePlace(place);
  const supabase = getSupabase();
  const row = placeToWaypointRow(p);
  if (p.id) {
    const { data: existing } = await supabase
      .from("waypoints")
      .select("id")
      .eq("id", p.id)
      .maybeSingle();
    if (existing?.id) {
      const { data, error } = await supabase
        .from("waypoints")
        .update(row)
        .eq("id", p.id)
        .select()
        .single();
      if (error) throw mapApiError(error);
      const mapped = normalizePlace(waypointRowToPlace(data));
      mergeWaypointCache(mapped);
      window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
      return mapped;
    }
  }
  const insertRow = p.id ? { ...row, id: p.id } : row;
  const { data, error } = await supabase.from("waypoints").insert(insertRow).select().single();
  if (error) throw mapApiError(error);
  const mapped = normalizePlace(waypointRowToPlace(data));
  mergeWaypointCache(mapped);
  window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
  return mapped;
}

function mergeWaypointCache(place) {
  const cache = readCache() || { trips: [], waypoints: {}, notes: {} };
  const list = cache.waypoints?.[place.vacationId] || [];
  const idx = list.findIndex((p) => p.id === place.id);
  const next = idx >= 0 ? list.map((p, i) => (i === idx ? place : p)) : [...list, place];
  writeCache({ waypoints: { [place.vacationId]: next } });
}

export async function deletePlace(id) {
  assertWritable();
  const place = await getPlace(id);
  const { error } = await getSupabase()
    .from("waypoints")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw mapApiError(error);
  if (place) {
    const cache = readCache();
    const list = (cache?.waypoints?.[place.vacationId] || []).filter((p) => p.id !== id);
    writeCache({ waypoints: { [place.vacationId]: list } });
  }
  window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
}

export async function deletePlacesForVacation() {
  /* Reise-Löschung über trips cascade */
}

async function fetchNotesForWaypoint(waypointId) {
  if (!navigator.onLine) {
    for (const list of Object.values(readCache()?.notes || {})) {
      const hit = list.filter((n) => n.placeId === waypointId);
      if (hit.length) return hit;
    }
    return [];
  }
  const { data, error } = await getSupabase()
    .from("notes")
    .select("*")
    .eq("waypoint_id", waypointId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: true });
  if (error) throw mapApiError(error);
  const notes = (data || []).map(noteRowToApp);
  if (notes.length) {
    cacheNotesForWaypoint(waypointId, notes, notes[0].vacationId);
  }
  return notes;
}

function cacheNotesForWaypoint(waypointId, notes, tripId) {
  if (!tripId) return;
  const cache = readCache() || { trips: [], waypoints: {}, notes: {} };
  const list = cache.notes?.[tripId] || [];
  const withoutWaypoint = list.filter((n) => n.placeId !== waypointId);
  writeCache({ notes: { [tripId]: [...withoutWaypoint, ...notes] } });
}

export async function getNotesForPlace(placeId) {
  return fetchNotesForWaypoint(placeId);
}

export async function putNote(record) {
  assertWritable();
  const row = noteToRow(record);
  const supabase = getSupabase();
  let existing = false;
  if (record.id) {
    const { data: hit } = await supabase.from("notes").select("id").eq("id", record.id).maybeSingle();
    existing = Boolean(hit?.id);
  }
  if (existing) {
    const { data, error } = await supabase
      .from("notes")
      .update({ body: row.body, day: row.day, waypoint_id: row.waypoint_id })
      .eq("id", record.id)
      .select()
      .single();
    if (error) throw mapApiError(error);
    const mapped = noteRowToApp(data);
    mergeNoteCache(mapped);
    window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
    return mapped;
  }
  const { data, error } = await supabase.from("notes").insert(row).select().single();
  if (error) throw mapApiError(error);
  const mapped = noteRowToApp(data);
  mergeNoteCache(mapped);
  window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
  return mapped;
}

function mergeNoteCache(note) {
  const cache = readCache() || { trips: [], waypoints: {}, notes: {} };
  const list = cache.notes?.[note.vacationId] || [];
  const idx = list.findIndex((n) => n.id === note.id);
  const next = idx >= 0 ? list.map((n, i) => (i === idx ? note : n)) : [...list, note];
  writeCache({ notes: { [note.vacationId]: next } });
}

export async function deleteNote(id) {
  assertWritable();
  const { error } = await getSupabase()
    .from("notes")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw mapApiError(error);
  removeNoteFromCache(id);
  window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
}

function removeNoteFromCache(noteId) {
  const cache = readCache();
  if (!cache?.notes) return;
  const next = {};
  for (const [tripId, list] of Object.entries(cache.notes)) {
    next[tripId] = list.filter((n) => n.id !== noteId);
  }
  writeCache({ notes: next });
}

export async function deleteNotesForPlace() {}
export async function deleteNotesForVacation() {}
export async function deleteMediaForPlace() {}
export async function deleteMediaForVacation() {}
export async function deletePlaceCascade(id) {
  await deletePlace(id);
}

export async function putMedia() {
  throw new Error("Medien kommen im nächsten Schritt.");
}
export async function getMedia() {
  return null;
}
export async function deleteMedia() {}
export async function getMediaBySourceKey() {
  return null;
}
export async function getAllMediaForVacation() {
  return [];
}
export async function getMediaForPlace() {
  return [];
}
export async function saveMediaThumb() {}
export async function deleteMediaThumb() {}
export async function clearAllMediaThumbs() {}
