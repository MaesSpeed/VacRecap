import { getSetting, putSetting } from "./db.js";

const KEY_REMEMBER_LOCATION = "rememberLocationOnOpen";
const KEY_SAME_PLACE_RADIUS = "samePlaceRadiusM";
const KEY_REMEMBER_CAPTURE = "rememberCaptureLocation";
const KEY_LAST_BACKUP = "lastBackupByVacation";
const KEY_MAP_ROUTES = "mapRoutesEnabled";

const RADIUS_OPTIONS = [50, 100, 150, 200, 300];

export function samePlaceRadiusOptions() {
  return RADIUS_OPTIONS;
}

export async function getRememberLocationOnOpen() {
  const value = await getSetting(KEY_REMEMBER_LOCATION);
  if (value === undefined || value === null) return true;
  return Boolean(value);
}

export async function setRememberLocationOnOpen(enabled) {
  await putSetting(KEY_REMEMBER_LOCATION, enabled);
}

export async function getSamePlaceRadiusM() {
  const value = await getSetting(KEY_SAME_PLACE_RADIUS);
  const n = Number(value);
  if (n === 500) return 300;
  if (RADIUS_OPTIONS.includes(n)) return n;
  return 150;
}

export async function setSamePlaceRadiusM(meters) {
  const n = Number(meters);
  const normalized = n === 500 ? 300 : n;
  if (!RADIUS_OPTIONS.includes(normalized)) return;
  await putSetting(KEY_SAME_PLACE_RADIUS, normalized);
}

export async function getRememberCaptureLocation() {
  const value = await getSetting(KEY_REMEMBER_CAPTURE);
  if (value === undefined || value === null) return true;
  return Boolean(value);
}

export async function setRememberCaptureLocation(enabled) {
  await putSetting(KEY_REMEMBER_CAPTURE, enabled);
}

export async function getLastBackupTs(vacationId) {
  const all = await getSetting(KEY_LAST_BACKUP);
  if (!all || typeof all !== "object") return null;
  const ts = all[vacationId];
  return typeof ts === "number" ? ts : null;
}

export async function setLastBackupTs(vacationId, ts) {
  const all = (await getSetting(KEY_LAST_BACKUP)) || {};
  all[vacationId] = ts;
  await putSetting(KEY_LAST_BACKUP, all);
}

export async function getMapRoutesEnabled() {
  const value = await getSetting(KEY_MAP_ROUTES);
  if (value === undefined || value === null) return true;
  return Boolean(value);
}

export async function setMapRoutesEnabled(enabled) {
  await putSetting(KEY_MAP_ROUTES, enabled);
}
