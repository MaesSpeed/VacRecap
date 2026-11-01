import { getSupabase } from "./supabase-client.js";

function rowsOf(data) {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

async function call(name, args) {
  const { data, error } = await getSupabase().rpc(name, args);
  if (error) {
    const err = new Error(error.message || "Die Anfrage ist fehlgeschlagen.");
    err.code = error.code || "";
    throw err;
  }
  return data;
}

/** Info-E-Mail zur Einladung ist Folgepaket 8b. Paket 8 legt nur die Einladung in der App an. */
export async function inviteToTrip(tripId, invites) {
  const data = await call("invite_to_trip", { p_trip_id: tripId, p_invites: invites });
  return rowsOf(data);
}

export async function listMyTripInvites() {
  try {
    const { data, error } = await getSupabase().rpc("list_my_trip_invites");
    if (error) return [];
    return rowsOf(data);
  } catch {
    return [];
  }
}

export async function acceptTripInvite(inviteId) {
  return call("accept_trip_invite_by_id", { p_invite_id: inviteId });
}

export async function declineTripInvite(inviteId) {
  await call("decline_trip_invite", { p_invite_id: inviteId });
}

export async function setTripAccessRole({ tripId, role, userId = null, inviteId = null }) {
  await call("set_trip_access_role", {
    p_trip_id: tripId,
    p_role: role,
    p_user_id: userId,
    p_invite_id: inviteId,
  });
}

export async function revokeTripAccess({ tripId, userId = null, inviteId = null }) {
  await call("revoke_trip_access", {
    p_trip_id: tripId,
    p_user_id: userId,
    p_invite_id: inviteId,
  });
}

export async function leaveTrip(tripId) {
  await call("leave_trip", { p_trip_id: tripId });
}

export async function touchTripPresence(tripId, target = "trip") {
  try {
    const { error } = await getSupabase().rpc("touch_trip_presence", {
      p_trip_id: tripId,
      p_target: target,
    });
    if (error) return false;
    return true;
  } catch {
    return false;
  }
}

export async function clearTripPresence(tripId) {
  try {
    await getSupabase().rpc("clear_trip_presence", { p_trip_id: tripId });
  } catch {
    /* still */
  }
}

export async function listTripPresence(tripId) {
  try {
    const { data, error } = await getSupabase().rpc("list_trip_presence", { p_trip_id: tripId });
    if (error) return [];
    return rowsOf(data);
  } catch {
    return [];
  }
}
