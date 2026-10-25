import { createId } from "./utils.js";

/** Datenmodell für Orte/Karten (Paket 2a+). */
export function createPlaceRecord({ vacationId, dayDate, title = "" }) {
  const now = Date.now();
  return {
    id: createId(),
    createdAt: now,
    updatedAt: now,
    author: "ich",
    vacationId,
    dayDate,
    title,
    kind: "place",
    locationText: "",
    source: "manual",
    mediaIds: [],
    noteIds: [],
  };
}
