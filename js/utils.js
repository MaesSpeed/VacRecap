const WEEKDAYS_SHORT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

export function createId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export function todayIso() {
  return formatIsoDate(new Date());
}

export function parseIsoDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function utcDayIndex(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function isoFromUtcDayIndex(index) {
  const d = new Date(index * 86400000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatDateShort(iso) {
  const date = parseIsoDate(iso);
  const wd = WEEKDAYS_SHORT[date.getDay()];
  const d = date.getDate();
  const m = date.getMonth() + 1;
  const y = date.getFullYear();
  return `${wd} ${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y}`;
}

/** Kartenzeile: Fr 06.11. – So 08.11.2026 · 3 Tage */
export function formatDatePart(iso, withYear = true) {
  const date = parseIsoDate(iso);
  const wd = WEEKDAYS_SHORT[date.getDay()];
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  if (withYear) return `${wd} ${d}.${m}.${date.getFullYear()}`;
  return `${wd} ${d}.${m}.`;
}

export function formatDateRangeCard(startIso, endIso) {
  const days = dayCountInclusive(startIso, endIso);
  if (days === 1) {
    return `${formatDatePart(startIso, true)} · 1 Tag`;
  }
  return `${formatDatePart(startIso, false)} – ${formatDatePart(endIso, true)} · ${days} Tage`;
}

export function formatDateRangeOverlay(startIso, endIso) {
  const sy = parseIsoDate(startIso).getFullYear();
  const ey = parseIsoDate(endIso).getFullYear();
  const startWithYear = sy !== ey;
  if (dayCountInclusive(startIso, endIso) === 1) {
    return formatDatePart(startIso, true);
  }
  return `${formatDatePart(startIso, startWithYear)} – ${formatDatePart(endIso, true)}`;
}

export function formatDateRange(startIso, endIso) {
  return formatDateRangeOverlay(startIso, endIso);
}

export function dayCountInclusive(startIso, endIso) {
  return utcDayIndex(endIso) - utcDayIndex(startIso) + 1;
}

export function enumerateDays(startIso, endIso) {
  const days = [];
  let i = utcDayIndex(startIso);
  const end = utcDayIndex(endIso);
  while (i <= end) {
    days.push(isoFromUtcDayIndex(i));
    i += 1;
  }
  return days;
}

export function tripStatus(startIso, endIso, refIso = todayIso()) {
  if (refIso < startIso) return "upcoming";
  if (refIso > endIso) return "past";
  return "current";
}

export function currentDayIndex(startIso, endIso, refIso = todayIso()) {
  const days = enumerateDays(startIso, endIso);
  const idx = days.indexOf(refIso);
  return idx >= 0 ? idx + 1 : 1;
}

export function daysUntilStart(startIso, refIso = todayIso()) {
  const start = parseIsoDate(startIso);
  const ref = parseIsoDate(refIso);
  return Math.round((start - ref) / 86400000);
}

export function formatCountdown(daysUntil) {
  if (daysUntil <= 0) return "heute";
  if (daysUntil === 1) return "in 1 Tag";
  if (daysUntil < 30) return `in ${daysUntil} Tagen`;
  const months = Math.round(daysUntil / 30);
  if (months === 1) return "in 1 Monat";
  return `in ${months} Monaten`;
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function initialsFromNames(names) {
  const colors = ["#0066B3", "#e67e22", "#2e7d32", "#8e44ad", "#c0392b"];
  return names.slice(0, 3).map((name, i) => ({
    label: name.trim().charAt(0).toUpperCase() || "?",
    color: colors[i % colors.length],
  }));
}

export async function resizeImageFile(file, maxSize = 900) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.85)
  );
  return blob;
}
