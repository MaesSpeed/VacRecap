import { getMediaForPlace, getNotesForPlace } from "./db.js";
import { buildPlaceMetaLine } from "./place-stats.js";
import { filterSoftPointsHidden, softPointLabel } from "./place-service.js";
import { sortPlacesChronologicalDesc } from "./places.js";
import { escapeHtml } from "./utils.js";

const PIN_SVG = `<svg width="19" height="19" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 2.8c-5.8 0-10 4.3-10 9.7 0 6.9 10 15.7 10 15.7s10-8.8 10-15.7c0-5.4-4.2-9.7-10-9.7z" fill="#d4523e"/><circle cx="16" cy="12.6" r="3.8" fill="#fff"/></svg>`;

const ICON_EDIT = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;
const ICON_CAM = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;
const ICON_NOTE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;

function sortNotesNewestFirst(notes) {
  return notes.slice().sort((a, b) => {
    const ca = a.createdAt ?? a.ts ?? 0;
    const cb = b.createdAt ?? b.ts ?? 0;
    return cb - ca;
  });
}

export async function loadDayPlacesEnriched(vacationId, day) {
  const { getPlacesForDay } = await import("./db.js");
  const places = sortPlacesChronologicalDesc(await getPlacesForDay(vacationId, day));
  const enriched = await Promise.all(
    places.map(async (p) => {
      if (p.soft) return { place: p, photos: 0, videos: 0, notes: [], media: [] };
      const [media, notes] = await Promise.all([getMediaForPlace(p.id), getNotesForPlace(p.id)]);
      return {
        place: p,
        photos: 0,
        videos: 0,
        notes: sortNotesNewestFirst(notes),
        media: [],
      };
    })
  );
  return filterSoftPointsHidden(enriched, vacationId, day);
}

export async function ensurePhotoThumbs() {
  /* Medien in Paket 6a deaktiviert */
}

export async function forceRebuildPhotoThumb() {
  return false;
}

function renderAddNoteLink() {
  return `<button type="button" class="notes-more" data-action="add-note">+ Notiz</button>`;
}

export function renderPlaceListHtml(items, { selectedId, notesExpanded, thumbUrls = {} }) {
  void thumbUrls;
  if (!items.length) return "";

  return items
    .map(({ place, photos, videos, notes }) => {
      if (place.soft) {
        const time = softPointLabel(place).split(" · ")[0];
        const street = place.name || "Unbekannt";
        return `
        <li class="soft" data-place-id="${place.id}" data-soft="1">
          <span class="soft__dot" aria-hidden="true"></span>
          <span class="soft__text"><strong>${escapeHtml(time)}</strong> · Weicher Punkt · ${escapeHtml(street)} · beim Öffnen</span>
        </li>`;
      }

      const selected = place.id === selectedId;
      const dim = selectedId && !selected;
      const meta = buildPlaceMetaLine(place, {
        photos,
        videos,
        notes: notes.length,
      });
      const expanded = notesExpanded.has(place.id);
      const sortedNotes = sortNotesNewestFirst(notes);
      const previewNotes = expanded ? sortedNotes : sortedNotes.slice(0, 2);
      const hiddenCount = Math.max(0, sortedNotes.length - 2);

      const notesBlock =
        sortedNotes.length || selected
          ? `<div class="np">
              ${previewNotes
                .map(
                  (n) => `
                <div class="nr" data-note-id="${n.id}">
                  <span class="nr__icon">${ICON_NOTE}</span>
                  <button type="button" class="nr__text nr__text--btn" data-action="edit-note">${escapeHtml(n.text || "")}</button>
                </div>`
                )
                .join("")}
              ${
                !expanded && hiddenCount > 0
                  ? `<button type="button" class="notes-more" data-action="expand-notes">+${hiddenCount} weitere ${hiddenCount === 1 ? "Notiz" : "Notizen"} ⌄</button>`
                  : ""
              }
              ${
                expanded && sortedNotes.length > 2
                  ? `<button type="button" class="notes-more" data-action="collapse-notes">Weniger ⌃</button>`
                  : ""
              }
              ${selected ? renderAddNoteLink() : ""}
            </div>`
          : "";

      return `
      <li>
        <article class="oc${selected ? " oc--selected" : ""}${dim ? " oc--dim" : ""}" data-place-id="${place.id}">
          <div class="pinb${selected ? " pinb--selected" : ""}">
            ${PIN_SVG}
          </div>
          <div class="oc__body">
            <div class="oc__head">
              <div class="oc__head-text">
                <h4 class="oc__title">${escapeHtml(place.name)}</h4>
                <div class="oc__meta">${escapeHtml(meta)}</div>
              </div>
              ${
                selected
                  ? `<div class="qa">
                <button type="button" class="qa__btn" data-action="edit-place" aria-label="Bearbeiten">${ICON_EDIT}</button>
                <button type="button" class="qa__btn" data-action="camera-place" aria-label="Kamera">${ICON_CAM}</button>
              </div>`
                  : ""
              }
            </div>
            ${notesBlock}
          </div>
        </article>
      </li>`;
    })
    .join("");
}

export function buildThumbUrlMap() {
  return {};
}

export function visibleThumbMediaIds() {
  return new Set();
}

export function revokeThumbUrls() {}

export function wrapPlaceList(innerHtml) {
  return `
    <div class="place-list-wrap">
      <ul class="place-list" data-testid="place-list">${innerHtml}</ul>
      <div class="place-list-fade" aria-hidden="true"></div>
    </div>`;
}
