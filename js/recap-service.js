import { getUserId } from "./auth-service.js";
import { RecapUnavailableError, mapApiError } from "./cloud-errors.js";
import { fetchUploadedPhotosForTrip, getNotesForVacation, getPlacesForVacation } from "./db.js";
import { clampDiaryText } from "./diary-model.js";
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
    sourceText: row.source_text || "",
    basedOn: row.based_on || null,
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

export async function listRecaps(tripId, kind) {
  if (!tripId || !kind) return [];
  const data = await unwrap(
    getSupabase()
      .from("trip_recaps")
      .select("*")
      .eq("trip_id", tripId)
      .eq("kind", kind)
      .is("deleted_at", null)
  );
  return (data || []).map(mapRow).filter((row) => row && !row.deletedAt && row.kind === kind);
}

export function listVideoRecaps(tripId) {
  return listRecaps(tripId, "video");
}

export function listDiaryRecaps(tripId) {
  return listRecaps(tripId, "diary");
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

export async function createVideoDraft(tripId, { version = 1, basedOn = null } = {}) {
  const material = await loadRecapMaterial(tripId);
  const built = buildVideoRecap(material);
  if (!built.ok) return { built, row: null };
  const userId = await getUserId();
  const payload = {
    trip_id: tripId,
    kind: "video",
    status: "draft",
    version: Math.max(1, Number(version) || 1),
    content: built.content,
    feedback: [],
    source_text: null,
  };
  if (basedOn) payload.based_on = basedOn;
  if (userId) payload.created_by = userId;
  const data = await unwrap(getSupabase().from("trip_recaps").insert(payload).select("*").single());
  return { built, row: mapRow(data) };
}

export async function appendRecapFeedback(recap, text) {
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

export async function discardRecapDraft(recapId) {
  if (!recapId) return;
  await unwrap(getSupabase().from("trip_recaps").delete().eq("id", recapId));
}

export const discardVideoDraft = discardRecapDraft;
export const appendVideoFeedback = appendRecapFeedback;

export async function updateRecapContent(recap, content) {
  if (!recap?.id) throw new Error("Entwurf fehlt.");
  const data = await unwrap(
    getSupabase().from("trip_recaps").update({ content }).eq("id", recap.id).select("*").single()
  );
  return mapRow(data);
}

export async function saveDiaryNotes(tripId, sourceText) {
  const text = clampDiaryText(sourceText);
  const rows = await listDiaryRecaps(tripId);
  const notes = rows.find((row) => row.status === "notes" && !row.deletedAt) || null;
  if (notes) {
    const data = await unwrap(
      getSupabase().from("trip_recaps").update({ source_text: text }).eq("id", notes.id).select("*").single()
    );
    return mapRow(data);
  }
  const userId = await getUserId();
  const payload = {
    trip_id: tripId,
    kind: "diary",
    status: "notes",
    version: 1,
    source_text: text,
    content: {},
    feedback: [],
  };
  if (userId) payload.created_by = userId;
  const data = await unwrap(getSupabase().from("trip_recaps").insert(payload).select("*").single());
  return mapRow(data);
}

export async function createDiaryDraft(tripId, { version = 1, basedOn = null, content, sourceText } = {}) {
  if (sourceText != null) await saveDiaryNotes(tripId, sourceText);
  const userId = await getUserId();
  const payload = {
    trip_id: tripId,
    kind: "diary",
    status: "draft",
    version: Math.max(1, Number(version) || 1),
    content: content || {},
    feedback: [],
    source_text: null,
  };
  if (basedOn) payload.based_on = basedOn;
  if (userId) payload.created_by = userId;
  const data = await unwrap(getSupabase().from("trip_recaps").insert(payload).select("*").single());
  return mapRow(data);
}

/**
 * Ersetzt eine finale Fassung, ohne den partiellen Unique-Index
 * trip_recaps_one_final zu verletzen. Die alte Zeile geht zuerst in den
 * Papierkorb (status draft, deleted_at). Schlägt das Freigeben fehl, kommt
 * sie zurück. Das harte Löschen ist danach nur noch Aufräumen.
 * kind kommt von der Zeile (video oder diary).
 */
export async function adoptRecapDraft(recap) {
  if (!recap?.id || !recap.tripId) throw new Error("Entwurf fehlt.");
  const kind = recap.kind || "video";
  const noun = kind === "diary" ? "Das Tagebuch" : "Das Storyboard";
  const supabase = getSupabase();
  const existing = await listRecaps(recap.tripId, kind);
  const previous =
    existing
      .filter((row) => row.status === "final" && row.id !== recap.id && !row.deletedAt)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null;

  if (previous) {
    await unwrap(
      supabase
        .from("trip_recaps")
        .update({ status: "draft", deleted_at: new Date().toISOString() })
        .eq("id", previous.id)
        .select("*")
        .single()
    );
  }

  let promoted;
  try {
    const data = await unwrap(
      supabase
        .from("trip_recaps")
        .update({ status: "final", finalized_at: new Date().toISOString() })
        .eq("id", recap.id)
        .select("*")
        .single()
    );
    promoted = mapRow(data);
  } catch (err) {
    if (!previous) throw err;
    try {
      await unwrap(
        supabase
          .from("trip_recaps")
          .update({
            status: "final",
            deleted_at: null,
            finalized_at: previous.finalizedAt,
          })
          .eq("id", previous.id)
          .select("*")
          .single()
      );
    } catch {
      throw new Error(
        `${noun} konnte nicht übernommen werden. Die bisherige finale Fassung ließ sich nicht zurückholen.`
      );
    }
    throw err;
  }

  if (previous) {
    try {
      await unwrap(supabase.from("trip_recaps").delete().eq("id", previous.id));
    } catch {
      /* Papierkorb bleibt unsichtbar, auch wenn das Löschen scheitert. */
    }
  }
  return promoted;
}

export function adoptVideoDraft(recap) {
  return adoptRecapDraft(recap);
}
