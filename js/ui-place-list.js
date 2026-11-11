import { fetchMediaForWaypoints, fetchNotesForWaypoints } from "./db.js";
import { formatTimeFromTs } from "./geo.js";
import { compareMediaOrder } from "./media-order.js";
import { formatMediaDuration } from "./media-process.js";
import { photoBadges, noteMarkup } from "./member-marks.js";
import { mediaOwnedBy } from "./photo-move.js";
import "./photo-row-drag.js";
import { buildPlaceMetaLine } from "./place-stats.js";
import { filterSoftPointsHidden, softPointLabel } from "./place-service.js";
import { sortPlacesChronologicalDesc } from "./places.js";
import { canEditAny, peekConfirmedTripRole } from "./trip-role.js";
import { escapeHtml } from "./utils.js";

const PIN_SVG = `<svg width="19" height="19" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 2.8c-5.8 0-10 4.3-10 9.7 0 6.9 10 15.7 10 15.7s10-8.8 10-15.7c0-5.4-4.2-9.7-10-9.7z" fill="#d4523e"/><circle cx="16" cy="12.6" r="3.8" fill="#fff"/></svg>`;

const ICON_EDIT = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;
const ICON_CAM = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;
const ICON_GALLERY = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M3 16l5-4 3 3 2-2 8 6"/></svg>`;
const PIN_CAM_BADGE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;
const ICON_NOTE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;
const ICON_CAPTION_PENCIL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;
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

const dayItems = new Map();
const dayInflight = new Map();
const dayToken = new Map();
const tripPlaces = new Map();

function dayKey(vacationId, day) {
  return `${vacationId}:${day}`;
}

function placeDay(place) {
  return place?.day || place?.dayDate || "";
}

export function rememberTripPlaces(vacationId, places) {
  if (!vacationId || !places?.length) return;
  const prev = tripPlaces.get(vacationId);
  if (!prev || places.length >= prev.length) tripPlaces.set(vacationId, places);
}

export function peekTripPlaces(vacationId) {
  return tripPlaces.get(vacationId) || null;
}

export function dropDayPlaceMemory(vacationId, day) {
  if (!vacationId || !day) return;
  const key = dayKey(vacationId, day);
  dayToken.set(key, (dayToken.get(key) || 0) + 1);
  dayItems.delete(key);
}

export function peekDayPlace(vacationId, day, placeId) {
  if (!vacationId || !day || !placeId) return null;
  const items = dayItems.get(dayKey(vacationId, day));
  if (!items) return null;
  return items.find((item) => item.place?.id === placeId) || null;
}

export function dropTripPlaceMemory(vacationId) {
  if (!vacationId) return;
  tripPlaces.delete(vacationId);
  const prefix = `${vacationId}:`;
  for (const key of dayItems.keys()) {
    if (!key.startsWith(prefix)) continue;
    dayToken.set(key, (dayToken.get(key) || 0) + 1);
    dayItems.delete(key);
  }
}

async function assembleDay(vacationId, day, dayPlaces, mediaByPlace, notesByPlace, batchMediaError) {
  const places = sortPlacesChronologicalDesc(dayPlaces);
  const enriched = places.map((p) => {
    if (p.soft) return { place: p, photos: 0, videos: 0, notes: [], media: [], mediaLoadError: false };
    const media = mediaByPlace.get(p.id) || [];
    const notes = notesByPlace.get(p.id) || [];
    const sortedMedia = media.slice().sort((a, b) => compareMediaOrder(a, b));
    const photos = media.filter(isUploadedPhoto).length;
    const videos = media.filter((m) => m.type === "video").length;
    return {
      place: p,
      photos,
      videos,
      notes: sortNotesNewestFirst(notes),
      media: sortedMedia,
      mediaLoadError: batchMediaError && !media.length,
    };
  });
  return filterSoftPointsHidden(enriched, vacationId, day);
}

function storeDayItems(vacationId, day, items, token) {
  const key = dayKey(vacationId, day);
  if ((dayToken.get(key) || 0) !== token) return items;
  dayItems.set(key, items);
  return items;
}

async function loadDayPlacesEnrichedUncached(vacationId, day, knownPlaces) {
  const { getPlacesForDay } = await import("./db.js");
  const source = knownPlaces
    ? knownPlaces.filter((p) => placeDay(p) === day)
    : await getPlacesForDay(vacationId, day);
  const waypointIds = source.filter((p) => !p.soft).map((p) => p.id);
  const [mediaPack, notesByPlace] = await Promise.all([
    fetchMediaForWaypoints(waypointIds),
    fetchNotesForWaypoints(vacationId, waypointIds),
  ]);
  return assembleDay(
    vacationId,
    day,
    source,
    mediaPack.byPlace || new Map(),
    notesByPlace,
    Boolean(mediaPack.error)
  );
}

