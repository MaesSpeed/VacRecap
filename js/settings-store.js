import { getSetting, putSetting } from "./db.js";

const KEY_REMEMBER_LOCATION = "rememberLocationOnOpen";
const KEY_SAME_PLACE_RADIUS = "samePlaceRadiusM";
const KEY_REMEMBER_CAPTURE = "rememberCaptureLocation";

const RADIUS_OPTIONS = [50, 100, 150, 300, 500];

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
  if (RADIUS_OPTIONS.includes(n)) return n;
  return 150;
}

export async function setSamePlaceRadiusM(meters) {
  const n = Number(meters);
  if (!RADIUS_OPTIONS.includes(n)) return;
  await putSetting(KEY_SAME_PLACE_RADIUS, n);
}

export async function getRememberCaptureLocation() {
  const value = await getSetting(KEY_REMEMBER_CAPTURE);
  if (value === undefined || value === null) return true;
  return Boolean(value);
}

export async function setRememberCaptureLocation(enabled) {
  await putSetting(KEY_REMEMBER_CAPTURE, enabled);
}
