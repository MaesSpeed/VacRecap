export function inferPhotoExt(file) {
  const mime = (file.type || "").toLowerCase();
  const name = file.name || "";
  if (name.includes(".")) {
    const ext = name.split(".").pop().toLowerCase();
    if (ext) return ext === "jpeg" ? "jpg" : ext;
  }
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("heic") || mime.includes("heif")) return "heic";
  return "jpg";
}

export function inferVideoExt(file) {
  const mime = (file.type || "").toLowerCase();
  const name = file.name || "";
  if (name.includes(".")) {
    const ext = name.split(".").pop().toLowerCase();
    if (ext) return ext;
  }
  if (mime.includes("quicktime")) return "mov";
  return "mp4";
}

export function inferPhotoMime(file) {
  if (file.type) return file.type;
  const ext = inferPhotoExt(file);
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic" || ext === "heif") return "image/heic";
  if (ext === "gif") return "image/gif";
  return "image/jpeg";
}

export function inferVideoMime(file) {
  if (file.type) return file.type;
  const ext = inferVideoExt(file);
  if (ext === "mov") return "video/quicktime";
  if (ext === "m4v") return "video/mp4";
  return "video/mp4";
}

export function shareFileNameForMedia(item) {
  const ext = item.ext || (item.type === "video" ? "mp4" : "jpg");
  const prefix = item.type === "video" ? "VID" : "IMG";
  const tag = (item.id || "media").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "export";
  return `${prefix}_${tag}.${ext}`;
}

export function createShareFileFromMedia(item) {
  const name = shareFileNameForMedia(item);
  const mime =
    item.mime ||
    (item.type === "video"
      ? item.ext === "mov"
        ? "video/quicktime"
        : "video/mp4"
      : "image/jpeg");
  return new File([item.blob], name, { type: mime });
}
