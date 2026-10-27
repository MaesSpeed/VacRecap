import {
  getAllMediaForVacation,
  getNotesForPlace,
  getPlacesForVacation,
  getVacation,
} from "./db.js";
import { vacationDays } from "./days.js";
import { parseIsoDate } from "./utils.js";
import { ZipWriter } from "./zip-builder.js";

const WEEKDAYS_SHORT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
export const MAX_ZIP_BYTES = 3.5 * 1024 * 1024 * 1024;

export function sanitizeBackupBaseName(title) {
  return (
    (title || "Reise")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9äöüÄÖÜß\-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "Reise"
  );
}

export function backupZipFilename(vacation) {
  const base = sanitizeBackupBaseName(vacation.title);
  const [y, m] = (vacation.startDate || "").split("-");
  return `${base}-${y || "0000"}-${m || "00"}.zip`;
}

function dayFolderName(dayIso) {
  const d = parseIsoDate(dayIso);
  const wd = WEEKDAYS_SHORT[d.getDay()];
  return `${dayIso}_${wd}`;
}

function timePrefixHms(ts) {
  const d = new Date(ts);
  return [
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0"),
  ].join("-");
}

function timePrefixHm(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}-${String(d.getMinutes()).padStart(2, "0")}`;
}

function sanitizePathPart(name) {
  return (
    (name || "Ort")
      .trim()
      .replace(/[/\\:*?"<>|]/g, "-")
      .replace(/\s+/g, "_")
      .slice(0, 60) || "Ort"
  );
}

function uniquePath(used, path) {
  if (!used.has(path)) {
    used.set(path, 1);
    return path;
  }
  const n = used.get(path) + 1;
  used.set(path, n);
  const dot = path.lastIndexOf(".");
  if (dot < 0) return `${path}-${n}`;
  return `${path.slice(0, dot)}-${n}${path.slice(dot)}`;
}

function buildLiesmich(vacation) {
  const created = new Date().toLocaleString("de-DE");
  return `Reisetagebuch – Sicherung dieser Reise
========================

Reise: ${vacation.title}
Erstellt: ${created}

Inhalt:
- Ordner pro Tag und Ort mit Fotos, Videos und notizen.txt
- reise.json mit Metadaten (Orte, Medien, Notizen)
- Weiche Punkte nur in reise.json

