import { getMediaForPlace, getNotesForPlace } from "./db.js";
import { formatMediaDuration } from "./media-process.js";
import { buildPlaceMetaLine } from "./place-stats.js";
import { filterSoftPointsHidden, softPointLabel } from "./place-service.js";
import { sortPlacesChronologicalDesc } from "./places.js";
import { escapeHtml } from "./utils.js";

const PIN_SVG = `<svg width="19" height="19" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 2.8c-5.8 0-10 4.3-10 9.7 0 6.9 10 15.7 10 15.7s10-8.8 10-15.7c0-5.4-4.2-9.7-10-9.7z" fill="#d4523e"/><circle cx="16" cy="12.6" r="3.8" fill="#fff"/></svg>`;

const ICON_EDIT = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;
const ICON_CAM = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;
const PIN_CAM_BADGE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;
const ICON_NOTE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;
const PLAY_SVG = `<svg class="tile__play" width="14" height="14" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;

export async function loadDayPlacesEnriched(vacationId, day) {
  const delayMs = typeof globalThis !== "undefined" ? globalThis.__vacrecapSlowPlaces : 0;
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
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
            ${hasMedia ? `<span class="cb" aria-hidden="true">${PIN_CAM_BADGE}</span>` : ""}
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
            ${selected && hasMedia ? `<div class="tiles">${renderTiles(media, thumbUrls)}</div>` : ""}
            ${
              notes.length
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
                expanded && notes.length > 2
                  ? `<button type="button" class="notes-more" data-action="collapse-notes">Weniger ⌃</button>`
                  : ""
              }
            </div>`
                : ""
            }
          </div>
          ${
            dim && hasMedia
              ? dimThumb
                ? `<img class="th th__img" src="${dimThumb}" alt="" decoding="async" data-media-id="${newestMedia.id}" />`
                : `<div class="th th--ph" aria-hidden="true"></div>`
              : ""
          }
        </article>
      </li>`;
    })
    .join("");
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
      const img = thumb
        ? `<img class="tile__img" src="${thumb}" alt="" decoding="async" data-media-id="${m.id}" />`
        : "";
      const dur =
        isVideo
          ? `<span class="tile__dur">${escapeHtml(m.durationLabel || formatMediaDuration(m.duration))}</span>`
          : "";
      const play = isVideo ? `<span class="tile__play-wrap">${PLAY_SVG}</span>` : "";
      return `<button type="button" class="tile tile--btn" data-media-id="${m.id}" aria-label="Medium anzeigen">${img}${play}${dur}${overlayExtra}</button>`;
    })
    .join("");
}

export function buildThumbUrlMap(mediaList) {
  const map = {};
  for (const m of mediaList) {
    if (m.thumbBlob) {
      map[m.id] = URL.createObjectURL(m.thumbBlob);
    }
  }
  return map;
}

export function revokeThumbUrls(map) {
  Object.values(map).forEach((u) => URL.revokeObjectURL(u));
}

export function wrapPlaceList(innerHtml) {
  return `
    <div class="place-list-wrap">
      <ul class="place-list" data-testid="place-list">${innerHtml}</ul>
      <div class="place-list-fade" aria-hidden="true"></div>
    </div>`;
}