export async function loadDayPlacesEnriched(vacationId, day, knownPlaces) {
  if (!vacationId || !day) return [];
  if (knownPlaces) rememberTripPlaces(vacationId, knownPlaces);
  const key = dayKey(vacationId, day);
  if (dayItems.has(key)) return dayItems.get(key);
  const pending = dayInflight.get(key);
  if (pending) return pending;
  const token = dayToken.get(key) || 0;
  const job = loadDayPlacesEnrichedUncached(vacationId, day, knownPlaces)
    .then((items) => storeDayItems(vacationId, day, items, token))
    .finally(() => {
      if (dayInflight.get(key) === job) dayInflight.delete(key);
    });
  dayInflight.set(key, job);
  return job;
}

async function loadMissingDays(vacationId, source, daysNeeded) {
  const days = [...daysNeeded];
  const ids = [];
  const tokens = new Map();
  for (const place of source) {
    if (place.soft) continue;
    const day = placeDay(place);
    if (!daysNeeded.has(day) || !place.id) continue;
    ids.push(place.id);
  }
  const unique = [...new Set(ids)];
  let publish = () => {};
  const gate = new Promise((resolve) => {
    publish = resolve;
  });
  const flights = new Map();
  for (const day of days) {
    const key = dayKey(vacationId, day);
    tokens.set(key, dayToken.get(key) || 0);
    const flight = gate.then((stored) => stored.get(day) || []);
    flights.set(key, flight);
    dayInflight.set(key, flight);
  }
  try {
    const [mediaPack, notesByPlace] = unique.length
      ? await Promise.all([fetchMediaForWaypoints(unique), fetchNotesForWaypoints(vacationId, unique)])
      : [{ byPlace: new Map(), error: null }, new Map()];
    const mediaByPlace = mediaPack.byPlace || new Map();
    const batchMediaError = Boolean(mediaPack.error);
    const stored = new Map();
    for (const day of days) {
      const dayPlaces = source.filter((place) => placeDay(place) === day);
      const items = await assembleDay(vacationId, day, dayPlaces, mediaByPlace, notesByPlace, batchMediaError);
      const key = dayKey(vacationId, day);
      storeDayItems(vacationId, day, items, tokens.get(key));
      stored.set(day, dayItems.get(key) || items);
    }
    publish(stored);
    return stored;
  } catch (err) {
    publish(new Map());
    throw err;
  } finally {
    for (const [key, flight] of flights) {
      if (dayInflight.get(key) === flight) dayInflight.delete(key);
    }
  }
}

export async function placeMediaNoteCounts(vacationId, places) {
  const source = places?.length ? places : peekTripPlaces(vacationId) || [];
  const waiting = [];
  const missingDays = new Set();
  for (const place of source) {
    if (place.soft) continue;
    const day = placeDay(place);
    if (!day) continue;
    const key = dayKey(vacationId, day);
    if (dayItems.has(key)) continue;
    if (dayInflight.has(key)) {
      waiting.push(dayInflight.get(key));
      continue;
    }
    missingDays.add(day);
  }
  if (missingDays.size) waiting.push(loadMissingDays(vacationId, source, missingDays));
  if (waiting.length) await Promise.all(waiting);
  const counts = new Map();
  for (const place of source) {
    if (!place?.id) continue;
    if (place.soft) {
      counts.set(place.id, { photos: 0, videos: 0, notes: 0 });
      continue;
    }
    const items = dayItems.get(dayKey(vacationId, placeDay(place))) || [];
    const item = items.find((entry) => entry.place?.id === place.id);
    const media = item?.media || [];
    counts.set(place.id, {
      photos: media.filter((entry) => entry.type !== "video").length,
      videos: media.filter((entry) => entry.type === "video").length,
      notes: item?.notes?.length || 0,
    });
  }
  return counts;
}

export async function ensurePhotoThumbs() {}

export async function forceRebuildPhotoThumb() {
  return false;
}

function sortNotesByRecentUpdate(notes) {
  return notes.slice().sort((a, b) => (b.ts ?? b.createdAt ?? 0) - (a.ts ?? a.createdAt ?? 0));
}

