import { getRouteCacheRecord, putRouteCacheRecord } from "./db.js";

export function roundCoord(n) {
  return Math.round(Number(n) * 1e5) / 1e5;
}

export function segmentCacheKey(from, to, profile) {
  const a = `${roundCoord(from.lat)},${roundCoord(from.lng)}`;
  const b = `${roundCoord(to.lat)},${roundCoord(to.lng)}`;
  const [p, q] = a < b ? [a, b] : [b, a];
  return `${p}|${q}|${profile}`;
}

export async function getRouteCacheEntry(key) {
  return await getRouteCacheRecord(key);
}

export async function putRouteCacheEntry(entry) {
  await putRouteCacheRecord(entry);
}
