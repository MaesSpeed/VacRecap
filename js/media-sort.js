import {
  CloudNetworkError,
  CloudOfflineError,
  MediaSortUnavailableError,
  isFetchNetworkFailure,
  mapApiError,
} from "./cloud-errors.js";
import { getSupabase } from "./supabase-client.js";

function errorBlob(error) {
  return `${error?.code || ""} ${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`;
}

function mapSortError(error) {
  if (!navigator.onLine) {
    return new CloudOfflineError("Du bist offline. Die Reihenfolge bleibt unverändert.");
  }
  if (isFetchNetworkFailure(error)) {
    return new CloudNetworkError("Die Reihenfolge konnte nicht gespeichert werden. Bitte Verbindung prüfen.");
  }
  const blob = errorBlob(error);
  if (/42501|Berechtigung|row-level security/i.test(blob)) {
    return new Error("Dafür fehlt die Berechtigung.");
  }
  if (/PGRST202|42883|PGRST204|42703|schema cache|could not find the function|could not find the 'sort_order'|sort_order/i.test(blob)) {
    return new MediaSortUnavailableError();
  }
  return mapApiError(error);
}

async function callSortRpc(args) {
  if (!navigator.onLine) {
    throw new CloudOfflineError("Du bist offline. Die Reihenfolge bleibt unverändert.");
  }
  const { error } = await getSupabase().rpc("set_place_media_order", args);
  if (error) throw mapSortError(error);
}

/** Speichert die Reihenfolge der Medien eines Orts. taken_at bleibt unberührt. */
export function savePlaceMediaOrder(waypointId, mediaIds) {
  return callSortRpc({
    p_waypoint_id: waypointId,
    p_media_ids: mediaIds,
    p_reset: false,
  });
}

/** Setzt sort_order auf null. Danach gilt wieder die Aufnahmezeit. */
export function clearPlaceMediaOrder(waypointId) {
  return callSortRpc({
    p_waypoint_id: waypointId,
    p_media_ids: [],
    p_reset: true,
  });
}
