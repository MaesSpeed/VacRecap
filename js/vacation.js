import { createId } from "./utils.js";

export const COMPANION_TAGS = [
  { id: "allein", label: "Allein" },
  { id: "partner", label: "Partner:in" },
  { id: "familie", label: "Familie" },
  { id: "freunde", label: "Freunde" },
];

export function createEmptyVacation() {
  const now = Date.now();
  return {
    id: createId(),
    createdAt: now,
    updatedAt: now,
    author: "ich",
    title: "",
    startDate: "",
    endDate: "",
    cover: { type: "preset", presetId: "stadt" },
    companions: { tags: [], names: [] },
    stats: { places: 0, photos: 0, notes: 0 },
  };
}

export function normalizeVacation(raw) {
  return {
    ...createEmptyVacation(),
    ...raw,
    cover: { type: "preset", presetId: "stadt", ...raw.cover },
    companions: { tags: [], names: [], ...raw.companions },
    stats: { places: 0, photos: 0, notes: 0, ...raw.stats },
  };
}

export function avatarListForVacation(vacation) {
  const names = vacation.companions?.names?.filter(Boolean) ?? [];
  if (names.length) return names;
  const tags = vacation.companions?.tags ?? [];
  if (tags.includes("allein")) return ["Ich"];
  if (tags.includes("partner")) return ["A", "B"];
  if (tags.includes("familie")) return ["A", "M", "P"];
  if (tags.includes("freunde")) return ["J", "L", "T"];
  return [];
}
