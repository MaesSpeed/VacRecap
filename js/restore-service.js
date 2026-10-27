import {
  deleteVacation,
  deleteVacationData,
  getVacation,
  putMedia,
  putNote,
  putPlace,
  putVacation,
  requestPersistentStorage,
} from "./db.js";
import { inferPhotoExt, inferPhotoMime, inferVideoExt, inferVideoMime } from "./media-file-meta.js";
import { normalizePlace } from "./places.js";
import { ensurePhotoThumbs } from "./ui-place-list.js";
import { computeVacationStats } from "./vacation-stats.js";
import { normalizeVacation } from "./vacation.js";
import { createId } from "./utils.js";
import { ZipReader } from "./zip-reader.js";

const MIN_FREE_RATIO = 0.08;

export class RestoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.userMessage = message;
  }
}

export async function parseBackupZip(file) {
  if (!file) {
    throw new RestoreError("not_zip", "Bitte eine ZIP-Sicherungsdatei wählen.");
  }
  const okType =
    file.type === "application/zip" || file.type === "application/x-zip-compressed";
  const okName = /\.zip$/i.test(String(file.name || ""));
  if (!okType && !okName) {
    throw new RestoreError("not_zip", "Bitte eine ZIP-Sicherungsdatei wählen.");
  }
  const reader = new ZipReader(file);
  await reader.loadCatalog();
  if (!reader.hasPath("reise.json")) {
    throw new RestoreError("no_manifest", "In der ZIP fehlt die Datei reise.json.");
  }
  let manifest;
  try {
    manifest = await reader.readJSON("reise.json");
  } catch {
    throw new RestoreError("bad_manifest", "reise.json konnte nicht gelesen werden.");
  }
  if (manifest?.app !== "Reisetagebuch") {
    throw new RestoreError("wrong_app", "Diese ZIP ist keine Reisetagebuch-Sicherung.");
  }
  if (!manifest?.vacation?.id || !manifest?.vacation?.title) {
    throw new RestoreError("bad_manifest", "reise.json enthält keine gültige Reise.");
  }
  return { reader, manifest };
}

export async function checkStorageForRestore(file) {
  if (!navigator.storage?.estimate) return { ok: true };
  const est = await navigator.storage.estimate();
  const quota = est.quota || 0;
  const usage = est.usage || 0;
  const need = file.size * 1.15;
  if (quota > 0 && usage + need > quota * (1 - MIN_FREE_RATIO)) {
    return {
      ok: false,
      message: "Speicher wird knapp – bitte Platz schaffen oder eine kleinere Sicherung wählen.",
    };
  }
  return { ok: true };
}

export async function vacationIdExists(id) {
  return Boolean(await getVacation(id));
}

function fileMetaFromPath(type, path, manifestMime) {
  const name = path.split("/").pop() || path;
  const mime = manifestMime
    ? manifestMime
    : type === "video"
      ? inferVideoMime({ name, type: "" })
      : inferPhotoMime({ name, type: "" });
  const fake = { name, type: mime };
  const ext = type === "video" ? inferVideoExt(fake) : inferPhotoExt(fake);
  return { mime, ext };
}

function buildIdMap(manifest, { newCopy }) {
  const placeMap = new Map();
  const mediaMap = new Map();
  const noteMap = new Map();
  const vacationId = newCopy ? createId() : manifest.vacation.id;
  for (const p of manifest.places || []) {
    placeMap.set(p.id, newCopy ? createId() : p.id);
  }
  for (const m of manifest.media || []) {
    mediaMap.set(m.path, createId());
  }
  for (const n of manifest.notes || []) {
    noteMap.set(`${n.placeId}|${n.ts}|${n.text}`, createId());
  }
  return { vacationId, placeMap, mediaMap, noteMap };
}

