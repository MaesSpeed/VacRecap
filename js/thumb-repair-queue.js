import { getMedia, saveMediaThumb } from "./db.js";
import { createPhotoThumbFromBlob } from "./media-process.js";
import {
  clearThumbDecodeFailed,
  isThumbDecodeFailed,
  markThumbDecodeFailed,
} from "./thumb-decode-state.js";

const START_DELAY_MS = 3000;
const MAX_PER_SESSION = 10;
const RETRY_DELAYS_MS = [400, 800, 1600];

let started = false;
let repairedThisSession = 0;
const queue = [];
let running = false;
let decodeInflight = false;

function photoThumbMissing(media) {
  return media?.type !== "video" && (!media.thumbBlob || media.thumbBlob.size === 0);
}

async function withDecodeLock(fn) {
  while (decodeInflight) {
    await new Promise((r) => setTimeout(r, 25));
  }
  decodeInflight = true;
  try {
    return await fn();
  } finally {
    decodeInflight = false;
  }
}

async function createThumbWithRetries(record) {
  const { getMedia: getMediaFresh } = await import("./db.js");
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const src = attempt === 0 ? record : await getMediaFresh(record.id);
      if (!src?.blob) throw new Error("no blob");
      return await withDecodeLock(() => createPhotoThumbFromBlob(src.blob));
    } catch (err) {
      lastErr = err;
      if (err?.name !== "InvalidStateError" || attempt >= RETRY_DELAYS_MS.length) break;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastErr;
}

async function repairOne(mediaId) {
  if (repairedThisSession >= MAX_PER_SESSION) return;
  if (isThumbDecodeFailed(mediaId)) return;
  const record = await getMedia(mediaId);
  if (!record || record.type === "video") return;
  if (!photoThumbMissing(record)) return;
  try {
    const thumbBlob = await createThumbWithRetries(record);
    await saveMediaThumb(mediaId, thumbBlob);
    clearThumbDecodeFailed(mediaId);
    repairedThisSession += 1;
    window.dispatchEvent(new CustomEvent("vacrecap:thumb-repaired", { detail: { mediaId } }));
  } catch {
    markThumbDecodeFailed(mediaId);
  }
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length && repairedThisSession < MAX_PER_SESSION) {
      const id = queue.shift();
      if (id) await repairOne(id);
    }
  } finally {
    running = false;
  }
}

function ensureStarted() {
  if (started) return;
  started = true;
  window.setTimeout(() => void drain(), START_DELAY_MS);
}

export function scheduleThumbRepairs(mediaList) {
  for (const m of mediaList || []) {
    if (!m?.id || m.type === "video") continue;
    if (isThumbDecodeFailed(m.id)) continue;
    if (!photoThumbMissing(m)) continue;
    if (queue.includes(m.id)) continue;
    queue.push(m.id);
  }
  ensureStarted();
}

export function resetThumbRepairSessionForTests() {
  started = false;
  repairedThisSession = 0;
  queue.length = 0;
  running = false;
  decodeInflight = false;
}
