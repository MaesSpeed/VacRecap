import { BUCKET_ORIGINALS, BUCKET_THUMBS } from "./cloud-media-paths.js";
import { getSupabase } from "./supabase-client.js";

export async function deleteMediaStorageObjects(storagePath, thumbPath = null) {
  if (!storagePath) return;
  const supabase = getSupabase();
  const thumb = thumbPath || storagePath;
  await supabase.storage.from(BUCKET_ORIGINALS).remove([storagePath]).catch(() => {});
  await supabase.storage.from(BUCKET_THUMBS).remove([thumb]).catch(() => {});
}
