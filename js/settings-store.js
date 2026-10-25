import { getSetting, putSetting } from "./db.js";

const KEY_REMEMBER_LOCATION = "rememberLocationOnOpen";

export async function getRememberLocationOnOpen() {
  const value = await getSetting(KEY_REMEMBER_LOCATION);
  if (value === undefined || value === null) return true;
  return Boolean(value);
}

export async function setRememberLocationOnOpen(enabled) {
  await putSetting(KEY_REMEMBER_LOCATION, enabled);
}
