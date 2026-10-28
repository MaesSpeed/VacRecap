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
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s.replace(/\0/g, "").trim();
}

function findDateTimeOriginalInIfd(view, tiffStart, ifdOffset, littleEndian) {
  const count = view.getUint16(tiffStart + ifdOffset, littleEndian);
  for (let i = 0; i < count; i++) {
    const entry = tiffStart + ifdOffset + 2 + i * 12;
    const tag = view.getUint16(entry, littleEndian);
    const type = view.getUint16(entry + 2, littleEndian);
    const comp = view.getUint32(entry + 4, littleEndian);
    const valOff = view.getUint32(entry + 8, littleEndian);
    if (tag === 0x8769 && type === 4) {
      return findDateTimeOriginalInIfd(view, tiffStart, valOff, littleEndian);
    }
    if (tag === 0x9003 && type === 2 && comp >= 10) {
      const str = readAscii(view, tiffStart + valOff, Math.min(comp - 1, 20));
      return parseExifDateTime(str);
    }
  }
  return null;
}

/**
 * Liest DateTimeOriginal aus JPEG-EXIF (falls vorhanden).
 * @returns {number|null} ms since epoch
 */
export async function readPhotoTakenAt(file) {
  if (!file) return null;
  const mime = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  if (!mime.includes("jpeg") && !mime.includes("jpg") && !name.endsWith(".jpg") && !name.endsWith(".jpeg")) {
    return null;
  }
  try {
    const buf = await file.slice(0, Math.min(file.size, 512 * 1024)).arrayBuffer();
    const view = new DataView(buf);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
    let offset = 2;
    while (offset + 4 < view.byteLength) {
      if (view.getUint8(offset) !== 0xff) break;
      const marker = view.getUint8(offset + 1);
      const size = view.getUint16(offset + 2);
      if (marker === 0xe1 && size > 8) {
        const exifHeader = readAscii(view, offset + 4, 4);
        if (exifHeader === "Exif") {
          const tiffStart = offset + 10;
          if (tiffStart + 8 >= view.byteLength) return null;
          const le = view.getUint16(tiffStart) === 0x4949;
          const ifd0 = view.getUint32(tiffStart + 4, le);
          return findDateTimeOriginalInIfd(view, tiffStart, ifd0, le);
        }
      }
      if (marker === 0xda || size < 2) break;
      offset += 2 + size;
    }
  } catch {
    return null;
  }
  return null;
}
