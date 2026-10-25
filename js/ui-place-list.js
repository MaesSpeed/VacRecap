import { getMediaForPlace, getNotesForPlace } from "./db.js";
import { buildPlaceMetaLine } from "./place-stats.js";
import { softPointLabel } from "./place-service.js";
import { sortPlacesChronologicalDesc } from "./places.js";
import { escapeHtml } from "./utils.js";

const PIN_SVG = `<svg width="19" height="19" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 2.8c-5.8 0-10 4.3-10 9.7 0 6.9 10 15.7 10 15.7s10-8.8 10-15.7c0-5.4-4.2-9.7-10-9.7z" fill="#d4523e"/><circle cx="16" cy="12.6" r="3.8" fill="#fff"/></svg>`;

const ICON_EDIT = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;
const ICON_CAM = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;
const ICON_NOTE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;

export async function loadDayPlacesEnriched(vacationId, day) {
  const { getPlacesForDay } = await import("./db.js");
  const places = sortPlacesChronologicalDesc(await getPlacesForDay(vacationId, day));
  return Promise.all(
    places.map(async (p) => {
      if (p.soft) return { place: p, photos: 0, videos: 0, notes: [], media: [] };
      const [media, notes] = await Promise.all([
        getMediaForPlace(p.id),
        getNotesForPlace(p.id),
      ]);
      const photos = media.filter((m) => m.type !== "video").length;
      const videos = media.filter((m) => m.type === "video").length;
      return { place: p, photos, videos, notes, media };
    })
  );
}

export function renderPlaceListHtml(items, { selectedId, notesExpanded }) {
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
      const meta = buildPlaceMetaLine(place.ts, {
        photos,
        videos,
        notes: notes.length,
      });
      const hasMedia = media.length > 0;
      const expanded = notesExpanded.has(place.id);
      const previewNotes = expanded ? notes : notes.slice(0, 2);
      const hiddenCount = notes.length - 2;

      return `
      <li>
        <article class="oc${selected ? " oc--selected" : ""}${dim ? " oc--dim" : ""}" data-place-id="${place.id}">
          <div class="pinb${selected ? " pinb--selected" : ""}">
            ${PIN_SVG}
            ${hasMedia ? '<span class="cb" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/></svg></span>' : ""}
          </div>
          <div class="oc__body">
            <div class="oc__head">
              <div>
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
            ${
              notes.length
                ? `<div class="np">
              ${previewNotes
                .map(
                  (n) => `
                <div class="nr">
                  <span class="nr__icon">${ICON_NOTE}</span>
                  <span class="nr__text">${escapeHtml(n.text || "")}</span>
                </div>`
                )
                .join("")}
              ${
                !expanded && hiddenCount > 0
                  ? `<button type="button" class="notes-more" data-action="expand-notes">+${hiddenCount} weitere Notizen ⌄</button>`
                  : ""
              }
            </div>`
                : ""
            }
            ${selected && hasMedia ? `<div class="tiles">${renderTiles(media)}</div>` : ""}
          </div>
          ${dim && hasMedia ? `<div class="th th--ph" aria-hidden="true"></div>` : ""}
        </article>
      </li>`;
    })
    .join("");
}

function renderTiles(media) {
  return media
    .slice(0, 6)
    .map((m) => {
      const dur =
        m.type === "video" && m.duration
          ? `<span class="tile__dur">${escapeHtml(m.duration)}</span>`
          : "";
      return `<div class="tile">${dur}</div>`;
    })
    .join("");
}

export function wrapPlaceList(innerHtml) {
  return `
    <div class="place-list-wrap">
      <ul class="place-list" data-testid="place-list">${innerHtml}</ul>
      <div class="place-list-fade" aria-hidden="true"></div>
    </div>`;
}
