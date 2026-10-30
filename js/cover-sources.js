import { dayChipDateLine } from "./days.js";
import { fetchMediaByIds } from "./db.js";
import { normalizePresetId, presetById, presetUrl } from "./covers.js";
import {
  getSignedOriginalUrl,
  getSignedOriginalUrls,
  getSignedThumbUrl,
  getSignedThumbUrls,
  invalidateSignedOriginal,
  invalidateSignedThumb,
} from "./media-signed-url-cache.js";
import { getSupabase } from "./supabase-client.js";

function presetResult(presetId, extra = {}) {
  const id = normalizePresetId(presetId);
  return { src: presetUrl(id), kind: "preset", presetId: id, path: "", bucket: "", media: null, fellBack: false, ...extra };
}

function mediaIsUsable(row, vacationId) {
  if (!row || row.deletedAt) return false;
  if (row.type === "video") return false;
  if (vacationId && row.vacationId !== vacationId) return false;
  return true;
}

function pathFor(row, variant) {
  if (variant === "original") return row.storagePath || row.thumbPath || "";
  return row.thumbPath || row.storagePath || "";
}

function bucketFor(row, variant) {
  if (variant === "original" && row.storagePath) return "original";
  return "thumb";
}

/**
 * Titelbild einer Reise: Foto über signierte URL, sonst das Motiv.
 * Gelöschte, fremde oder fehlende Medien fallen auf das Motiv zurück.
 */
export async function resolveVacationCover(vacation, { variant = "thumb" } = {}) {
  const presetId = normalizePresetId(vacation?.cover?.presetId);
  const mediaId = vacation?.cover?.type === "media" ? vacation.cover.mediaId : null;
  if (!mediaId) return presetResult(presetId);
  const [row] = await fetchMediaByIds([mediaId]);
  if (!mediaIsUsable(row, vacation.id)) return presetResult(presetId, { fellBack: true, invalid: true });
  const path = pathFor(row, variant);
  const bucket = bucketFor(row, variant);
  if (!path) return presetResult(presetId, { fellBack: true, invalid: true, media: row });
  const supabase = getSupabase();
  const src =
    bucket === "original"
      ? await getSignedOriginalUrl(supabase, path)
      : await getSignedThumbUrl(supabase, path);
  if (!src) return { ...presetResult(presetId, { fellBack: true, media: row }), path, bucket };
  return { src, kind: "media", presetId, path, bucket, media: row, fellBack: false, invalid: false };
}

/** Gebündelt für die Reiseliste: eine Media-Abfrage, ein createSignedUrls. */
export async function resolveVacationCoverMap(vacations, { variant = "thumb" } = {}) {
  const result = new Map();
  const pending = [];
  for (const vacation of vacations || []) {
    if (!vacation?.id) continue;
    const presetId = normalizePresetId(vacation.cover?.presetId);
    if (vacation.cover?.type === "media" && vacation.cover.mediaId) pending.push(vacation);
    else result.set(vacation.id, presetResult(presetId));
  }
  if (!pending.length) return result;

  const rows = await fetchMediaByIds(pending.map((vacation) => vacation.cover.mediaId));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const thumbPaths = [];
  const originalPaths = [];
  const chosen = [];

  for (const vacation of pending) {
    const presetId = normalizePresetId(vacation.cover?.presetId);
    const row = byId.get(vacation.cover.mediaId);
    if (!mediaIsUsable(row, vacation.id)) {
      result.set(vacation.id, presetResult(presetId, { fellBack: true, invalid: true }));
      continue;
    }
    const path = pathFor(row, variant);
    const bucket = bucketFor(row, variant);
    if (!path) {
      result.set(vacation.id, presetResult(presetId, { fellBack: true, media: row }));
      continue;
    }
    chosen.push({ vacation, row, path, bucket, presetId });
    if (bucket === "original") originalPaths.push(path);
    else thumbPaths.push(path);
  }

  const supabase = getSupabase();
  const [thumbs, originals] = await Promise.all([
    thumbPaths.length ? getSignedThumbUrls(supabase, thumbPaths) : {},
    originalPaths.length ? getSignedOriginalUrls(supabase, originalPaths) : {},
  ]);

  for (const item of chosen) {
    const src = item.bucket === "original" ? originals[item.path] : thumbs[item.path];
    if (!src) {
      result.set(item.vacation.id, presetResult(item.presetId, { fellBack: true, media: item.row }));
      continue;
    }
    result.set(item.vacation.id, {
      src,
      kind: "media",
      presetId: item.presetId,
      path: item.path,
      bucket: item.bucket,
      media: item.row,
      fellBack: false,
    });
  }
  return result;
}

export function coverStatusLabel(vacation, { media = null, places = [] } = {}) {
  const preset = presetById(normalizePresetId(vacation?.cover?.presetId));
  if (vacation?.cover?.type === "media" && vacation.cover.mediaId) {
    const day = media?.day ? dayChipDateLine(media.day) : "";
    const place = (places || []).find((entry) => entry.id === media?.placeId);
    const placeName = place?.name || place?.title || "";
    const parts = ["Foto", day, placeName].filter(Boolean);
    return parts.join(" · ");
  }
  return `Automatisch · Motiv ${preset.label}`;
}

export function bindCoverImage(img, info, vacation, { variant = "thumb" } = {}) {
  if (!img || !info) return;
  img.alt = "";
  img.src = info.src || "";
  img.dataset.coverKind = info.kind || "preset";
  img.onerror = async () => {
    if (img.dataset.coverRetried === "1") return;
    if (info.kind !== "media" || !info.path) return;
    img.dataset.coverRetried = "1";
    if (info.bucket === "original") invalidateSignedOriginal(info.path);
    else invalidateSignedThumb(info.path);
    const again = await resolveVacationCover(vacation, { variant });
    if (again?.src) img.src = again.src;
  };
}
