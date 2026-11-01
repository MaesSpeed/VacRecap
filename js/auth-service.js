import { mapAuthError } from "./cloud-errors.js";
import { clearReadCache, setCacheUserId } from "./local-cache.js";
import { getSupabase } from "./supabase-client.js";

export async function getSession() {
  const { data } = await getSupabase().auth.getSession();
  return data.session ?? null;
}

export function onAuthStateChange(cb) {
  const { data } = getSupabase().auth.onAuthStateChange((_event, session) => {
    cb(session);
  });
  return () => data.subscription.unsubscribe();
}

export async function signInWithEmailOtp(email) {
  const trimmed = email.trim().toLowerCase();
  const { error } = await getSupabase().auth.signInWithOtp({
    email: trimmed,
    options: { shouldCreateUser: true },
  });
  if (error) throw new Error(mapAuthError(error));
  return trimmed;
}

export async function verifyEmailOtp(email, token) {
  const { data, error } = await getSupabase().auth.verifyOtp({
    email: email.trim().toLowerCase(),
    token: token.trim(),
    type: "email",
  });
  if (error) throw new Error(mapAuthError(error));
  return data.session;
}

export async function signOut() {
  clearReadCache();
  setCacheUserId(null);
  const { clearTripSelectionStore } = await import("./trip-selection-store.js");
  await clearTripSelectionStore();
  const { clearSignedUrlCache } = await import("./media-signed-url-cache.js");
  clearSignedUrlCache();
  const { clearTripRoleCache } = await import("./trip-role.js");
  clearTripRoleCache();
  const { clearTripPeople } = await import("./trip-people.js");
  clearTripPeople();
  await getSupabase().auth.signOut();
}

export function getUserId() {
  return getSupabase().auth.getUser().then(({ data }) => data.user?.id ?? null);
}
