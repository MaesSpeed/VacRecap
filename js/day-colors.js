import { dayIndexInTrip, dayRoleLabel, vacationDays } from "./days.js";

const FIXED = {
  1: "#1F6DB5",
  2: "#D9892B",
};

const LAST_ROLE = "#1F9A8A";

const EXTRA = ["#7B5EA7", "#C2477A", "#6B8E23", "#B85C38", "#2E86AB", "#9B59B6"];

export function dayColorFor(vacation, dayIso) {
  const total = vacationDays(vacation).length;
  const idx = dayIndexInTrip(vacation, dayIso);
  if (idx === 1) return FIXED[1];
  if (idx === 2) return FIXED[2];
  if (idx === total) return LAST_ROLE;
  const extraIndex = Math.max(0, idx - 3);
  return EXTRA[extraIndex % EXTRA.length];
}

export function dayLegendLabel(vacation, dayIso) {
  const total = vacationDays(vacation).length;
  const idx = dayIndexInTrip(vacation, dayIso);
  return dayRoleLabel(idx, total);
}