export function renderFreeNotesHtml(notes, { expanded = false, share = null } = {}) {
  if (!notes?.length) return "";
  const sorted = sortNotesByRecentUpdate(notes);
  const preview = expanded ? sorted : sorted.slice(0, 2);
  const hiddenCount = Math.max(0, sorted.length - 2);
  return `
    <section class="free-notes" data-testid="free-notes">
      <h3 class="free-notes__title">Kein Ort / freie Notiz</h3>
      <div class="np">
        ${preview
          .map((n) =>
            noteMarkup(
              { ...n, _icon: ICON_NOTE, _text: escapeHtml(n.text || "") },
              "edit-free-note",
              share
            )
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

export function withFreeNotesHtml(placeHtml, freeNotes, { expanded = false, replaceEmpty = false, share = null } = {}) {
  const freeHtml = renderFreeNotesHtml(freeNotes, { expanded, share });
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

function hasForeignContent(media, notes, userId) {
  if (!userId) return false;
  const photos = (media || []).some((item) => item?.author && item.author !== userId);
  const foreignNotes = (notes || []).some((item) => item?.author && item.author !== userId);
  return photos || foreignNotes;
}

function renderSelectBar(photoSelect, { canReset = false } = {}) {
  const count = photoSelect.selectedIds?.size || 0;
  const reset = canReset
    ? `<button type="button" class="photo-select-bar__reset" data-action="photo-sort-reset" data-testid="photo-sort-reset">Nach Aufnahmezeit sortieren</button>`
    : "";
  return `
    <div class="photo-select-bar" data-testid="photo-select-bar">
      <button type="button" data-action="photo-select-exit" data-testid="photo-select-exit">Beenden</button>
      <span class="photo-select-bar__count" data-testid="photo-select-count">${count} ausgewählt</span>
      <button type="button" data-action="photo-move" data-testid="photo-move"${count ? "" : " disabled"}>Verschieben nach …</button>
      ${reset}
    </div>`;
}

export function renderPlaceListHtml(items, { selectedId, notesExpanded, thumbUrls = {}, canEditMedia = true, freshPlaceIds = null, photoSelect = null, share = null, canEditPlace = null }) {
  if (!items.length) return { listHtml: "", mediaErrorHtml: "", selectBarHtml: "" };

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
        const dimOwn = dimMedia ? mediaOwnedBy(dimMedia, photoSelect?.userId) : false;
        const dimCaptionMark =
          dimMedia?.caption && dimMedia.type !== "video"
            ? `<span class="tile__dur" data-testid="photo-caption-mark" aria-hidden="true">${ICON_NOTE}</span>`
            : "";
        const dimPicked = Boolean(photoSelect?.active && dimMedia && photoSelect.selectedIds?.has(dimMedia.id));
        const foreignHint =
          photoSelect?.active &&
          selected &&
          media.some(
            (item) =>
              item.type !== "video" &&
              (item.uploadStatus || "uploaded") === "uploaded" &&
              !mediaOwnedBy(item, photoSelect.userId)
          )
            ? `<p class="photo-select-hint" data-testid="photo-foreign-hint">Fremde Fotos sind nicht wählbar.</p>`
            : "";

        const canReorder = canEditAny(peekConfirmedTripRole(place.vacationId));
        const photoRows =
          selected && hasMedia
            ? `<div class="photo-rows" data-can-reorder="${canReorder ? "1" : "0"}">${renderPhotoRows(media, thumbUrls, canEditMedia, photoSelect, share, canReorder)}</div>`
            : "";

        const notesBlock = sortedNotes.length
            ? `<div class="np">
              ${previewNotes
                .map(
                  (n) => `
                ${noteMarkup({ ...n, _icon: ICON_NOTE, _text: escapeHtml(n.text || "") }, "edit-note", share)}`
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
            </div>`
            : "";

        const foreignContent = hasForeignContent(media, notes, photoSelect?.userId) ? "1" : "0";
        return `
      <li>
        <article class="oc${selected ? " oc--selected" : ""}${dim ? " oc--dim" : ""}" data-place-id="${place.id}" data-foreign-content="${foreignContent}">
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
                selected && !photoSelect?.active
                  ? qaButtons(place, canEditMedia, canEditPlace)
                  : ""
              }
            </div>
            ${photoRows}
            ${foreignHint}
            ${notesBlock}
          </div>
          ${
            dim && dimMedia
              ? dimThumb
                ? `<div class="th${dimPicked ? " th--selected" : ""}${photoSelect?.active && !dimOwn ? " th--locked" : ""}" data-media-id="${dimMedia.id}" data-own="${dimOwn ? "1" : "0"}"><img class="th__img" src="${dimThumb}" alt="" decoding="async" data-media-id="${dimMedia.id}" />${dimCaptionMark}</div>`
                : `<div class="th th--ph${photoSelect?.active && !dimOwn ? " th--locked" : ""}" aria-hidden="true" data-media-id="${dimMedia.id}" data-own="${dimOwn ? "1" : "0"}">${dimCaptionMark}</div>`
              : dim && hasMedia && !dimMedia
                ? ""
                : ""
          }
        </article>
      </li>`;
      })
      .join("");

  return {
    listHtml,
    mediaErrorHtml,
    selectBarHtml: photoSelect?.active
      ? renderSelectBar(photoSelect, {
          canReset:
            canEditAny(peekConfirmedTripRole(items.find((item) => item.place?.id === selectedId)?.place?.vacationId)) &&
            (items.find((item) => item.place?.id === selectedId)?.media || []).some((item) => item?.sortOrder != null),
        })
      : "",
  };
}

function captionText(item) {
  return typeof item?.caption === "string" ? item.caption.trim() : "";
}

function captionAriaLabel(index, item) {
  const when = formatTimeFromTs(item.ts);
  return `Notiz zum Foto ${index + 1}${when ? `, ${when}` : ""}`;
}

function renderPhotoRows(media, thumbUrls, canEditMedia, photoSelect, share, canReorder) {
  const userId = photoSelect?.userId;
  const selecting = Boolean(photoSelect?.active);
  const sorted = (media || []).slice().sort((a, b) => compareMediaOrder(a, b));
  let photoIndex = 0;
  return sorted
    .map((item) => {
      const isVideo = item.type === "video";
      const index = isVideo ? 0 : photoIndex;
      if (!isVideo) photoIndex += 1;
      return renderPhotoRow(item, index, thumbUrls, canEditMedia, userId, selecting, photoSelect, share, canReorder);
    })
    .join("");
}

function renderPhotoRow(item, index, thumbUrls, canEditMedia, userId, selecting, photoSelect, share, canReorder) {
  const status = item.uploadStatus || "uploaded";
  const uploaded = status === "uploaded";
  const failed = status === "failed";
  const isVideo = item.type === "video";
  const isPhoto = !isVideo;
  const own = mediaOwnedBy(item, userId);
  const picked = selecting && own && photoSelect.selectedIds?.has(item.id);
  const note = isPhoto ? captionText(item) : "";
  const canEdit = isPhoto && uploaded && canEditMedia && own;
  const badges = photoBadges(item, share, { seal: true });
  const thumb = uploaded ? thumbUrls[item.id] : "";
  const thumbTestId = canEdit ? "photo-caption-edit-thumb" : "photo-caption-thumb";
  const img = thumb
    ? `<img class="tile__img" src="${thumb}" alt="" decoding="async" draggable="false" data-media-id="${item.id}" data-testid="${thumbTestId}" />`
    : "";
  const captionMark =
    isPhoto && note
      ? `<span class="tile__dur photo-row__mark" data-testid="photo-caption-mark" aria-hidden="true">${ICON_NOTE}</span>`
      : "";
  const removeBtn =
    failed && canEditMedia
      ? `<span class="tile__remove" data-action="remove-failed-media" data-media-id="${item.id}" aria-label="Entfernen">×</span>`
      : "";
  const play = isVideo ? `<span class="tile__play-wrap">${PLAY_SVG}</span>` : "";
  const dur = isVideo
    ? `<span class="tile__dur">${escapeHtml(item.durationLabel || formatMediaDuration(item.duration))}</span>`
    : "";
  const openable = uploaded && !failed;
  const check =
    isPhoto && uploaded
      ? `<button type="button" class="photo-row__check" data-action="photo-row-check" data-testid="photo-row-check" data-media-id="${item.id}" data-own="${own ? "1" : "0"}" aria-pressed="${picked ? "true" : "false"}" aria-label="${escapeHtml(own ? (picked ? "Auswahl aufheben" : "Foto auswählen") : "Fremdes Foto, nicht verschiebbar")}"></button>`
      : `<span class="photo-row__check photo-row__check--spacer" aria-hidden="true"></span>`;
  const thumbLabel = failed ? "Fehlgeschlagenes Foto entfernen" : "Medium anzeigen";
  const thumbBtn = `<button type="button" class="tile tile--btn photo-row__thumb${failed ? " tile--failed" : ""}${openable ? "" : " tile--no-open"}${badges.foreign ? " fg-foreign" : ""}" data-testid="place-photo" data-media-id="${item.id}" data-own="${own ? "1" : "0"}" data-upload-status="${status}"${openable ? "" : ' aria-disabled="true"'} aria-label="${escapeHtml(thumbLabel)}">${img}${uploadStateBadge(item)}${badges.mine}${badges.lock}${badges.circle}${captionMark}${removeBtn}${play}${dur}</button>`;
  const label = isPhoto ? captionAriaLabel(index, item) : "Video";
  let text;
  const sortable = picked && canReorder;
  const grip = sortable
    ? `<span class="photo-row__grip" data-testid="photo-row-grip" aria-hidden="true"></span>`
    : "";
  if (canEdit) {
    const filled = Boolean(note);
    const pencil = `<span class="photo-cap-row__pencil${filled ? "" : " photo-cap-row__pencil--muted"}" aria-hidden="true">${ICON_CAPTION_PENCIL}</span>`;
    const body = filled
      ? `<span class="photo-cap-row__text">${escapeHtml(note)}</span>${grip}${pencil}`
      : `${grip}${pencil}<span class="photo-cap-row__placeholder">Notiz hinzufügen</span>`;
    text = `<button type="button" class="photo-row__text" data-action="edit-photo-caption" data-testid="photo-caption-edit" data-media-id="${item.id}" aria-label="${escapeHtml(label)}">${body}</button>`;
  } else if (isPhoto && uploaded) {
    const body = note
      ? `<span class="photo-cap-row__text">${escapeHtml(note)}</span>`
      : `<span class="photo-cap-row__placeholder">Keine Notiz</span>`;
    text = `<button type="button" class="photo-row__text" data-action="open-photo-caption" data-testid="photo-row-text" data-media-id="${item.id}" aria-label="${escapeHtml(label)}">${body}</button>`;
  } else {
    text = `<span class="photo-row__text photo-row__text--plain">${isVideo ? escapeHtml(item.durationLabel || formatMediaDuration(item.duration)) : ""}</span>`;
  }
  return `<div class="photo-row${picked ? " photo-row--on" : ""}" data-media-id="${item.id}" data-own="${own ? "1" : "0"}" data-sortable="${sortable ? "1" : "0"}" data-testid="photo-caption-row">${check}${thumbBtn}${text}</div>`;
}

function qaButtons(place, canEditMedia, canEditPlace) {
  const allowEdit = typeof canEditPlace === "function" ? canEditPlace(place) : true;
  const edit = allowEdit
    ? `<button type="button" class="qa__btn" data-action="edit-place" aria-label="Bearbeiten">${ICON_EDIT}</button>`
    : "";
  const add = canEditMedia
    ? `<button type="button" class="qa__btn" data-action="gallery-place" data-testid="place-gallery" aria-label="Fotos">${ICON_GALLERY}</button><button type="button" class="qa__btn" data-action="camera-place" aria-label="Kamera">${ICON_CAM}</button>`
    : "";
  if (!edit && !add) return "";
  return `<div class="qa">${edit}${add}</div>`;
}

export async function resolveThumbUrlMap(mediaList, onlyIds = null) {
  const { getSupabase } = await import("./supabase-client.js");
  const { getSignedThumbUrls } = await import("./media-signed-url-cache.js");
  const supabase = getSupabase();
  const rows = [];
  for (const m of mediaList) {
    if (onlyIds && !onlyIds.has(m.id)) continue;
    if ((m.uploadStatus || "uploaded") !== "uploaded") continue;
    const path = m.thumbPath || m.storagePath;
    if (!path) continue;
    rows.push({ id: m.id, path });
  }
  const urls = await getSignedThumbUrls(
    supabase,
    rows.map((row) => row.path)
  );
  const map = {};
  for (const row of rows) {
    const url = urls[row.path];
    if (url) map[row.id] = url;
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
      media.forEach((m) => {
        if (m.type !== "video" && (m.uploadStatus || "uploaded") === "uploaded") ids.add(m.id);
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

export function wrapPlaceList(innerHtml, mediaErrorHtml = "", prefixHtml = "") {
  return `
    ${mediaErrorHtml}
    <div class="place-list-wrap">
      ${prefixHtml}
      <ul class="place-list" data-testid="place-list">${innerHtml}</ul>
    </div>`;
}

export function filterViewableMedia(media) {
  return media.filter((m) => (m.uploadStatus || "uploaded") === "uploaded");
}
