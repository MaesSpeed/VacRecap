export function buildMediaSourceKey(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

export function formatBytesShort(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  if (mb < 10) return `${mb.toFixed(1).replace(".", ",")} MB`;
  return `${Math.round(mb)} MB`;
}

export function formatAddedToast({ photos, videos }) {
  const parts = [];
  if (photos > 0) parts.push(`${photos} Foto${photos === 1 ? "" : "s"}`);
  if (videos > 0) parts.push(`${videos} Video${videos === 1 ? "" : "s"}`);
  if (parts.length === 1) return `${parts[0]} hinzugefügt`;
  return `${parts[0]} und ${parts[1]} hinzugefügt`;
}
