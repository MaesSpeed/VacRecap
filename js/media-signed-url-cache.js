const MAX_ENTRIES = 80;

/** @type {Map<string, { url: string, expiresAt: number }>} */
const thumbCache = new Map();
/** @type {Map<string, { url: string, expiresAt: number }>} */
const originalCache = new Map();

function getCached(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    map.delete(key);
    return null;
  }
  return hit.url;
}

function setCached(map, key, url, ttlSec) {
  if (map.size >= MAX_ENTRIES) {
    const first = map.keys().next().value;
    map.delete(first);
  }
  map.set(key, { url, expiresAt: Date.now() + ttlSec * 1000 });
}

export async function getSignedThumbUrl(supabase, thumbPath) {
  if (!thumbPath) return null;
  const cached = getCached(thumbCache, thumbPath);
  if (cached) return cached;
  const { data, error } = await supabase.storage
    .from("media-thumbs")
    .createSignedUrl(thumbPath, 3600);
  if (error || !data?.signedUrl) return null;
  setCached(thumbCache, thumbPath, data.signedUrl, 3600);
  return data.signedUrl;
}

export async function getSignedThumbUrls(supabase, paths) {
  const out = {};
  const missing = [];
  const seen = new Set();
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const cached = getCached(thumbCache, path);
    if (cached) out[path] = cached;
    else missing.push(path);
  }
  if (!missing.length) return out;
  const { data, error } = await supabase.storage.from("media-thumbs").createSignedUrls(missing, 3600);
  if (error || !Array.isArray(data)) return out;
  for (let i = 0; i < missing.length; i++) {
    const item = data[i];
    const path = item?.path || missing[i];
    const url = item?.signedUrl || null;
    if (!url || item?.error) continue;
    setCached(thumbCache, path, url, 3600);
    out[path] = url;
    if (path !== missing[i]) out[missing[i]] = url;
  }
  return out;
}

export async function getSignedOriginalUrl(supabase, storagePath) {
  if (!storagePath) return null;
  const cached = getCached(originalCache, storagePath);
  if (cached) return cached;
  const { data, error } = await supabase.storage
    .from("media-originals")
    .createSignedUrl(storagePath, 3600);
  if (error || !data?.signedUrl) return null;
  setCached(originalCache, storagePath, data.signedUrl, 3600);
  return data.signedUrl;
}

export function clearSignedUrlCache() {
  thumbCache.clear();
  originalCache.clear();
}

export function signedUrlCacheCounts() {
  return { thumbs: thumbCache.size, originals: originalCache.size, max: MAX_ENTRIES };
}
