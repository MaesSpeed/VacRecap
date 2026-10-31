import { getUserId } from "./auth-service.js";
import { RecapUnavailableError, mapApiError } from "./cloud-errors.js";
import { fetchUploadedPhotosForTrip, getNotesForVacation, getPlacesForVacation } from "./db.js";
import { buildVideoRecap } from "./recap-storyboard.js";
import { getSupabase } from "./supabase-client.js";

function errorBlob(error) {
  return `${error?.code || ""} ${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`;
}

export function isMissingRecapTable(error) {
  const blob = errorBlob(error);
  if (/PGRST205|42P01/i.test(blob)) return true;
  if (/trip_recaps/i.test(blob) && /schema cache|could not find|does not exist|relation/i.test(blob)) return true;
  return false;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tripId: row.trip_id,
    kind: row.kind,
    status: row.status,
    version: row.version || 1,
    content: row.content && typeof row.content === "object" ? row.content : {},
    feedback: Array.isArray(row.feedback) ? row.feedback : [],
    createdBy: row.created_by || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    finalizedAt: row.finalized_at || null,
    deletedAt: row.deleted_at || null,
  };
}

async function unwrap(result) {
  const resolved = await result;
  const { data, error } = resolved || {};
  if (error) {
    if (isMissingRecapTable(error)) throw new RecapUnavailableError();
    throw mapApiError(error);
  }
  return data;
}

export async function listVideoRecaps(tripId) {
  if (!tripId) return [];
  const data = await unwrap(
    getSupabase()
      .from("trip_recaps")
      .select("*")
      .eq("trip_id", tripId)
      .eq("kind", "video")
      .is("deleted_at", null)
  );
  return (data || []).map(mapRow).filter((row) => row && !row.deletedAt);
}

export async function loadRecapMaterial(tripId) {
  const [places, photoResult, notes] = await Promise.all([
    getPlacesForVacation(tripId),
    fetchUploadedPhotosForTrip(tripId),
    getNotesForVacation(tripId),
  ]);
  if (photoResult.error) throw photoResult.error;
  return { places, photos: photoResult.media || [], notes: notes || [] };
}

export async function createVideoDraft(tripId) {
  const material = await loadRecapMaterial(tripId);
  const built = buildVideoRecap(material);
  if (!built.ok) return { built, row: null };
  const userId = await getUserId();
  const payload = {
    trip_id: tripId,
    kind: "video",
    status: "draft",
    version: 1,
    content: built.content,
    feedback: [],
    source_text: null,
  };
  if (userId) payload.created_by = userId;
  const data = await unwrap(getSupabase().from("trip_recaps").insert(payload).select("*").single());
  return { built, row: mapRow(data) };
}

export async function appendVideoFeedback(recap, text) {
  const body = String(text || "").trim();
  if (!recap?.id || !body) return recap;
  const userId = await getUserId();
  const next = [
    ...(Array.isArray(recap.feedback) ? recap.feedback : []),
    {
      at: new Date().toISOString(),
      by: userId,
      version: recap.version || 1,
      text: body,
      status: "open",
    },
  ];
  const data = await unwrap(
    getSupabase().from("trip_recaps").update({ feedback: next }).eq("id", recap.id).select("*").single()
  );
  return mapRow(data);
}

export async function discardVideoDraft(recapId) {
  if (!recapId) return;
  await unwrap(getSupabase().from("trip_recaps").delete().eq("id", recapId));
}

/** Alte finale Fassung löschen, dann diesen Entwurf freigeben. Zwei Aufrufe, wie im Pilot. */
export async function adoptVideoDraft(recap) {
  if (!recap?.id || !recap.tripId) throw new Error("Entwurf fehlt.");
  await unwrap(
    getSupabase()
      .from("trip_recaps")
      .delete()
      .eq("trip_id", recap.tripId)
      .eq("kind", "video")
      .eq("status", "final")
  );
  const data = await unwrap(
    getSupabase()
      .from("trip_recaps")
      .update({ status: "final", finalized_at: new Date().toISOString() })
      .eq("id", recap.id)
      .select("*")
      .single()
  );
  return mapRow(data);
}
