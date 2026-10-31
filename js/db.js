import {
  CaptionUnavailableError,
  CloudNetworkError,
  CloudOfflineError,
  isFetchNetworkFailure,
  mapApiError,
} from "./cloud-errors.js";
import { deleteMediaStorageObjects } from "./cloud-media-storage.js";
import { getUserId } from "./auth-service.js";
import {
  mediaRowToApp,
  mediaToRow,
  normalizeMediaCaption,
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

function errorBlob(error) {
  return `${error?.code || ""} ${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`;
}

function isMissingCoverPresetColumn(error) {
  const blob = errorBlob(error);
  if (/companion_tags/i.test(blob)) return false;
  return /PGRST204/i.test(blob) || (/cover_preset/i.test(blob) && /schema cache|could not find|column/i.test(blob));
}

function isMissingCompanionTagsColumn(error) {
  const blob = errorBlob(error);
  if (!/companion_tags/i.test(blob)) return false;
  return /PGRST204|42703/i.test(blob);
}

function isMissingCaptionColumn(error) {
  const blob = `${error?.code || ""} ${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`;
  if (!/caption/i.test(blob)) return false;
  return /PGRST204|42703|schema cache|could not find|does not exist|column/i.test(blob);
}

const MEDIA_FIELDS =
  "id,trip_id,waypoint_id,day,taken_at,kind,storage_path,thumb_path,mime,size_bytes,width,height,upload_status,source_key,created_by,created_at,updated_at,deleted_at";

let omitCaptionColumn = false;

function mediaSelect() {
  return omitCaptionColumn ? MEDIA_FIELDS : `${MEDIA_FIELDS},caption`;
}

async function runMediaRead(run) {
  const cols = mediaSelect();
  const first = await run(cols);
  // Parallele Abfragen haben caption schon in ihrer eigenen Liste, auch wenn
  // eine andere Anfrage das Flag inzwischen gesetzt hat. Sonst liefert die
  // zweite den Fehler zurück und der Ort bleibt ohne Fotos.
  if (first?.error && isMissingCaptionColumn(first.error) && cols !== MEDIA_FIELDS) {
    omitCaptionColumn = true;
    return run(MEDIA_FIELDS);
  }
  return first;
}

/**
 * Schreibt eine Reise.
 * Fehlt nur companion_tags (PGRST204/42703), wird genau diese Spalte
 * weggelassen und der Rest gespeichert. Lesen bleibt select("*"): ohne
 * Spalte fehlt das Feld im JSON, ohne gemeinsames Flag wie bei caption.
 */
async function writeTripRow(supabase, row, id) {
  const run = async (payload) => {
    const body = id ? { ...payload, id } : payload;
    if (id) {
      return supabase.from("trips").upsert(body, { onConflict: "id" }).select().single();
    }
    return supabase.from("trips").insert(body).select().single();
  };
  let payload = row;
  let companionsUnavailable = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data, error } = await run(payload);
    if (!error) return { data, companionsUnavailable };
    if (
      isMissingCompanionTagsColumn(error) &&
      Object.prototype.hasOwnProperty.call(payload, "companion_tags")
    ) {
      const rest = { ...payload };
      delete rest.companion_tags;
      payload = rest;
      companionsUnavailable = true;
      continue;
    }
    if (isMissingCoverPresetColumn(error) && Object.prototype.hasOwnProperty.call(payload, "cover_preset")) {
      const rest = { ...payload };
      delete rest.cover_preset;
      payload = rest;
      continue;
    }
    throw mapApiError(error);
  }
  throw mapApiError({ message: "Speichern fehlgeschlagen." });
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
  const { data, companionsUnavailable } = await writeTripRow(supabase, row, v.id || null);
  const mapped = tripRowToVacation(data);
  const prev = readCache()?.trips || [];
  const idx = prev.findIndex((t) => t.id === mapped.id);
  writeCache({ trips: idx >= 0 ? prev.map((t, i) => (i === idx ? mapped : t)) : [...prev, mapped] });
  window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
  if (!companionsUnavailable) return mapped;
  return { ...mapped, companions: { ...mapped.companions }, companionsUnavailable: true };
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

function sameNoteDay(noteDay, day) {
  return String(noteDay || "").slice(0, 10) === String(day || "").slice(0, 10);
}

function freeNotesFromCache(tripId, day) {
  const list = readCache()?.notes?.[tripId] || [];
  return list.filter((n) => (n.placeId == null || n.placeId === "") && sameNoteDay(n.day, day));
}

