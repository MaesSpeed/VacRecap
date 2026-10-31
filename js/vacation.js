import { createId, escapeHtml } from "./utils.js";

export const COMPANION_TAGS = [
  { id: "allein", label: "Allein" },
  { id: "partner", label: "Partner:in" },
  { id: "familie", label: "Familie" },
  { id: "freunde", label: "Freunde" },
];

const COMPANION_TAG_IDS = COMPANION_TAGS.map((tag) => tag.id);

/** Erlaubte Tags, ohne Doppelte. «Allein» schließt die anderen aus. */
export function normalizeCompanionTags(tags) {
  const present = new Set((Array.isArray(tags) ? tags : []).filter((tag) => COMPANION_TAG_IDS.includes(tag)));
  if (present.has("allein")) return ["allein"];
  return COMPANION_TAG_IDS.filter((id) => present.has(id));
}

function companionPillsHtml(tags) {
  if (!tags.length) return "";
  const pills = COMPANION_TAGS.filter((tag) => tags.includes(tag.id))
    .map((tag) => `<span class="companion-pill">${escapeHtml(tag.label)}</span>`)
    .join("");
  return `<div class="companion-line" data-testid="companion-tags" data-tags="${tags.join(" ")}">${pills}</div>`;
}

export function companionTagsMarkup(vacation) {
  return companionPillsHtml(normalizeCompanionTags(vacation?.companions?.tags));
}

export function tripCompanionsMarkup(vacation) {
  const tags = normalizeCompanionTags(vacation?.companions?.tags);
  const names = (vacation?.companions?.names || []).filter(Boolean);
  const pills = companionPillsHtml(tags);
  if (!pills && !names.length) return "";
  const nameHtml = names
    .map((name) => `<span class="companion-name">${escapeHtml(name)}</span>`)
    .join("");
  return `<div class="trip-companions" data-testid="trip-companions">${pills}<span class="companion-names" data-testid="companion-names">${nameHtml}</span></div>`;
}

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
    companions: {
      tags: normalizeCompanionTags(raw?.companions?.tags),
      names: Array.isArray(raw?.companions?.names) ? raw.companions.names.filter(Boolean) : [],
    },
    stats: { places: 0, photos: 0, notes: 0, ...raw.stats },
  };
}

export function avatarListForVacation(vacation) {
  return vacation.companions?.names?.filter(Boolean) ?? [];
}
