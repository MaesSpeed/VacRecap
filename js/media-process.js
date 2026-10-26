const PHOTO_MAX_EDGE = 2000;
const PHOTO_QUALITY = 0.85;
const THUMB_EDGE = 200;
const THUMB_QUALITY = 0.8;

export function formatMediaDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

async function loadImageBitmap(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      return await createImageBitmap(file);
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawToCanvas(source, maxEdge) {
  const sw = source.width;
  const sh = source.height;
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, 0, 0, w, h);
  return { canvas, w, h };
}

function canvasToJpegBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("encode failed"));
    }, "image/jpeg", quality);
  });
}

export async function processPhotoFile(file) {
  const bitmap = await loadImageBitmap(file);
  const full = drawToCanvas(bitmap, PHOTO_MAX_EDGE);
  const thumb = drawToCanvas(bitmap, THUMB_EDGE);
  if (bitmap.close) bitmap.close();

  const blob = await canvasToJpegBlob(full.canvas, PHOTO_QUALITY);
  const thumbBlob = await canvasToJpegBlob(thumb.canvas, PHOTO_QUALITY);
  return {
    blob,
    thumbBlob,
    w: full.w,
    h: full.h,
    type: "photo",
  };
}

/** Original unverändert, nur Thumbnail (Paket 3b-2). */
export async function processPhotoOriginal(file) {
  const bitmap = await loadImageBitmap(file);
  const w = bitmap.width;
  const h = bitmap.height;
  const thumb = drawToCanvas(bitmap, THUMB_EDGE);
  if (bitmap.close) bitmap.close();
  const thumbBlob = await canvasToJpegBlob(thumb.canvas, THUMB_QUALITY);
  return {
    blob: file,
    thumbBlob,
    w,
    h,
    type: "photo",
  };
}

export async function createPhotoThumbFromFile(file) {
  const bitmap = await loadImageBitmap(file);
  const thumb = drawToCanvas(bitmap, THUMB_EDGE);
  if (bitmap.close) bitmap.close();
  return canvasToJpegBlob(thumb.canvas, THUMB_QUALITY);
}

export async function createPhotoThumbFromBlob(blob) {
  const bitmap = await loadImageBitmap(blob);
  const thumb = drawToCanvas(bitmap, THUMB_EDGE);
  if (bitmap.close) bitmap.close();
  return canvasToJpegBlob(thumb.canvas, THUMB_QUALITY);
}

function neutralThumbBlob() {
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_EDGE;
  canvas.height = THUMB_EDGE;
  const ctx = canvas.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, THUMB_EDGE, THUMB_EDGE);
  g.addColorStop(0, "#c5d4e8");
  g.addColorStop(1, "#9fb3cc");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, THUMB_EDGE, THUMB_EDGE);
  return canvasToJpegBlob(canvas, 0.85);
}

export async function processVideoFile(file) {
  const blob = file;
  const url = URL.createObjectURL(blob);
  let thumbBlob;
  let w = 0;
  let h = 0;
  let duration = 0;

  try {
    const meta = await new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.onloadedmetadata = () => {
        duration = Number.isFinite(video.duration) ? video.duration : 0;
        w = video.videoWidth || 0;
        h = video.videoHeight || 0;
        resolve(video);
      };
      video.onerror = () => reject(new Error("video meta"));
      video.src = url;
    });

    thumbBlob = await new Promise((resolve) => {
      const video = meta;
      const seek = () => {
        const canvas = document.createElement("canvas");
        const tw = Math.min(THUMB_EDGE, video.videoWidth || THUMB_EDGE);
        const th = Math.min(THUMB_EDGE, video.videoHeight || THUMB_EDGE);
        canvas.width = tw || THUMB_EDGE;
        canvas.height = th || THUMB_EDGE;
        const ctx = canvas.getContext("2d");
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(
            (b) => resolve(b || null),
            "image/jpeg",
            0.85
          );
        } catch {
          resolve(null);
        }
      };
      video.currentTime = Math.min(0.1, duration || 0.1);
      video.onseeked = seek;
      video.onerror = () => resolve(null);
      setTimeout(() => resolve(null), 2000);
    });
  } catch {
    /* fallback below */
  } finally {
    URL.revokeObjectURL(url);
  }

  if (!thumbBlob) {
    thumbBlob = await neutralThumbBlob();
  }

  return {
    blob,
    thumbBlob,
    w,
    h,
    duration,
    durationLabel: formatMediaDuration(duration),
    type: "video",
  };
}