function cacheFreeNotesForDay(tripId, day, notes) {
  if (!tripId) return;
  const cache = readCache() || { trips: [], waypoints: {}, notes: {} };
  const list = cache.notes?.[tripId] || [];
  const without = list.filter(
    (n) => !((n.placeId == null || n.placeId === "") && sameNoteDay(n.day, day))
  );
  writeCache({ notes: { [tripId]: [...without, ...notes] } });
}

export async function getFreeNotesForDay(tripId, day) {
  if (!tripId || !day) return [];
  if (!navigator.onLine) return freeNotesFromCache(tripId, day);
  try {
    const { data, error } = await getSupabase()
      .from("notes")
      .select("*")
      .eq("trip_id", tripId)
      .eq("day", day)
      .is("waypoint_id", null)
      .is("deleted_at", null)
      .order("updated_at", { ascending: true });
    if (error) throw mapApiError(error);
    const notes = (data || []).map(noteRowToApp);
    cacheFreeNotesForDay(tripId, day, notes);
    return notes;
  } catch (err) {
    const cached = freeNotesFromCache(tripId, day);
    if (cached.length) return cached;
    if (err instanceof CloudOfflineError || err instanceof CloudNetworkError) return [];
    if (isFetchNetworkFailure(err)) return [];
    throw err;
  }
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

/**
 * Schreibt nur die Bildunterschrift.
 * Fehlt die Spalte (PGRST204/42703), wird ohne caption erneut geschrieben
 * und CaptionUnavailableError geworfen, statt die App abstürzen zu lassen.
 */
export async function updateMediaCaption(id, caption) {
  assertWritable();
  const normalized = normalizeMediaCaption(caption);
  const patch = { caption: normalized, updated_at: new Date().toISOString() };
  const run = (body) =>
    getSupabase().from("media").update(body).eq("id", id).select().single();
  let { data, error } = await run(patch);
  if (error && isMissingCaptionColumn(error)) {
    omitCaptionColumn = true;
    const rest = { updated_at: patch.updated_at };
    ({ error } = await run(rest));
    if (error && !isMissingCaptionColumn(error)) throw mapApiError(error);
    throw new CaptionUnavailableError();
  }
  if (error) throw mapApiError(error);
  const mapped = mediaRowToApp(data);
  window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
  return mapped;
}

/**
 * Verschiebt ein Foto auf einen anderen Ort/Tag.
 * Der Patch enthält nur waypoint_id, day und updated_at — nie created_by.
 * Kein vacrecap:data-changed, damit die Tagesansicht Ort und Zähler aus dem Cache malt.
 */
export async function updateMediaPlacement(id, { waypointId, day }) {
  assertWritable();
  const patch = {
    waypoint_id: waypointId,
    day,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await getSupabase()
    .from("media")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) throw mapApiError(error);
  return mediaRowToApp(data);
}

export async function getMedia(id) {
  if (!id) return null;
  const { data, error } = await runMediaRead((columns) =>
    getSupabase().from("media").select(columns).eq("id", id).is("deleted_at", null).maybeSingle()
  );
  if (error) throw mapApiError(error);
  return data ? mediaRowToApp(data) : null;
}

export async function markMediaDeleted(id) {
  assertWritable();
  const existing = await getMedia(id);
  if (!existing) return null;
  const { error } = await getSupabase()
    .from("media")
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw mapApiError(error);
  window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
  return existing;
}

export async function restoreMedia(id) {
  assertWritable();
  const { error } = await getSupabase()
    .from("media")
    .update({ deleted_at: null, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw mapApiError(error);
  window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
}

export async function purgeMediaFiles(media) {
  if (!media?.storagePath) return;
  await deleteMediaStorageObjects(media.storagePath, media.thumbPath);
}

const PENDING_PURGE_KEY = "vacrecap-pending-media-purge";

function readPendingPurges() {
  try {
    const raw = sessionStorage.getItem(PENDING_PURGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writePendingPurges(list) {
  try {
    if (!list.length) sessionStorage.removeItem(PENDING_PURGE_KEY);
    else sessionStorage.setItem(PENDING_PURGE_KEY, JSON.stringify(list));
  } catch {
    /* privater Modus */
  }
}

export function rememberPendingMediaPurge(media) {
  if (!media?.id || !media.storagePath) return;
  const list = readPendingPurges().filter((item) => item.id !== media.id);
  list.push({
    id: media.id,
    storagePath: media.storagePath,
    thumbPath: media.thumbPath || null,
    at: Date.now(),
  });
  writePendingPurges(list);
}

export function forgetPendingMediaPurge(id) {
  if (!id) return;
  writePendingPurges(readPendingPurges().filter((item) => item.id !== id));
}

async function purgeStaleDeletedMediaFiles() {
  if (!navigator.onLine) return;
  const cutoff = new Date(Date.now() - 6000).toISOString();
  try {
    const { data, error } = await getSupabase()
      .from("media")
      .select("id,storage_path,thumb_path,deleted_at")
      .not("deleted_at", "is", null)
      .lt("deleted_at", cutoff);
    if (error || !data?.length) return;
    for (const row of data) {
      if (!row.deleted_at || !row.storage_path) continue;
      await deleteMediaStorageObjects(row.storage_path, row.thumb_path);
    }
  } catch {
    /* nächster Start versucht es erneut */
  }
}

/** Nach Neustart innerhalb des Undo-Fensters: gemerkte und ältere Löschungen aus Storage nehmen. */
export async function flushPendingMediaPurges() {
  const list = readPendingPurges();
  writePendingPurges([]);
  for (const item of list) {
    await purgeMediaFiles(item);
  }
  await purgeStaleDeletedMediaFiles();
}

export async function deleteMedia(id) {
  const existing = await markMediaDeleted(id);
  if (existing) await purgeMediaFiles(existing);
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
    const { data, error } = await runMediaRead((columns) =>
      getSupabase()
        .from("media")
        .select(columns)
        .eq("waypoint_id", placeId)
        .eq("kind", "photo")
        .is("deleted_at", null)
        .order("taken_at", { ascending: true })
    );
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

const LIBRARY_PAGE = 400;

export async function fetchUploadedPhotosForTrip(vacationId) {
  if (!vacationId) return { media: [], error: null };
  if (!navigator.onLine) {
    return { media: [], error: new CloudOfflineError() };
  }
  try {
    const supabase = getSupabase();
    const rows = [];
    let offset = 0;
    for (let page = 0; page < 40; page += 1) {
      const { data, error } = await runMediaRead((columns) =>
        supabase
          .from("media")
          .select(columns)
          .eq("trip_id", vacationId)
          .eq("kind", "photo")
          .eq("upload_status", "uploaded")
          .is("deleted_at", null)
          .order("taken_at", { ascending: true })
          .range(offset, offset + LIBRARY_PAGE - 1)
      );
      if (error) throw mapApiError(error);
      const batch = data || [];
      if (!batch.length) break;
      const seen = new Set(rows.map((row) => row.id));
      const fresh = batch.filter((row) => row?.id && !seen.has(row.id));
      if (!fresh.length) break;
      rows.push(...fresh);
      if (batch.length < LIBRARY_PAGE) break;
      offset += LIBRARY_PAGE;
    }
    return {
      media: rows
        .map(mediaRowToApp)
        .filter((m) => m.type === "photo" && m.uploadStatus === "uploaded"),
      error: null,
    };
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

/** @returns {Promise<object[]|null>} null bei Netz, 5xx, 401 oder offline. Leere Id-Liste ist []. */
export async function fetchMediaByIds(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return [];
  if (!navigator.onLine) return null;
  try {
    const { data, error } = await runMediaRead((columns) =>
      getSupabase().from("media").select(columns).in("id", unique)
    );
    if (error) return null;
    return (data || []).map(mediaRowToApp).filter(Boolean);
  } catch {
    return null;
  }
}

export async function getMediaBySourceKey(vacationId, sourceKey) {
  if (!sourceKey) return null;
  const { data, error } = await runMediaRead((columns) =>
    getSupabase()
      .from("media")
      .select(columns)
      .eq("trip_id", vacationId)
      .eq("source_key", sourceKey)
      .is("deleted_at", null)
      .maybeSingle()
  );
  if (error) throw mapApiError(error);
  return data ? mediaRowToApp(data) : null;
}

export async function getAllMediaForVacation(vacationId) {
  if (!vacationId) return [];
  if (!navigator.onLine) return [];
  try {
    const { data, error } = await runMediaRead((columns) =>
      getSupabase()
        .from("media")
        .select(columns)
        .eq("trip_id", vacationId)
        .is("deleted_at", null)
        .order("taken_at", { ascending: true })
    );
    if (error) throw mapApiError(error);
    return (data || []).map(mediaRowToApp).filter((m) => m.type === "photo");
  } catch (err) {
    if (err instanceof CloudOfflineError || err instanceof CloudNetworkError) return [];
    if (isFetchNetworkFailure(err)) return [];
    return [];
  }
}

export async function getMediaForPlace(placeId) {
  const { media } = await fetchMediaForPlace(placeId);
  return media;
}
export async function saveMediaThumb() {}
export async function deleteMediaThumb() {}
export async function clearAllMediaThumbs() {}
