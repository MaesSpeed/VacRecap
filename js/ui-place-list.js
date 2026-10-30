import { fetchMediaForPlace, getNotesForPlace } from "./db.js";
import { formatMediaDuration } from "./media-process.js";
import { buildPlaceMetaLine } from "./place-stats.js";
import { filterSoftPointsHidden, softPointLabel } from "./place-service.js";
import { sortPlacesChronologicalDesc } from "./places.js";
import { escapeHtml } from "./utils.js";

const PIN_SVG = `<svg width="19" height="19" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 2.8c-5.8 0-10 4.3-10 9.7 0 6.9 10 15.7 10 15.7s10-8.8 10-15.7c0-5.4-4.2-9.7-10-9.7z" fill="#d4523e"/><circle cx="16" cy="12.6" r="3.8" fill="#fff"/></svg>`;

const ICON_EDIT = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;
const ICON_CAM = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;
const ICON_GALLERY = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M3 16l5-4 3 3 2-2 8 6"/></svg>`;
const PIN_CAM_BADGE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;
const ICON_NOTE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;
const PLAY_SVG = `<svg class="tile__play" width="14" height="14" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;

function sortNotesNewestFirst(notes) {
  return notes.slice().sort((a, b) => {
    const ca = a.createdAt ?? a.ts ?? 0;
    const cb = b.createdAt ?? b.ts ?? 0;
    return cb - ca;
  });
}

function isUploadedPhoto(m) {
  return m.type !== "video" && (m.uploadStatus || "uploaded") === "uploaded";
}

function newestUploadedPhoto(media) {
  const uploaded = media.filter(isUploadedPhoto);
  if (!uploaded.length) return null;
  return uploaded.slice().sort((a, b) => a.ts - b.ts)[uploaded.length - 1];
}

export async function loadDayPlacesEnriched(vacationId, day, knownPlaces) {
  const { getPlacesForDay } = await import("./db.js");
  const source = knownPlaces
    ? knownPlaces.filter((p) => (p.day || p.dayDate) === day)
    : await getPlacesForDay(vacationId, day);
  const places = sortPlacesChronologicalDesc(source);
  const enriched = await Promise.all(
    places.map(async (p) => {
      if (p.soft) return { place: p, photos: 0, videos: 0, notes: [], media: [], mediaLoadError: false };
      const [mediaResult, notes] = await Promise.all([
        fetchMediaForPlace(p.id),
        getNotesForPlace(p.id),
      ]);
      const sortedMedia = mediaResult.media.slice().sort((a, b) => a.ts - b.ts);
      const photos = mediaResult.media.filter(isUploadedPhoto).length;
      const videos = mediaResult.media.filter((m) => m.type === "video").length;
      return {
        place: p,
        photos,
        videos,
        notes: sortNotesNewestFirst(notes),
        media: sortedMedia,
        mediaLoadError: Boolean(mediaResult.error),
      };
    })
  );
  return filterSoftPointsHidden(enriched, vacationId, day);
}

export async function ensurePhotoThumbs() {}

export async function forceRebuildPhotoThumb() {
  return false;
}

function renderAddNoteLink() {
  return `<button type="button" class="notes-add" data-action="add-note">+ Notiz</button>`;
}

function sortNotesByRecentUpdate(notes) {
  return notes.slice().sort((a, b) => (b.ts ?? b.createdAt ?? 0) - (a.ts ?? a.createdAt ?? 0));
}

export function renderFreeNotesHtml(notes, { expanded = false } = {}) {
  if (!notes?.length) return "";
  const sorted = sortNotesByRecentUpdate(notes);
  const preview = expanded ? sorted : sorted.slice(0, 2);
  const hiddenCount = Math.max(0, sorted.length - 2);
  return `
    <section class="free-notes" data-testid="free-notes">
      <h3 class="free-notes__title">Kein Ort / freie Notiz</h3>
      <div class="np">
        ${preview
          .map(
            (n) => `
          <div class="nr" data-note-id="${n.id}" data-free-note="1">
            <span class="nr__icon">${ICON_NOTE}</span>
            <button type="button" class="nr__text nr__text--btn" data-action="edit-free-note">${escapeHtml(n.text || "")}</button>
          </div>`
          )
          .join("")}
        ${
          !expanded && hiddenCount > 0
            ? `<button type="button" class="notes-more" data-action="expand-free-notes">+${hiddenCount} weitere ${hiddenCount === 1 ? "Notiz" : "Notizen"} ⌄</button>`
            : ""
        }
        ${
          expanded && sorted.length > 2
            ? `<button type="button" class="notes-more" data-action="collapse-free-notes">Weniger ⌃</button>`
            : ""
        }
        <button type="button" class="notes-add" data-action="add-free-note">+ Notiz</button>
      </div>
    </section>`;
}

export function withFreeNotesHtml(placeHtml, freeNotes, { expanded = false, replaceEmpty = false } = {}) {
  const freeHtml = renderFreeNotesHtml(freeNotes, { expanded });
  if (!freeHtml) return placeHtml;
  if (replaceEmpty) return freeHtml;
  return `${freeHtml}${placeHtml}`;
}

function uploadStateBadge(media) {
  const status = media.uploadStatus || "uploaded";
  if (status === "failed") {
    return `<span class="tile__state tile__state--failed" aria-hidden="true">⚠</span>`;
  }
  if (status === "pending" || status === "uploading") {
    return `<span class="tile__state tile__state--pending" aria-hidden="true">…</span>`;
  }
  return "";
}

export function renderPlaceListHtml(items, { selectedId, notesExpanded, thumbUrls = {}, canEditMedia = true, freshPlaceIds = null }) {
  if (!items.length) return { listHtml: "", mediaErrorHtml: "" };

  const anyMediaError = items.some((i) => i.mediaLoadError);
  const mediaErrorHtml = anyMediaError
    ? `<div class="place-media-error" data-testid="place-media-error">
        <span>Fotos konnten nicht geladen werden.</span>
        <button type="button" class="notes-more" data-action="retry-media-load">Erneut laden</button>
      </div>`
    : "";

  const listHtml = items
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
        const sortedNotes = sortNotesNewestFirst(notes);
        const previewNotes = expanded ? sortedNotes : sortedNotes.slice(0, 2);
        const hiddenCount = Math.max(0, sortedNotes.length - 2);
        const dimMedia = dim ? newestUploadedPhoto(media) : null;
        const dimThumb = dimMedia ? thumbUrls[dimMedia.id] : null;

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
            ${photos > 0 ? `<span class="cb" aria-hidden="true">${PIN_CAM_BADGE}</span>` : ""}
          </div>
          <div class="oc__body">
            <div class="oc__head">
              <div class="oc__head-text">
                <h4 class="oc__title"><span>${escapeHtml(place.name)}</span>${
                  freshPlaceIds?.has(place.id)
                    ? `<span class="oc__new" data-testid="place-new-badge">NEU</span>`
                    : ""
                }</h4>
                <div class="oc__meta">${escapeHtml(meta)}</div>
              </div>
              ${
                selected
                  ? `<div class="qa">
                <button type="button" class="qa__btn" data-action="edit-place" aria-label="Bearbeiten">${ICON_EDIT}</button>
                ${
                  canEditMedia
                    ? `<button type="button" class="qa__btn" data-action="gallery-place" data-testid="place-gallery" aria-label="Fotos">${ICON_GALLERY}</button><button type="button" class="qa__btn" data-action="camera-place" aria-label="Kamera">${ICON_CAM}</button>`
                    : ""
                }
              </div>`
                  : ""
              }
            </div>
            ${selected && hasMedia ? `<div class="tiles">${renderTiles(media, thumbUrls, canEditMedia)}</div>` : ""}
            ${notesBlock}
          </div>
          ${
            dim && dimMedia
              ? dimThumb
                ? `<div class="th"><img class="th__img" src="${dimThumb}" alt="" decoding="async" data-media-id="${dimMedia.id}" /></div>`
                : `<div class="th th--ph" aria-hidden="true" data-media-id="${dimMedia.id}"></div>`
              : dim && hasMedia && !dimMedia
                ? ""
                : ""
          }
        </article>
      </li>`;
      })
      .join("");

  return { listHtml, mediaErrorHtml };
}

