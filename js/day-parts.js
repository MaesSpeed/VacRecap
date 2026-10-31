/** Startzeiten der Tageszeit-Chips. Der Chip setzt den Wert, das Uhrzeitfeld verfeinert ihn. */
export const DAY_PARTS = [
  { id: "morgens", label: "Morgens", time: "08:00" },
  { id: "vormittag", label: "Vormittag", time: "10:00" },
  { id: "mittag", label: "Mittag", time: "12:00" },
  { id: "nachmittag", label: "Nachmittag", time: "15:00" },
  { id: "abend", label: "Abend", time: "18:00" },
];

export function timestampForDayTime(day, hhmm) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!day || !match) return null;
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return date.getTime();
}
