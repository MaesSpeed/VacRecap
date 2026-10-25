import { enumerateDays, parseIsoDate, todayIso } from "./utils.js";

const WEEKDAYS_SHORT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

export function dayChipDateLine(iso) {
  const d = parseIsoDate(iso);
  const wd = WEEKDAYS_SHORT[d.getDay()];
  return `${wd} ${d.getDate()}.`;
}

export function dayRoleLabel(dayIndex, totalDays) {
  if (dayIndex === 1) return "Anreise";
  if (dayIndex === totalDays) return "Abreise";
  return `${dayIndex}. Tag`;
}

export function vacationDays(vacation) {
  return enumerateDays(vacation.startDate, vacation.endDate);
}

export function defaultActiveDay(vacation) {
  const days = vacationDays(vacation);
  const today = todayIso();
  if (days.includes(today)) return today;
  return days[0] ?? today;
}

export function dayIndexInTrip(vacation, dayIso) {
  const days = vacationDays(vacation);
  const idx = days.indexOf(dayIso);
  return idx >= 0 ? idx + 1 : 1;
}

export function adjacentDay(vacation, dayIso, direction) {
  const days = vacationDays(vacation);
  const idx = days.indexOf(dayIso);
  if (idx < 0) return dayIso;
  const next = idx + direction;
  if (next < 0 || next >= days.length) return dayIso;
  return days[next];
}

export function isDayInVacation(vacation, dayIso) {
  return dayIso >= vacation.startDate && dayIso <= vacation.endDate;
}