function renderTiles(media, thumbUrls, canEditMedia) {
  const sorted = media.slice().sort((a, b) => b.ts - a.ts);
  const visible = sorted.slice(0, 4).sort((a, b) => a.ts - b.ts);
  const extra = media.length - visible.length;

  return visible
    .map((m, i) => {
      const isLast = i === visible.length - 1;
      const overlayExtra = extra > 0 && isLast ? `<span class="tile__more">+${extra}</span>` : "";
      const thumb = thumbUrls[m.id];
      const isVideo = m.type === "video";
      const status = m.uploadStatus || "uploaded";
      const uploaded = status === "uploaded";
      const failed = status === "failed";
      const img =
        thumb && uploaded
          ? `<img class="tile__img" src="${thumb}" alt="" decoding="async" data-media-id="${m.id}" />`
          : "";
      const dur =
        isVideo
          ? `<span class="tile__dur">${escapeHtml(m.durationLabel || formatMediaDuration(m.duration))}</span>`
          : "";
      const play = isVideo ? `<span class="tile__play-wrap">${PLAY_SVG}</span>` : "";
      const badge = uploadStateBadge(m);
      const removeBtn =
        failed && canEditMedia
          ? `<span class="tile__remove" data-action="remove-failed-media" data-media-id="${m.id}" aria-label="Entfernen">×</span>`
          : "";
      const openable = uploaded && !failed;
      return `<button type="button" class="tile tile--btn${failed ? " tile--failed" : ""}${openable ? "" : " tile--no-open"}" data-media-id="${m.id}" data-upload-status="${status}" aria-label="${failed ? "Fehlgeschlagenes Foto entfernen" : "Medium anzeigen"}">${img}${badge}${removeBtn}${play}${dur}${overlayExtra}</button>`;
    })
    .join("");
}

