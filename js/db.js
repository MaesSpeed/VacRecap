import { CloudNetworkError, CloudOfflineError, isFetchNetworkFailure, mapApiError } from "./cloud-errors.js";
import { deleteMediaStorageObjects } from "./cloud-media-storage.js";
import { getUserId } from "./auth-service.js";
import {
  mediaRowToApp,
  mediaToRow,
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

async function upsertRow(supabase, table, row, id) {
  const payload = id ? { ...row, id } : row;
  const { data, error } = await supabase
    .from(table)
    .upsert(payload, { onConflict: "id" })
    .select()
    .single();
  if (error) throw mapApiError(error);
  return data;
}

function tripIdForWaypointFromCache(waypointId) {
  const cache = readCache();
  for (const [tripId, places] of Object.entries(cache?.waypoints || {})) {
    if (places.some((p) => p.id === waypointId)) return tripId;
  }
  return null;
}

function notesForWaypointFromCache(waypointId) {
  for (const list of Object.values(readCache()?.notes || {})) {
    const hit = list.filter((n) => n.placeId === waypointId);
    if (hit.length) return hit;
  }
  return [];
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
  let data;
  if (v.id) {
    data = await upsertRow(supabase, "trips", row, v.id);
  } else {
    const { data: inserted, error } = await supabase.from("trips").insert(row).select().single();
    if (error) throw mapApiError(error);
    data = inserted;
  }
  const mapped = tripRowToVacation(data);
  const prev = readCache()?.trips || [];
  const idx = prev.findIndex((t) => t.id === mapped.id);
  writeCache({ trips: idx >= 0 ? prev.map((t, i) => (i === idx ? mapped : t)) : [...prev, mapped] });
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
  try {
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
  } catch (err) {
    const cached = readCache()?.trips;
    if (cached?.length) return cached.map(normalizeVacation);
    if (err instanceof CloudOfflineError || err instanceof CloudNetworkError) throw err;
    if (isFetchNetworkFailure(err)) throw new CloudNetworkError();
    throw err;
  }
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

export async function deleteSetting(key) {
  localStorage.removeItem(SETTINGS_PREFIX + key);
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
  let data;
  if (p.id) {
    data = await upsertRow(supabase, "waypoints", row, p.id);
  } else {
    const { data: inserted, error } = await supabase.from("waypoints").insert(row).select().single();
    if (error) throw mapApiError(error);
    data = inserted;
  }
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
    return notesForWaypointFromCache(waypointId);
  }
  try {
    const { data, error } = await getSupabase()
      .from("notes")
      .select("*")
      .eq("waypoint_id", waypointId)
      .is("deleted_at", null)
      .order("updated_at", { ascending: true });
    if (error) throw mapApiError(error);
    const notes = (data || []).map(noteRowToApp);
    const tripId = notes[0]?.vacationId ?? tripIdForWaypointFromCache(waypointId);
    if (tripId) {
      cacheNotesForWaypoint(waypointId, notes, tripId);
    }
    return notes;
  } catch (err) {
    const cached = notesForWaypointFromCache(waypointId);
    if (cached.length) return cached;
    if (err instanceof CloudOfflineError || err instanceof CloudNetworkError) return [];
    if (isFetchNetworkFailure(err)) return [];
    throw err;
  }
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
  let data;
  if (record.id) {
    data = await upsertRow(supabase, "notes", row, record.id);
  } else {
    const { data: inserted, error } = await supabase.from("notes").insert(row).select().single();
    if (error) throw mapApiError(error);
    data = inserted;
  }
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

export async function putMedia(record) {
  return insertMediaRow(record);
}

export async function insertMediaRow(record) {
  assertWritable();
  const row = mediaToRow(record);
  const { data, error } = await getSupabase().from("media").insert(row).select().single();
  if (error) throw mapApiError(error);
  const mapped = mediaRowToApp(data);
  window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
  return mapped;
}

export async function updateMediaRow(id, patch) {
  assertWritable();
  const { data, error } = await getSupabase()
    .from("media")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw mapApiError(error);
  const mapped = mediaRowToApp(data);
  window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
  return mapped;
}

export async function getMedia(id) {
  if (!id) return null;
  const { data, error } = await getSupabase()
    .from("media")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw mapApiError(error);
  return data ? mediaRowToApp(data) : null;
}

export async function deleteMedia(id) {
  assertWritable();
  const existing = await getMedia(id);
  if (existing?.storagePath) {
    await deleteMediaStorageObjects(existing.storagePath, existing.thumbPath);
  }
  const { error } = await getSupabase()
    .from("media")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw mapApiError(error);
  window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
}

const STALE_PENDING_MS = 10 * 60 * 1000;

async function reconcileStalePendingRows(rows) {
  if (!rows?.length || !navigator.onLine) return rows;
  let userId = null;
  try {
    userId = await getUserId();
  } catch {
    return rows;
  }
  if (!userId) return rows;
  const now = Date.now();
  const out = [];
  for (const row of rows) {
    if (row.upload_status !== "pending" || row.created_by !== userId) {
      out.push(row);
      continue;
    }
    const age = now - (Date.parse(row.updated_at) || Date.parse(row.created_at) || now);
    if (age > STALE_PENDING_MS) {
      try {
        await updateMediaRow(row.id, { upload_status: "failed" });
        out.push({ ...row, upload_status: "failed" });
      } catch {
        out.push({ ...row, upload_status: "failed" });
      }
    } else {
      out.push(row);
    }
  }
  return out;
}

export async function fetchMediaForPlace(placeId) {
  if (!placeId) return { media: [], error: null };
  if (!navigator.onLine) {
    return { media: [], error: null };
  }
  try {
    const { data, error } = await getSupabase()
      .from("media")
      .select("*")
      .eq("waypoint_id", placeId)
      .eq("kind", "photo")
      .is("deleted_at", null)
      .order("taken_at", { ascending: true });
    if (error) throw mapApiError(error);
    const reconciled = await reconcileStalePendingRows(data || []);
    return { media: reconciled.map(mediaRowToApp), error: null };
  } catch (err) {
    if (err instanceof CloudOfflineError || err instanceof CloudNetworkError) {
      return { media: [], error: err };
    }
    if (isFetchNetworkFailure(err)) {
      return { media: [], error: new CloudNetworkError() };
    }
    return { media: [], error: err };
  }
}

export async function getMediaBySourceKey(vacationId, sourceKey) {
  if (!sourceKey) return null;
  const { data, error } = await getSupabase()
    .from("media")
    .select("*")
    .eq("trip_id", vacationId)
    .eq("source_key", sourceKey)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw mapApiError(error);
  return data ? mediaRowToApp(data) : null;
}

export async function getAllMediaForVacation(vacationId) {
  const { data, error } = await getSupabase()
    .from("media")
    .select("*")
    .eq("trip_id", vacationId)
    .is("deleted_at", null)
    .order("taken_at", { ascending: true });
  if (error) throw mapApiError(error);
  return (data || []).map(mediaRowToApp).filter((m) => m.type === "photo");
}

export async function getMediaForPlace(placeId) {
  const { media } = await fetchMediaForPlace(placeId);
  return media;
}
export async function saveMediaThumb() {}
export async function deleteMediaThumb() {}
export async function clearAllMediaThumbs() {}
