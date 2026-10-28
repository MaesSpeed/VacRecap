const CACHE_KEY_PREFIX = "vr-cloud-read-cache";
const LEGACY_CACHE_KEY = "vr-cloud-read-cache";
const MAX_BYTES = 500 * 1024;

let offlineReadOnly = false;
let activeUserId = null;

export function setCacheUserId(userId) {
  activeUserId = userId || null;
}

function cacheKey() {
  if (!activeUserId) return LEGACY_CACHE_KEY;
  return `${CACHE_KEY_PREFIX}:${activeUserId}`;
}

export function isOfflineReadOnly() {
  return offlineReadOnly || !navigator.onLine;
}

export function setOfflineReadOnly(value) {
  offlineReadOnly = Boolean(value);
}

export function clearReadCache() {
  try {
    localStorage.removeItem(cacheKey());
    localStorage.removeItem(LEGACY_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

function trimPayload(obj) {
  const raw = JSON.stringify(obj);
  if (raw.length <= MAX_BYTES) return obj;
  const trips = (obj.trips || []).slice(0, 20);
  const waypoints = {};
  const notes = {};
  for (const t of trips) {
    const tid = t.id;
    waypoints[tid] = (obj.waypoints?.[tid] || []).slice(0, 80);
    notes[tid] = (obj.notes?.[tid] || []).slice(0, 120);
  }
  return { trips, waypoints, notes, savedAt: obj.savedAt };
}

export function readCache() {
  try {
    const key = cacheKey();
    let raw = localStorage.getItem(key);
    if (!raw && key !== LEGACY_CACHE_KEY) {
      raw = localStorage.getItem(LEGACY_CACHE_KEY);
    }
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeCache(partial) {
  if (!activeUserId) return;
  try {
    const prev = readCache() || { trips: [], waypoints: {}, notes: {} };
    const next = {
      trips: partial.trips ?? prev.trips,
      waypoints: { ...prev.waypoints, ...(partial.waypoints || {}) },
      notes: { ...prev.notes, ...(partial.notes || {}) },
      savedAt: Date.now(),
    };
    localStorage.setItem(cacheKey(), JSON.stringify(trimPayload(next)));
  } catch {
    /* quota */
  }
}
