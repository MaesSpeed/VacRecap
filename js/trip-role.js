import { getUserId } from "./auth-service.js";
import { readCache } from "./local-cache.js";
import { getSupabase } from "./supabase-client.js";

const roleCache = new Map();
const confirmedRoles = new Map();
const roleLoadFailed = new Set();
const roleInflight = new Map();

export const ROLE_LABEL = {
  owner: "Besitzer",
  editor: "Mitbearbeiter",
  viewer: "Beitragender",
};

export function tripRoleLoadFailed(tripId) {
  return Boolean(tripId) && roleLoadFailed.has(tripId);
}

function isLocalOnlyTrip(tripId) {
  const trip = (readCache()?.trips || []).find((item) => item.id === tripId);
  return Boolean(trip && trip.synced === false);
}

function remember(tripId, role, confirmed) {
  roleCache.set(tripId, role);
  if (confirmed) confirmedRoles.set(tripId, role);
  else confirmedRoles.delete(tripId);
  roleLoadFailed.delete(tripId);
}

function failRole(tripId) {
  if (isLocalOnlyTrip(tripId)) {
    remember(tripId, "owner", true);
    return { role: "owner", confirmed: true };
  }
  if (confirmedRoles.has(tripId)) {
    const role = confirmedRoles.get(tripId);
    roleCache.set(tripId, role);
    roleLoadFailed.delete(tripId);
    return { role, confirmed: true };
  }
  roleCache.set(tripId, "owner");
  roleLoadFailed.add(tripId);
  return { role: "owner", confirmed: false };
}

export async function getConfirmedTripRole(tripId) {
  if (!tripId) return { role: "owner", confirmed: true };
  if (roleCache.has(tripId)) {
    return { role: roleCache.get(tripId), confirmed: confirmedRoles.has(tripId) };
  }
  if (roleInflight.has(tripId)) return roleInflight.get(tripId);
  const job = loadConfirmedTripRole(tripId).finally(() => roleInflight.delete(tripId));
  roleInflight.set(tripId, job);
  return job;
}

async function loadConfirmedTripRole(tripId) {
  try {
    const uid = await getUserId();
    if (!uid) return failRole(tripId);
    const { data, error } = await getSupabase()
      .from("trip_members")
      .select("role")
      .eq("trip_id", tripId)
      .eq("user_id", uid)
      .maybeSingle();
    if (error) return failRole(tripId);
    if (!data?.role) {
      if (isLocalOnlyTrip(tripId)) {
        remember(tripId, "owner", true);
        return { role: "owner", confirmed: true };
      }
      roleCache.set(tripId, "owner");
      confirmedRoles.delete(tripId);
      roleLoadFailed.delete(tripId);
      return { role: "owner", confirmed: false };
    }
    remember(tripId, data.role, true);
    return { role: data.role, confirmed: true };
  } catch {
    return failRole(tripId);
  }
}

export async function getMyTripRole(tripId) {
  const info = await getConfirmedTripRole(tripId);
  return info.role;
}

export function canAddOwn(role) {
  return role === "owner" || role === "editor" || role === "viewer";
}

export function canEditAny(role) {
  return role === "owner" || role === "editor";
}

export function canEditItem(role, item, myUserId) {
  if (canEditAny(role)) return true;
  return role === "viewer" && Boolean(myUserId) && item?.author === myUserId;
}

export function canStartRecap(role) {
  return role === "owner" || role === "editor";
}

export function canManageSharing(role, confirmed) {
  return confirmed === true && role === "owner";
}

export function canDeleteTrip(role, confirmed) {
  return confirmed === true && role === "owner";
}

export const ROLE_UNKNOWN_MESSAGE = "Rolle konnte nicht geladen werden. Bitte später erneut versuchen.";

/**
 * true: darf Recap und Tagebuch anstoßen. false: nur ansehen.
 * Ein Rollenfehler ist false und kein Gast: die Seite zeigt dann eine
 * vorhandene finale Fassung, sonst die Meldung zum Rollenfehler.
 */
export async function resolveTripEditing(tripId) {
  const role = await getMyTripRole(tripId);
  if (tripRoleLoadFailed(tripId)) return false;
  return canStartRecap(role);
}

/** Eine Abfrage für die Rollen der sichtbaren Reisen. Fehlt eine Zeile, gilt Besitzer, aber unbestätigt. */
export async function listMyTripRoles(tripIds) {
  const ids = [...new Set((tripIds || []).filter(Boolean))];
  const roles = new Map();
  if (!ids.length) return { failed: false, roles, userId: null };
  let userId = null;
  const store = (id, role, confirmed) => {
    roles.set(id, role);
    remember(id, role, confirmed);
  };
  try {
    userId = await getUserId();
    if (!userId) {
      ids.forEach((id) => store(id, "owner", isLocalOnlyTrip(id)));
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
      store(row.trip_id, row.role || "owner", true);
    }
    for (const id of ids) {
      if (!roles.has(id)) store(id, "owner", isLocalOnlyTrip(id));
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
    confirmedRoles.delete(tripId);
    roleLoadFailed.delete(tripId);
  } else {
    roleCache.clear();
    confirmedRoles.clear();
    roleLoadFailed.clear();
  }
}
