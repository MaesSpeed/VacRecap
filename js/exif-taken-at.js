const TYPE_SIZE = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  7: 1,
  9: 4,
  10: 8,
};

const JPEG_SCAN_BYTES = 1024 * 1024;
const HEIC_SCAN_BYTES = 25 * 1024 * 1024;

function parseExifDateTime(str) {
  if (!str || typeof str !== "string") return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str.trim());
  if (!m) return null;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6])
  );
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

function readAscii(view, offset, len) {
  const end = Math.min(view.byteLength, offset + len);
  let s = "";
  for (let i = offset; i < end; i++) s += String.fromCharCode(view.getUint8(i));
  return s.replace(/\0/g, "").trim();
}

function readComponent(view, offset, type, le) {
  if (offset + (TYPE_SIZE[type] || 1) > view.byteLength) return null;
  if (type === 1 || type === 7) return view.getUint8(offset);
  if (type === 3) return view.getUint16(offset, le);
  if (type === 4) return view.getUint32(offset, le);
  if (type === 9) return view.getInt32(offset, le);
  if (type === 5 || type === 10) {
    const num = type === 10 ? view.getInt32(offset, le) : view.getUint32(offset, le);
    const den = type === 10 ? view.getInt32(offset + 4, le) : view.getUint32(offset + 4, le);
    if (!den) return null;
    return num / den;
  }
  return null;
}

function dataOffset(view, tiffStart, entry, type, count, le) {
  const size = (TYPE_SIZE[type] || 1) * count;
  const valueField = entry + 8;
  if (size <= 4) return valueField;
  const rel = view.getUint32(valueField, le);
  const abs = tiffStart + rel;
  if (abs < 0 || abs >= view.byteLength) return null;
  return abs;
}

function readGpsTriplet(view, tiffStart, entry, type, count, le) {
  if (count < 3 || (type !== 5 && type !== 10)) return null;
  const pos = dataOffset(view, tiffStart, entry, type, count, le);
  if (pos == null) return null;
  const step = TYPE_SIZE[type];
  const deg = readComponent(view, pos, type, le);
  const min = readComponent(view, pos + step, type, le);
  const sec = readComponent(view, pos + step * 2, type, le);
  if (deg == null || min == null || sec == null) return null;
  return deg + min / 60 + sec / 3600;
}

/**
 * Liest DateTimeOriginal und GPS aus einem TIFF-IFD (JPEG-APP1 oder HEIC-Exif).
 * @returns {{ takenAt: number|null, latitude: number|null, longitude: number|null }}
 */
export function parseExifTiff(view, tiffStart) {
  const empty = { takenAt: null, latitude: null, longitude: null };
  if (tiffStart + 8 > view.byteLength) return empty;
  const endian = view.getUint16(tiffStart);
  if (endian !== 0x4949 && endian !== 0x4d4d) return empty;
  const le = endian === 0x4949;
  if (view.getUint16(tiffStart + 2, le) !== 0x002a) return empty;
  const ifd0 = view.getUint32(tiffStart + 4, le);
  if (!Number.isFinite(ifd0)) return empty;

  const found = { takenAt: null, latitude: null, longitude: null, latRef: "N", lngRef: "E" };

  function walk(ifdOffset, depth) {
    if (depth > 4) return;
    const base = tiffStart + ifdOffset;
    if (base + 2 > view.byteLength) return;
    const count = view.getUint16(base, le);
    if (count > 256) return;
    for (let i = 0; i < count; i++) {
      const entry = base + 2 + i * 12;
      if (entry + 12 > view.byteLength) return;
      const tag = view.getUint16(entry, le);
      const type = view.getUint16(entry + 2, le);
      const comp = view.getUint32(entry + 4, le);
      if (tag === 0x8769 && type === 4) {
        walk(view.getUint32(entry + 8, le), depth + 1);
        continue;
      }
      if (tag === 0x8825 && type === 4) {
        walk(view.getUint32(entry + 8, le), depth + 1);
        continue;
      }
      if (tag === 0x9003 && type === 2 && comp >= 10 && found.takenAt == null) {
        const pos = dataOffset(view, tiffStart, entry, type, comp, le);
        if (pos != null) found.takenAt = parseExifDateTime(readAscii(view, pos, Math.min(comp, 32)));
      }
      if (tag === 0x0001 && type === 2) {
        const pos = dataOffset(view, tiffStart, entry, type, comp, le);
        const ref = pos == null ? "" : readAscii(view, pos, Math.max(comp, 1));
        if (ref) found.latRef = ref.slice(0, 1).toUpperCase();
      }
      if (tag === 0x0003 && type === 2) {
        const pos = dataOffset(view, tiffStart, entry, type, comp, le);
        const ref = pos == null ? "" : readAscii(view, pos, Math.max(comp, 1));
        if (ref) found.lngRef = ref.slice(0, 1).toUpperCase();
      }
      if (tag === 0x0002 && found.latitude == null) {
        const value = readGpsTriplet(view, tiffStart, entry, type, comp, le);
        if (value != null) found.latitude = value;
      }
      if (tag === 0x0004 && found.longitude == null) {
        const value = readGpsTriplet(view, tiffStart, entry, type, comp, le);
        if (value != null) found.longitude = value;
      }
    }
  }

  try {
    walk(ifd0, 0);
  } catch {
    return empty;
  }

  let latitude = found.latitude;
  let longitude = found.longitude;
  if (latitude != null && found.latRef === "S") latitude = -Math.abs(latitude);
  if (longitude != null && found.lngRef === "W") longitude = -Math.abs(longitude);
  if (latitude != null && (latitude < -90 || latitude > 90)) latitude = null;
  if (longitude != null && (longitude < -180 || longitude > 180)) longitude = null;
  return { takenAt: found.takenAt, latitude, longitude };
}

