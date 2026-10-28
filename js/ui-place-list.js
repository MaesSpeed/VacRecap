import { getMediaForPlace, getNotesForPlace } from "./db.js";
import { formatMediaDuration } from "./media-process.js";
import { buildPlaceMetaLine } from "./place-stats.js";
import { filterSoftPointsHidden, softPointLabel } from "./place-service.js";
import { sortPlacesChronologicalDesc } from "./places.js";
import { escapeHtml } from "./utils.js";

const PIN_SVG = `<svg width="19" height="19" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 2.8c-5.8 0-10 4.3-10 9.7 0 6.9 10 15.7 10 15.7s10-8.8 10-15.7c0-5.4-4.2-9.7-10-9.7z" fill="#d4523e"/><circle cx="16" cy="12.6" r="3.8" fill="#fff"/></svg>`;

const ICON_EDIT = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;
const ICON_NOTE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;

export async function loadDayPlacesEnriched(vacationId, day) {
  const { getPlacesForDay } = await import("./db.js");
  const places = sortPlacesChronologicalDesc(await getPlacesForDay(vacationId, day));
  const enriched = await Promise.all(
    places.map(async (p) => {
      if (p.soft) return { place: p, photos: 0, videos: 0, notes: [], media: [] };
      const [media, notes] = await Promise.all([
        getMediaForPlace(p.id),
        getNotesForPlace(p.id),
      ]);
      const sortedMedia = media.slice().sort((a, b) => a.ts - b.ts);
      const photos = media.filter((m) => m.type !== "video").length;
      const videos = media.filter((m) => m.type === "video").length;
      return { place: p, photos, videos, notes, media: sortedMedia };
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

export function renderPlaceListHtml(items, { selectedId, notesExpanded, thumbUrls = {} }) {
  if (!items.length) return "";

  return items
    .map(({ place, photos, videos, notes, media }) => {
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
      const hasMedia = media.length > 0;
      const expanded = notesExpanded.has(place.id);
      const previewNotes = expanded ? notes : notes.slice(0, 2);
      const hiddenCount = notes.length - 2;
      const newestMedia = hasMedia ? media[media.length - 1] : null;
      const dimThumb = dim && newestMedia ? thumbUrls[newestMedia.id] : null;

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
                  ? `<div class="oc__actions">
                <button type="button" class="icon-btn icon-btn--sm" data-action="edit-place" aria-label="Ort bearbeiten">${ICON_EDIT}</button>
              </div>`
                  : ""
              }
            </div>
            ${
              selected
                ? `<div class="oc__notes">${renderNotes(previewNotes, hiddenCount, notes.length, expanded, place.id)}</div>`
                : dimThumb
                  ? `<div class="th" aria-hidden="true"><img class="th__img" src="${dimThumb}" alt="" /></div>`
                  : newestMedia
                    ? `<div class="th th--ph" aria-hidden="true" data-media-id="${newestMedia.id}"></div>`
                    : ""
            }
            ${selected && hasMedia ? `<div class="tiles">${renderTiles(media, thumbUrls)}</div>` : ""}
          </div>
        </article>
      </li>`;
    })
    .join("");
}

function renderNotes(notes, hiddenCount, total, expanded, placeId) {
  if (!total) {
    return `<button type="button" class="nr nr--new" data-action="add-note" data-place-id="${placeId}">+ Notiz</button>`;
  }
  const rows = notes
    .map(
      (n) => `
      <div class="nr" data-note-id="${n.id}">
        <p class="nr__text">${escapeHtml(n.text)}</p>
        <button type="button" class="icon-btn icon-btn--sm" data-action="edit-note" aria-label="Notiz bearbeiten">${ICON_NOTE}</button>
      </div>`
    )
    .join("");
  const more =
    !expanded && hiddenCount > 0
      ? `<button type="button" class="nr nr--more" data-action="expand-notes" data-place-id="${placeId}">+ ${hiddenCount} weitere</button>`
      : "";
  const add = `<button type="button" class="nr nr--new" data-action="add-note" data-place-id="${placeId}">+ Notiz</button>`;
  return rows + more + add;
}

function renderTiles(media, thumbUrls) {
  const sorted = media.slice().sort((a, b) => b.ts - a.ts);
  const visible = sorted.slice(0, 4).sort((a, b) => a.ts - b.ts);
  const extra = media.length - visible.length;

  return visible
    .map((m, i) => {
      const isLast = i === visible.length - 1;
      const overlayExtra = extra > 0 && isLast ? `<span class="tile__more">+${extra}</span>` : "";
      const thumb = thumbUrls[m.id];
      const isVideo = m.type === "video";
      const img =
        thumb
          ? `<img class="tile__img" src="${thumb}" alt="" decoding="async" data-media-id="${m.id}" />`
          : "";
      const dur =
        isVideo
          ? `<span class="tile__dur">${escapeHtml(m.durationLabel || formatMediaDuration(m.duration))}</span>`
          : "";
      const play = isVideo ? `<span class="tile__play-wrap"></span>` : "";
      return `<button type="button" class="tile tile--btn" data-media-id="${m.id}" aria-label="Medium anzeigen">${img}${play}${dur}${overlayExtra}</button>`;
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

export function wrapPlaceList(inner) {
  return `<ul class="place-list">${inner}</ul>`;
}
