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

export function clearTripRoleCache(tripId) {
  if (tripId) {
    roleCache.delete(tripId);
    roleLoadFailed.delete(tripId);
  } else {
    roleCache.clear();
    roleLoadFailed.clear();
  }
}