Diese Datei wurde mit der PWA «Reisetagebuch» erstellt.
`;
}

function buildReiseJson(vacation, allPlaces, mediaFiles) {
  const days = vacationDays(vacation);
  return {
    format: 2,
    app: "Reisetagebuch",
    exportedAt: new Date().toISOString(),
    vacation: {
      id: vacation.id,
      title: vacation.title,
      startDate: vacation.startDate,
      endDate: vacation.endDate,
      createdAt: vacation.createdAt,
      updatedAt: vacation.updatedAt,
      author: vacation.author,
      cover: vacation.cover,
      companions: vacation.companions,
      stats: vacation.stats,
    },
    days,
    places: allPlaces.map((p) => ({
      id: p.id,
      day: p.day || p.dayDate,
      name: p.name,
      ts: p.ts,
      lat: p.lat,
      lng: p.lng,
      accuracy: p.accuracy,
      soft: Boolean(p.soft),
    })),
    media: mediaFiles,
    notes: mediaFiles._notes || [],
  };
}

export async function gatherBackupStats(vacationId, { daysFilter = null } = {}) {
  const vacation = await getVacation(vacationId);
  if (!vacation) return null;
  const allPlaces = await getPlacesForVacation(vacationId);
  const hardPlaces = allPlaces.filter((p) => !p.soft);
  const allMedia = await getAllMediaForVacation(vacationId);
  const days = vacationDays(vacation).filter((d) => !daysFilter || daysFilter.includes(d));

  let photos = 0;
  let videos = 0;
  let notes = 0;
  let totalBytes = 0;

  for (const day of days) {
    const dayPlaces = hardPlaces.filter((p) => (p.day || p.dayDate) === day);
    for (const place of dayPlaces) {
      const notesList = await getNotesForPlace(place.id);
      notes += notesList.length;
      for (const m of allMedia.filter((x) => x.placeId === place.id)) {
        if (m.type === "video") videos += 1;
        else photos += 1;
        totalBytes += m.blob?.size || 0;
      }
      for (const n of notesList) {
        totalBytes += new Blob([n.text || ""]).size;
      }
    }
  }

  return {
    vacation,
    days,
    hardPlaces,
    allPlaces,
    allMedia,
    photos,
    videos,
    notes,
    placeCount: hardPlaces.length,
    totalBytes,
    isEmpty: hardPlaces.length === 0,
    tooLarge: totalBytes > MAX_ZIP_BYTES,
  };
}

export async function buildVacationZip(vacationId, { onProgress, daysFilter = null } = {}) {
  const stats = await gatherBackupStats(vacationId, { daysFilter });
  if (!stats) throw new Error("missing vacation");
  const { vacation, days, hardPlaces, allPlaces, allMedia } = stats;
  const zip = new ZipWriter();
  const used = new Map();
  const mediaManifest = [];
  const notesManifest = [];

  let totalWork = 2;
  for (const day of days) {
    for (const place of hardPlaces.filter((p) => (p.day || p.dayDate) === day)) {
      totalWork += allMedia.filter((m) => m.placeId === place.id).length;
      const notesList = await getNotesForPlace(place.id);
      if (notesList.length) totalWork += 1;
    }
  }
  let step = 0;
  const bump = async () => {
    step += 1;
    onProgress?.(Math.min(99, Math.round((step / totalWork) * 100)));
    await new Promise((r) => setTimeout(r, 0));
  };

  for (const day of days) {
    const dayPlaces = hardPlaces
      .filter((p) => (p.day || p.dayDate) === day)
      .sort((a, b) => a.ts - b.ts);
    for (const place of dayPlaces) {
      const placeDir = `${dayFolderName(day)}/${timePrefixHm(place.ts)}_${sanitizePathPart(place.name)}`;
      const media = allMedia.filter((m) => m.placeId === place.id).sort((a, b) => a.ts - b.ts);
      for (const m of media) {
        const ext = m.ext || (m.type === "video" ? "mp4" : "jpg");
        const kind = m.type === "video" ? "video" : "foto";
        let rel = `${placeDir}/${timePrefixHms(m.ts)}_${kind}.${ext}`;
        rel = uniquePath(used, rel);
        await zip.addFile(rel, m.blob, { ts: m.ts });
        mediaManifest.push({
          path: rel,
          type: m.type,
          ts: m.ts,
          size: m.blob?.size || 0,
          placeId: place.id,
          mime: m.mime || null,
        });
        await bump();
      }
      const notesList = (await getNotesForPlace(place.id)).sort((a, b) => a.ts - b.ts);
      if (notesList.length) {
        const text = notesList.map((n) => (n.text || "").trim()).filter(Boolean).join("\n\n");
        const rel = `${placeDir}/notizen.txt`;
        await zip.addTextFile(rel, `${text}\n`, { ts: notesList[0].ts });
        for (const n of notesList) {
          notesManifest.push({
            placeId: place.id,
            ts: n.ts,
            text: n.text,
            file: rel,
          });
        }
        await bump();
      }
    }
  }

  const placesForManifest = daysFilter
    ? allPlaces.filter((p) => days.includes(p.day || p.dayDate))
    : allPlaces;
  const reise = buildReiseJson(vacation, placesForManifest, mediaManifest);
  if (daysFilter) {
    reise.days = days;
  }
  reise.notes = notesManifest;
  await zip.addTextFile("reise.json", JSON.stringify(reise, null, 2), { ts: Date.now() });
  await bump();
  await zip.addTextFile("LIESMICH.txt", buildLiesmich(vacation), { ts: Date.now() });
  await bump();

  onProgress?.(100);
  const blob = zip.finalize();
  return {
    blob,
    filename: backupZipFilename(vacation),
    stats,
  };
}

export async function deliverBackupFile(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Sicherung" });
      return { method: "share" };
    } catch (err) {
      if (err?.name === "AbortError") return { aborted: true };
      throw err;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(url);
  return { method: "download" };
}
