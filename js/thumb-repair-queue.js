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
let delayPassed = false;
let repairedThisSession = 0;
let unlimitedSession = false;
const queue = [];
let running = false;
let decodeInflight = false;

function sessionRepairLimit() {
  return unlimitedSession ? Number.POSITIVE_INFINITY : MAX_PER_SESSION;
}

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
  if (repairedThisSession >= sessionRepairLimit()) return;
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
    const limit = sessionRepairLimit();
    while (queue.length && repairedThisSession < limit) {
      const id = queue.shift();
      if (id) await repairOne(id);
    }
  } finally {
    running = false;
    if (queue.length && repairedThisSession < sessionRepairLimit()) {
      void drain();
    }
  }
}

function ensureStarted() {
  if (started) return;
  started = true;
  window.setTimeout(() => {
    delayPassed = true;
    void drain();
  }, START_DELAY_MS);
}

/** Nach „Vorschaubilder zurücksetzen“: gesamte Queue in dieser Session abarbeiten. */
export function beginFullThumbRepairAfterReset() {
  unlimitedSession = true;
  repairedThisSession = 0;
  if (delayPassed) void drain();
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
  if (delayPassed) void drain();
}

export function enqueueThumbRepair(mediaId) {
  if (!mediaId || isThumbDecodeFailed(mediaId)) return;
  if (queue.includes(mediaId)) return;
  queue.push(mediaId);
  ensureStarted();
  if (delayPassed) void drain();
}

export function resetThumbRepairSessionForTests() {
  started = false;
  delayPassed = false;
  repairedThisSession = 0;
  unlimitedSession = false;
  queue.length = 0;
  running = false;
  decodeInflight = false;
}
