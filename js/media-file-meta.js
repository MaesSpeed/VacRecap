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
  return "image/jpeg";
}

export function inferVideoMime(file) {
  if (file.type) return file.type;
  const ext = inferVideoExt(file);
  if (ext === "mov") return "video/quicktime";
  return "video/mp4";
}