export async function restoreVacationFromZip(
  file,
  {
    duplicateMode = "import",
    onProgress,
    isCancelled = () => false,
  } = {}
) {
  await requestPersistentStorage();
  const { reader, manifest } = await parseBackupZip(file);
  const storage = await checkStorageForRestore(file);
  if (!storage.ok) throw new RestoreError("storage", storage.message);

  const newCopy = duplicateMode === "new-copy";
  const { vacationId, placeMap, mediaMap } = buildIdMap(manifest, { newCopy });
  const rawVacation = manifest.format >= 2 && manifest.vacation?.cover
    ? manifest.vacation
    : {
        id: manifest.vacation.id,
        title: manifest.vacation.title,
        startDate: manifest.vacation.startDate,
        endDate: manifest.vacation.endDate,
      };
  const vacation = normalizeVacation({
    ...rawVacation,
    id: vacationId,
    title: newCopy ? `${rawVacation.title || "Reise"} (eingespielt)` : rawVacation.title,
    updatedAt: Date.now(),
    createdAt: rawVacation.createdAt ?? Date.now(),
  });

  let installedVacationId = null;
  const mediaRecords = [];
  const totalSteps =
    1 + (manifest.places?.length || 0) + (manifest.media?.length || 0) + (manifest.notes?.length || 0) + 2;
  let step = 0;
  const tick = async (label) => {
    step += 1;
    onProgress?.({ percent: Math.min(99, Math.round((step / totalSteps) * 100)), label });
    await new Promise((r) => setTimeout(r, 0));
  };

  try {
    if (isCancelled()) throw new RestoreError("cancelled", "Abgebrochen.");
    await putVacation(vacation);
    installedVacationId = vacationId;
    await tick("Reise angelegt");

    for (const p of manifest.places || []) {
      if (isCancelled()) throw new RestoreError("cancelled", "Abgebrochen.");
      const day = p.day || p.dayDate;
      const place = normalizePlace({
        ...p,
        id: placeMap.get(p.id),
        vacationId,
        day,
        dayDate: day,
      });
      await putPlace(place);
      await tick(`Ort ${place.name || ""}`.trim());
    }

    for (const item of manifest.media || []) {
      if (isCancelled()) throw new RestoreError("cancelled", "Abgebrochen.");
      const placeId = placeMap.get(item.placeId);
      if (!placeId) continue;
      const type = item.type === "video" ? "video" : "photo";
      const { mime, ext } = fileMetaFromPath(type, item.path, item.mime);
      const blob = await reader.readBlob(item.path, mime);
      const place = (manifest.places || []).find((p) => p.id === item.placeId);
      const day = place?.day || place?.dayDate || manifest.days?.[0] || vacation.startDate;
      const record = {
        id: mediaMap.get(item.path) || createId(),
        placeId,
        vacationId,
        day,
        ts: item.ts ?? Date.now(),
        type,
        blob,
        thumbBlob: null,
        mime,
        ext,
        sourceKey: `restore:${item.path}`,
      };
      await putMedia(record);
      mediaRecords.push(record);
      await tick(type === "video" ? "Video" : "Foto");
    }

    for (const n of manifest.notes || []) {
      if (isCancelled()) throw new RestoreError("cancelled", "Abgebrochen.");
      const placeId = placeMap.get(n.placeId);
      if (!placeId) continue;
      const place = (manifest.places || []).find((p) => p.id === n.placeId);
      const day = place?.day || place?.dayDate || vacation.startDate;
      await putNote({
        id: createId(),
        placeId,
        vacationId,
        day,
        ts: n.ts ?? Date.now(),
        text: n.text || "",
      });
      await tick("Notiz");
    }

    if (isCancelled()) throw new RestoreError("cancelled", "Abgebrochen.");
    onProgress?.({ percent: 98, label: "Vorschaubilder", phase: "final" });
    if (isCancelled()) throw new RestoreError("cancelled", "Abgebrochen.");
    await ensurePhotoThumbs(mediaRecords);
    if (isCancelled()) throw new RestoreError("cancelled", "Abgebrochen.");
    await tick("Vorschaubilder");
    if (isCancelled()) throw new RestoreError("cancelled", "Abgebrochen.");
    const stats = await computeVacationStats(vacationId);
    if (isCancelled()) throw new RestoreError("cancelled", "Abgebrochen.");
    await putVacation({ ...vacation, stats: { places: stats.places, photos: stats.photos, notes: stats.notes } });
    if (isCancelled()) throw new RestoreError("cancelled", "Abgebrochen.");
    onProgress?.({ percent: 100, label: "Fertig", phase: "done" });
    return { vacationId, vacation };
  } catch (err) {
    if (installedVacationId) {
      await deleteVacationData(installedVacationId);
      await deleteVacation(installedVacationId);
    }
    if (err instanceof RestoreError) throw err;
    throw new RestoreError("failed", err?.message || "Einspielen fehlgeschlagen.");
  }
}
