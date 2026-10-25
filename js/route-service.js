import { haversineMeters } from "./geo.js";
import {
  getRouteCacheEntry,
  putRouteCacheEntry,
  segmentCacheKey,
} from "./route-cache.js";

const FOOT_BASE = "https://routing.openstreetmap.de/routed-foot/route/v1/foot";
const CAR_BASE = "https://routing.openstreetmap.de/routed-car/route/v1/driving";
const ROUTE_TIMEOUT_MS = 6000;
const QUEUE_GAP_MS = 1000;
const NEGATIVE_CACHE_MS = 60 * 60 * 1000;
const MAX_ROUTE_FACTOR = 3;

let queue = [];
let queueBusy = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function profileForAirMeters(airM) {
  return airM < 3000 ? "foot" : "driving";
}

function osrmUrl(from, to, profile) {
  const base = profile === "foot" ? FOOT_BASE : CAR_BASE;
  const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  return `${base}/${coords}?overview=full&geometries=geojson`;
}

function geoJsonToLatLngs(geometry) {
  if (!geometry?.coordinates?.length) return null;
  return geometry.coordinates.map(([lng, lat]) => [lat, lng]);
}

function polylineLengthM(latlngs) {
  let sum = 0;
  for (let i = 1; i < latlngs.length; i++) {
    sum += haversineMeters(
      latlngs[i - 1][0],
      latlngs[i - 1][1],
      latlngs[i][0],
      latlngs[i][1]
    );
  }
  return sum;
}

function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    drainQueue();
  });
}

async function drainQueue() {
  if (queueBusy) return;
  queueBusy = true;
  while (queue.length) {
    const { task, resolve, reject } = queue.shift();
    try {
      resolve(await task());
    } catch (err) {
      reject(err);
    }
    if (queue.length) await sleep(QUEUE_GAP_MS);
  }
  queueBusy = false;
}

async function fetchOsrm(from, to, profile) {
  const url = osrmUrl(from, to, profile);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ROUTE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { error: true };
    const data = await res.json();
    const route = data?.routes?.[0];
    if (!route?.geometry) return { noRoute: true };
    const latlngs = geoJsonToLatLngs(route.geometry);
    if (!latlngs || latlngs.length < 2) return { noRoute: true };
    const lengthM = route.distance ?? polylineLengthM(latlngs);
    return { latlngs, lengthM, profile };
  } catch {
    return { error: true };
  } finally {
    clearTimeout(timer);
  }
}

function validCached(entry) {
  if (!entry) return null;
  if (entry.miss) {
    if (entry.expiresAt && entry.expiresAt > Date.now()) return { miss: true };
    return null;
  }
  if (entry.latlngs?.length >= 2) return entry;
  return null;
}

export async function resolveRouteSegment(from, to, { routesEnabled = true, online = true } = {}) {
  const airM = haversineMeters(from.lat, from.lng, to.lat, to.lng);
  const straight = [[from.lat, from.lng], [to.lat, to.lng]];

  if (!routesEnabled || !online) {
    return { kind: "straight", latlngs: straight, airM };
  }

  const profile = profileForAirMeters(airM);
  const key = segmentCacheKey(from, to, profile);
  const cached = validCached(await getRouteCacheEntry(key));
  if (cached?.miss) {
    return { kind: "straight", latlngs: straight, airM, cached: true };
  }
  if (cached?.latlngs) {
    return { kind: "routed", latlngs: cached.latlngs, airM, cached: true };
  }

  const fetched = await enqueue(() => fetchOsrm(from, to, profile));
  if (!fetched || fetched.error) {
    return { kind: "straight", latlngs: straight, airM };
  }

  if (fetched.noRoute) {
    await putRouteCacheEntry({
      key,
      miss: true,
      profile,
      expiresAt: Date.now() + NEGATIVE_CACHE_MS,
      savedAt: Date.now(),
    });
    return { kind: "straight", latlngs: straight, airM };
  }

  if (fetched.lengthM > airM * MAX_ROUTE_FACTOR) {
    await putRouteCacheEntry({
      key,
      miss: true,
      profile,
      expiresAt: Date.now() + NEGATIVE_CACHE_MS,
      savedAt: Date.now(),
    });
    return { kind: "straight", latlngs: straight, airM };
  }

  await putRouteCacheEntry({
    key,
    latlngs: fetched.latlngs,
    lengthM: fetched.lengthM,
    profile,
    savedAt: Date.now(),
  });
  return { kind: "routed", latlngs: fetched.latlngs, airM };
}

/** Liefert gecachte Route oder null (ohne Netz). */
export async function peekRouteSegment(from, to) {
  const airM = haversineMeters(from.lat, from.lng, to.lat, to.lng);
  const profile = profileForAirMeters(airM);
  const key = segmentCacheKey(from, to, profile);
  const cached = validCached(await getRouteCacheEntry(key));
  if (cached?.miss) return { kind: "straight", latlngs: [[from.lat, from.lng], [to.lat, to.lng]], airM };
  if (cached?.latlngs) return { kind: "routed", latlngs: cached.latlngs, airM };
  return null;
}
