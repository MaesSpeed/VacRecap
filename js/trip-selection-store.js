import { getSetting, putSetting } from "./db.js";

const KEY = "tripSelectionByVacation";

export async function loadTripSelection(vacationId) {
  const all = await getSetting(KEY);
  if (!all || typeof all !== "object") return null;
  return all[vacationId] ?? null;
}

export async function saveTripSelection(vacationId, { selectedByDay, activeDay }) {
  const all = (await getSetting(KEY)) || {};
  all[vacationId] = { selectedByDay, activeDay };
  await putSetting(KEY, all);
}
