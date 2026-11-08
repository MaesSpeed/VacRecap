import { mapAuthError } from "./cloud-errors.js";
import { resetDataScope, syncDataScopeUser } from "./data-scope.js";
import { clearReadCache, setCacheUserId } from "./local-cache.js";
import { resetInflightRequests } from "./request-dedupe.js";
import { getSupabase } from "./supabase-client.js";

let cachedUserId;
let authListenerInstalled = false;

function applySessionUser(session) {
  const nextId = session?.user?.id ?? null;
  if (nextId !== cachedUserId) {
    resetInflightRequests();
    syncDataScopeUser(nextId);
  }
  cachedUserId = nextId;
  if (cachedUserId) setCacheUserId(cachedUserId);
  else if (session === null) setCacheUserId(null);
}

function ensureAuthListener() {
  if (authListenerInstalled) return;
  authListenerInstalled = true;
  getSupabase().auth.onAuthStateChange((_event, session) => {
    applySessionUser(session);
  });
}

export async function getSession() {
  const { data } = await getSupabase().auth.getSession();
  return data.session ?? null;
}

/** Prime the session-backed user id cache (no auth.getUser network round-trip). */
export function syncAuthFromSession(session) {
  ensureAuthListener();
  applySessionUser(session);
}

export function onAuthStateChange(cb) {
  ensureAuthListener();
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
  applySessionUser(data.session);
  return data.session;
}

export async function signOut() {
  resetInflightRequests();
  resetDataScope();
  clearReadCache();
  setCacheUserId(null);
  cachedUserId = undefined;
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

export function getCachedUserId() {
  return cachedUserId !== undefined ? cachedUserId : null;
}

export async function getUserId() {
  ensureAuthListener();
  if (cachedUserId !== undefined) return cachedUserId;
  const session = await getSession();
  applySessionUser(session);
  return cachedUserId;
}
