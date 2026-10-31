import { getUserId } from "./auth-service.js";
import { getSupabase } from "./supabase-client.js";

const roleCache = new Map();
const roleLoadFailed = new Set();

export function tripRoleLoadFailed(tripId) {
  return Boolean(tripId) && roleLoadFailed.has(tripId);
}

export async function getMyTripRole(tripId) {
  if (!tripId) return "owner";
  if (roleCache.has(tripId)) return roleCache.get(tripId);
  try {
    const uid = await getUserId();
    if (!uid) return "owner";
    const { data, error } = await getSupabase()
      .from("trip_members")
      .select("role")
      .eq("trip_id", tripId)
      .eq("user_id", uid)
      .maybeSingle();
    if (error) {
      roleLoadFailed.add(tripId);
      roleCache.set(tripId, "owner");
      return "owner";
    }
    roleLoadFailed.delete(tripId);
    const role = data?.role || "owner";
    roleCache.set(tripId, role);
    return role;
  } catch {
    roleLoadFailed.add(tripId);
    roleCache.set(tripId, "owner");
    return "owner";
  }
}

export function canEditTripMedia(role) {
  return role === "owner" || role === "editor";
}

export const ROLE_UNKNOWN_MESSAGE = "Rolle konnte nicht geladen werden. Bitte später erneut versuchen.";

/**
 * true: darf bearbeiten. false: kein Bearbeiten.
 * Ein Rollenfehler ist false und kein Gast: die Seite zeigt dann eine
 * vorhandene finale Fassung, sonst die Meldung zum Rollenfehler.
 */
export async function resolveTripEditing(tripId) {
  const role = await getMyTripRole(tripId);
  if (tripRoleLoadFailed(tripId)) return false;
  return canEditTripMedia(role);
}

/** Eine Abfrage für die Rollen der sichtbaren Reisen. Fehlt eine Zeile, gilt Besitzer. */
export async function listMyTripRoles(tripIds) {
  const ids = [...new Set((tripIds || []).filter(Boolean))];
  const roles = new Map();
  if (!ids.length) return { failed: false, roles, userId: null };
  let userId = null;
  const remember = (id, role) => {
    roles.set(id, role);
    roleCache.set(id, role);
    roleLoadFailed.delete(id);
  };
  try {
    userId = await getUserId();
    if (!userId) {
      ids.forEach((id) => remember(id, "owner"));
      return { failed: false, roles, userId };
    }
    const { data, error } = await getSupabase()
      .from("trip_members")
      .select("trip_id, role")
      .eq("user_id", userId)
      .in("trip_id", ids);
    if (error) throw error;
    for (const row of data || []) {
      if (!row?.trip_id) continue;
      remember(row.trip_id, row.role || "owner");
    }
    for (const id of ids) {
      if (!roles.has(id)) remember(id, "owner");
    }
    return { failed: false, roles, userId };
  } catch {
    ids.forEach((id) => {
      roleCache.delete(id);
      roleLoadFailed.add(id);
    });
    return { failed: true, roles: new Map(), userId };
  }
}

export function clearTripRoleCache(tripId) {
  if (tripId) {
    roleCache.delete(tripId);
    roleLoadFailed.delete(tripId);
  } else {
    roleCache.clear();
    roleLoadFailed.clear();
  }
}