function parseJpegExif(view) {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) break;
    const marker = view.getUint8(offset + 1);
    if (marker === 0xda || marker === 0xd9) break;
    const size = view.getUint16(offset + 2);
    if (size < 2) break;
    if (marker === 0xe1 && size > 8) {
      const header = readAscii(view, offset + 4, 4);
      if (header === "Exif") {
        return parseExifTiff(view, offset + 10);
      }
    }
    offset += 2 + size;
  }
  return null;
}

function findEmbeddedExif(view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  for (let i = 0; i + 14 < bytes.length; i++) {
    if (
      bytes[i] === 0x45 &&
      bytes[i + 1] === 0x78 &&
      bytes[i + 2] === 0x69 &&
      bytes[i + 3] === 0x66 &&
      bytes[i + 4] === 0 &&
      bytes[i + 5] === 0
    ) {
      const endian = bytes[i + 6];
      if (endian === 0x49 || endian === 0x4d) {
        const parsed = parseExifTiff(view, i + 6);
        if (parsed.takenAt != null || parsed.latitude != null || parsed.longitude != null) return parsed;
      }
    }
  }
  return null;
}

function isHeic(file) {
  const mime = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  return mime.includes("heic") || mime.includes("heif") || name.endsWith(".heic") || name.endsWith(".heif");
}

function isJpeg(file) {
  const mime = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  return mime.includes("jpeg") || mime.includes("jpg") || name.endsWith(".jpg") || name.endsWith(".jpeg");
}

async function fileView(file) {
  const limit = isHeic(file) ? HEIC_SCAN_BYTES : JPEG_SCAN_BYTES;
  const size = Math.min(file.size || 0, limit);
  if (!size) return null;
  const buf = await file.slice(0, size).arrayBuffer();
  return new DataView(buf);
}

/**
 * DateTimeOriginal und GPSLatitude/GPSLongitude (inkl. Ref) aus JPEG oder HEIC.
 * @returns {Promise<{ takenAt: number|null, latitude: number|null, longitude: number|null }>}
 */
function dropNullIsland(parsed) {
  if (!parsed) return parsed;
  if (Number(parsed.latitude) === 0 && Number(parsed.longitude) === 0) {
    return { ...parsed, latitude: null, longitude: null };
  }
  return parsed;
}

export async function readPhotoExif(file) {
  const empty = { takenAt: null, latitude: null, longitude: null };
  if (!file) return empty;
  if (!isJpeg(file) && !isHeic(file)) return empty;
  try {
    const view = await fileView(file);
    if (!view) return empty;
    if (isJpeg(file)) {
      const jpeg = parseJpegExif(view);
      if (jpeg) return dropNullIsland(jpeg);
    }
    return dropNullIsland(findEmbeddedExif(view)) || empty;
  } catch {
    return empty;
  }
}

/**
 * Liest DateTimeOriginal aus JPEG- oder HEIC-EXIF (falls vorhanden).
 * @returns {Promise<number|null>} ms since epoch
 */
export async function readPhotoTakenAt(file) {
  const exif = await readPhotoExif(file);
  return exif.takenAt;
}