export async function resolveThumbUrlMap(mediaList, onlyIds = null) {
  const { getSupabase } = await import("./supabase-client.js");
  const { getSignedThumbUrl } = await import("./media-signed-url-cache.js");
  const supabase = getSupabase();
  const map = {};
  for (const m of mediaList) {
    if (onlyIds && !onlyIds.has(m.id)) continue;
    if ((m.uploadStatus || "uploaded") !== "uploaded") continue;
    const path = m.thumbPath || m.storagePath;
    if (!path) continue;
    const url = await getSignedThumbUrl(supabase, path);
    if (url) map[m.id] = url;
  }
  return map;
}

export function buildThumbUrlMap(mediaList, onlyIds = null) {
  void mediaList;
  void onlyIds;
  return {};
}

export function visibleThumbMediaIds(items, selectedId) {
  const ids = new Set();
  for (const { place, media } of items) {
    if (!media?.length) continue;
    const sorted = media.slice().sort((a, b) => b.ts - a.ts);
    const visible = sorted.slice(0, 4);
    const dimMedia = place.id !== selectedId ? newestUploadedPhoto(media) : null;
    if (place.id === selectedId) {
      visible.forEach((m) => {
        if ((m.uploadStatus || "uploaded") === "uploaded") ids.add(m.id);
      });
    }
    if (dimMedia) ids.add(dimMedia.id);
  }
  return ids;
}

export function revokeThumbUrls(map) {
  Object.values(map || {}).forEach((u) => {
    if (typeof u === "string" && u.startsWith("blob:")) URL.revokeObjectURL(u);
  });
}

export function wrapPlaceList(innerHtml, mediaErrorHtml = "") {
  return `
    ${mediaErrorHtml}
    <div class="place-list-wrap">
      <ul class="place-list" data-testid="place-list">${innerHtml}</ul>
    </div>`;
}

export function filterViewableMedia(media) {
  return media.filter((m) => (m.uploadStatus || "uploaded") === "uploaded");
}
