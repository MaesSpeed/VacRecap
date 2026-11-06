import { RecapUnavailableError } from "./cloud-errors.js";
import { dayColorFor, dayLegendLabel } from "./day-colors.js";
import { dayChipDateLine, vacationDays } from "./days.js";
import { dayMapSvg } from "./recap-daymap.js";
import { getVacation } from "./db.js";
import { ICON_BACK_CHEVRON } from "./icons.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { P, fmt } from "./recap-duration.js";
import {
  adoptVideoDraft,
  appendVideoFeedback,
  createVideoDraft,
  discardVideoDraft,
  listDiaryRecaps,
  listVideoRecaps,
  loadRecapMaterial,
} from "./recap-service.js";
import { buildVideoRecap, countMaterialPhotos, dayMapCaption } from "./recap-storyboard.js";
import { navigate } from "./router.js";
import { resolveTripEditing, ROLE_UNKNOWN_MESSAGE, tripRoleLoadFailed } from "./trip-role.js";
import { openConfirmDialog } from "./ui-confirm.js";
import { resolveThumbUrlMap } from "./ui-place-list.js";
import { showToast, showWarnToast } from "./toast.js";
import { escapeHtml, formatDatePart, formatDateShort, parseIsoDate } from "./utils.js";

const MONTHS = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];

const SHOWN_SCENES = 5;

const ICON_SPARK = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.5l1.4 6.1L19.5 10 13.4 11.4 12 17.5l-1.4-6.1L4.5 10l6.1-1.4L12 2.5z" fill="#fff"/><path d="M18 14.5l.6 2.4 2.4.6-2.4.6-.6 2.4-.6-2.4-2.4-.6 2.4-.6.6-2.4z" fill="#d6ebfa"/></svg>`;
const ICON_FILM = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>`;
const ICON_DIARY = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4h9l4 4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M14 4v5h5M8 13h8M8 17h5"/></svg>`;
const THUMB_RETRY_MS = 1500;

function bannerButton({ testId, action, title, sub, icon }) {
  return `<button type="button" class="btn btn-emaille btn-emaille--ghost recap-banner__btn" data-action="${action}" data-testid="${testId}"><span class="recap-banner__btn-icon">${icon}</span><span class="recap-banner__btn-copy"><span class="recap-banner__btn-title">${title}</span><span class="recap-banner__btn-sub">${sub}</span></span></button>`;
}

function formatDeNumber(n) {
  const rounded = Math.round(Number(n) * 10) / 10;
  if (!Number.isFinite(rounded)) return "0";
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(1).replace(".", ",");
}

function formatSeconds(n) {
  return `${formatDeNumber(n)} s`;
}

function countWord(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function ausZeile(counts) {
  const fotos = countWord(counts.photos || 0, "Foto", "Fotos");
  const orte = counts.places === 1 ? "1 Ort" : `${counts.places || 0} Orten`;
  const notizen = countWord(counts.notes || 0, "Notiz", "Notizen");
  return `aus ${fotos}, ${orte}, ${notizen}`;
}

function monthName(iso) {
  if (!iso) return "";
  return MONTHS[parseIsoDate(iso).getMonth()] || "";
}

function pickStatus(rows, status) {
  return (
    rows
      .filter((row) => row.status === status && !row.deletedAt)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null
  );
}

function canEditRecap(tripId) {
  return resolveTripEditing(tripId);
}

function unavailableCopy(tripId, emptyCopy) {
  return tripRoleLoadFailed(tripId) ? ROLE_UNKNOWN_MESSAGE : emptyCopy;
}

export async function loadRecapEntry(tripId) {
  try {
    const canEdit = await canEditRecap(tripId);
    if (canEdit) return { canEdit: true, hasFinal: false, hasDiaryFinal: false };
    const [rows, diaryRows] = await Promise.all([
      listVideoRecaps(tripId),
      listDiaryRecaps(tripId).catch(() => []),
    ]);
    return {
      canEdit: false,
      hasFinal: rows.some((row) => row.status === "final" && !row.deletedAt),
      hasDiaryFinal: diaryRows.some((row) => row.status === "final" && !row.deletedAt),
    };
  } catch {
    return { canEdit: false, hasFinal: false, hasDiaryFinal: false };
  }
}

export function recapEntryCardHtml({ canEdit, hasFinal, hasDiaryFinal = false } = {}) {
  if (!canEdit && !hasFinal && !hasDiaryFinal) return "";
  const primary =
    canEdit || hasFinal
      ? canEdit
        ? bannerButton({ testId: "recap-create", action: "open-recap-video", title: "Recap-Video", sub: "erstellen", icon: ICON_FILM })
        : bannerButton({ testId: "recap-open-final", action: "open-recap-video", title: "Recap-Video", sub: "ansehen", icon: ICON_FILM })
      : "";
  const diary = canEdit
    ? bannerButton({ testId: "recap-diary", action: "open-diary", title: "Reisetagebuch", sub: "erstellen", icon: ICON_DIARY })
    : hasDiaryFinal
      ? bannerButton({ testId: "recap-diary-final", action: "open-diary", title: "Reisetagebuch", sub: "ansehen", icon: ICON_DIARY })
      : "";
  return `
    <section class="recap-banner" data-testid="recap-entry">
      <div class="recap-banner__lead">
        <span class="recap-banner__icon" aria-hidden="true">${ICON_SPARK}</span>
        <div>
          <h2 class="recap-banner__title">Reise vorbei</h2>
          <p class="recap-banner__text">Mach daraus Erinnerungen. Erst kommt ein Entwurf.</p>
        </div>
      </div>
      <div class="recap-banner__actions">${primary}${diary}</div>
    </section>`;
}

function viewModel(content, places) {
  const byId = new Map((places || []).map((place) => [place.id, place]));
  const scenes = (content?.scenes || []).map((scene) => {
    if (scene?.type === "daymap") {
      const ids = Array.isArray(scene.waypoint_ids) ? scene.waypoint_ids : [];
      const points = [];
      for (const id of ids) {
        const place = byId.get(id);
        const lat = Number(place?.lat);
        const lng = Number(place?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        points.push({ lat, lng });
      }
      return { ...scene, waypointIds: ids, points, placeCount: ids.length, mediaIds: [], noteIds: [] };
    }
    if (scene?.type !== "place") return { ...scene, mediaIds: [], noteIds: [] };
    const place = byId.get(scene.waypoint_id);
    return {
      ...scene,
      name: place?.name || place?.title || "Ort",
      mediaIds: Array.isArray(scene.media_ids) ? scene.media_ids : [],
      noteIds: Array.isArray(scene.note_ids) ? scene.note_ids : [],
    };
  });
  return {
    formula: content?.formula || {},
    counts: content?.counts || { photos: 0, places: 0, notes: 0 },
    seconds: Number(content?.seconds) || 0,
    scenes,
  };
}

function sceneMeta(scene) {
  const photos = scene.mediaIds?.length || 0;
  const notes = scene.noteIds?.length || 0;
  const photoLabel = countWord(photos, "Foto", "Fotos");
  if (!notes) return photoLabel;
  return `${photoLabel} · ${countWord(notes, "Notiz", "Notizen")}`;
}

function dayMapDateLabel(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  return formatDatePart(iso, false);
}

function dayMapLegend(vacation, iso) {
  if (!iso || !vacation || !vacationDays(vacation).includes(iso)) return "";
  return dayLegendLabel(vacation, iso) || "";
}

function dayMapCopy(scene, vacation) {
  const count = scene.placeCount ?? scene.waypointIds?.length ?? 0;
  return dayMapCaption(dayMapDateLabel(scene.date), dayMapLegend(vacation, scene.date), count);
}

function sceneColor(scene, vacation) {
  if ((scene.type === "place" || scene.type === "daymap") && scene.date) return dayColorFor(vacation, scene.date);
  if (scene.type === "title") return "#163a78";
  return "#5b6b7a";
}

function dayMapMount(points, color, height, className) {
  return `<div class="${className}" data-daymap data-height="${height}" data-color="${escapeHtml(color)}" data-points="${escapeHtml(JSON.stringify(points || []))}"></div>`;
}

function fillDayMaps(root) {
  root?.querySelectorAll("[data-daymap]").forEach((el) => {
    const width = Math.max(240, Math.round(el.clientWidth || 340));
    const height = Number(el.dataset.height) || 120;
    let points = [];
    try {
      points = JSON.parse(el.dataset.points || "[]");
    } catch {
      points = [];
    }
    const pad = Math.max(22, Math.round(Math.min(width, height) * 0.16));
    const radius = height >= 160 ? 12 : 9;
    const svg = dayMapSvg(points, el.dataset.color, { width, height, pad, r: radius, fitWidth: width });
    const fallback = escapeHtml(el.dataset.color || "#1F6DB5");
    el.innerHTML = svg || `<div class="recap-daymap__fallback" style="background:${fallback}"></div>`;
  });
}

function sceneTitle(scene, vacation) {
  if (scene.type === "title") return "Titel";
  if (scene.type === "outro") return "Schluss";
  if (scene.type === "daymap") return dayMapCopy(scene, vacation).title;
  const day = scene.date ? dayChipDateLine(scene.date) : "";
  return day ? `${day} · ${scene.name}` : scene.name;
}

function sceneSub(scene, vacation) {
  if (scene.type === "title") {
    const month = monthName(vacation.startDate);
    return month ? `${vacation.title} · ${month}` : vacation.title;
  }
  if (scene.type === "outro") return "Ende der Reise";
  if (scene.type === "daymap") return dayMapCopy(scene, vacation).subtitle;
  return sceneMeta(scene);
}

export async function renderRecapVideo(appEl, tripId, { recapId = "" } = {}) {
  const mountGen = appEl?.dataset?.appRenderGen ?? "";
  const token = `${mountGen}:${Date.now()}:${Math.random()}`;
  appEl.dataset.recapToken = token;
  if (typeof appEl._screenCleanup === "function") {
    appEl._screenCleanup();
    delete appEl._screenCleanup;
  }
  const alive = () => appEl.dataset.recapToken === token && appEl.dataset.appRenderGen === mountGen;

  let previewTimer = 0;
  let closePreview = null;
  const stopPreview = () => {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = 0;
  };
  appEl._screenCleanup = () => {
    stopPreview();
    if (closePreview) {
      const fn = closePreview;
      closePreview = null;
      fn();
    }
  };

  const vacation = await getVacation(tripId);
  if (!alive()) return;
  if (!vacation) {
    navigate({ name: "urlaube" });
    return;
  }

  const canEdit = await canEditRecap(tripId);
  paintShell(vacation, { busy: true });
  if (!alive()) return;

  let rows = [];
  try {
    rows = await listVideoRecaps(tripId);
  } catch (err) {
    if (!alive()) return;
    if (err instanceof RecapUnavailableError) {
      showWarnToast(err.message);
      paintUnavailable(vacation, err.message);
      return;
    }
    showWarnToast(err?.message || "Der Entwurf konnte nicht geladen werden.");
    paintUnavailable(vacation, err?.message || "Der Entwurf konnte nicht geladen werden.");
    return;
  }
  if (!alive()) return;
  if (!canEdit) rows = rows.filter((row) => row.status === "final");

  const draft = canEdit ? pickStatus(rows, "draft") : null;
  const finalRow = pickStatus(rows, "final");
  let material = { places: [], photos: [] };
  try {
    material = await loadRecapMaterial(tripId);
  } catch (err) {
    if (!alive()) return;
    if (!(draft || finalRow)) {
      showWarnToast(err?.message || "Die Reise konnte nicht geladen werden.");
      paintUnavailable(vacation, err?.message || "Die Reise konnte nicht geladen werden.");
      return;
    }
  }
  if (!alive()) return;

  const focusFinal = recapId === "final";
  const focused = !focusFinal && recapId ? rows.find((row) => row.id === recapId) || null : null;

  if (!canEdit) {
    if (!finalRow) {
      paintUnavailable(vacation, unavailableCopy(tripId, "Noch kein Recap-Video."));
      return;
    }
    await paintStory(vacation, finalRow, material, { readonly: true, offerNewDraft: false });
    return;
  }

  if (focusFinal || focused?.status === "final") {
    const row = focusFinal ? finalRow : focused;
    if (row) {
      await paintStory(vacation, row, material, { readonly: true, offerNewDraft: true });
      return;
    }
    paintUnavailable(vacation, "Noch kein Recap-Video.");
    return;
  }

  if (focused?.status === "draft") {
    await paintStory(vacation, focused, material, { readonly: false });
    return;
  }

  if (recapId) {
    if (finalRow) {
      await paintStory(vacation, finalRow, material, { readonly: true, offerNewDraft: true });
      return;
    }
    paintUnavailable(vacation, "Dieser Entwurf ist nicht mehr da.");
    return;
  }

  if (draft) {
    await paintStory(vacation, draft, material, { readonly: false });
    return;
  }

  if (finalRow) {
    await paintStory(vacation, finalRow, material, { readonly: true, offerNewDraft: true });
    return;
  }

  const built = buildVideoRecap(material);
  if (!built.ok) {
    paintEmpty(vacation, built.counts);
    return;
  }

  paintShell(vacation, { busy: true });
  try {
    const created = await createVideoDraft(tripId, { version: 1 });
    if (!alive()) return;
    if (!created.row) {
      paintEmpty(vacation, created.built?.counts || built.counts);
      return;
    }
    await paintStory(vacation, created.row, material, { readonly: false });
  } catch (err) {
    if (!alive()) return;
    const message = err instanceof RecapUnavailableError ? err.message : err?.message || "Der Entwurf konnte nicht gespeichert werden.";
    showWarnToast(message);
    paintUnavailable(vacation, message);
  }

  function paintShell(current, { busy = false, preview = false } = {}) {
    appEl.className = "screen screen--settings";
    appEl.dataset.testid = "recap-screen";
    appEl.dataset.vacationId = current.id;
    const previewBtn = preview
      ? `<button type="button" class="link-btn" data-action="preview" data-testid="recap-preview">▶ Vorschau</button>`
      : `<span class="map-header__spacer" aria-hidden="true"></span>`;
    appEl.innerHTML = `
      <header class="trip-header">
        <button type="button" class="link-btn link-btn--back" data-action="back">${ICON_BACK_CHEVRON}<span>Reise</span></button>
        <h1 class="trip-header__title">Recap-Video</h1>
        <div class="trip-header__actions">${previewBtn}</div>
      </header>
      <main class="settings-main" data-testid="recap-main">
        ${
          busy
            ? `<div class="trip-empty" aria-busy="true"><p class="trip-empty__title" data-testid="recap-working">in Bearbeitung</p></div>`
            : ""
        }
      </main>
    `;
    appEl.querySelector('[data-action="back"]')?.addEventListener("click", () => {
      navigate({ name: "urlaub-detail", id: tripId });
    });
  }

  function paintUnavailable(current, message) {
    paintShell(current);
    const main = appEl.querySelector('[data-testid="recap-main"]');
    if (!main) return;
    main.innerHTML = `
      <div class="trip-empty" data-testid="recap-unavailable">
        <p class="trip-empty__title">${escapeHtml(message)}</p>
      </div>`;
  }

  function paintEmpty(current, counts) {
    paintShell(current);
    const main = appEl.querySelector('[data-testid="recap-main"]');
    if (!main) return;
    const photos = counts?.photos || 0;
    const places = counts?.places || 0;
    const notes = counts?.notes || 0;
    const width = Math.max(0, Math.min(100, (photos / P.minPhotos) * 100));
    const placeReady = places >= 1;
    main.innerHTML = `
      <h2 class="recap-trip-title">${escapeHtml(current.title)}</h2>
      <p class="recap-kicker">${escapeHtml(formatDateShort(current.startDate))} · erster Reisetag</p>
      <section class="settings-card recap-empty" data-testid="recap-empty">
        <div class="recap-empty__icon" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="12" rx="2" stroke="#0066B3" stroke-width="1.8"/><path d="M8 6V5M12 6V4M16 6V5" stroke="#0066B3" stroke-width="1.8" stroke-linecap="round"/></svg>
        </div>
        <h3 class="recap-empty__title">Noch zu wenig für ein Video</h3>
        <p class="recap-empty__text">Ein Recap braucht mindestens 6 Fotos. Orte und Notizen machen es lebendiger.</p>
        <div class="recap-meter-row">
          <span>Fotos</span>
          <strong data-testid="recap-photo-count">${photos} von ${P.minPhotos}</strong>
          <span class="recap-meter" aria-hidden="true"><span style="width:${width}%"></span></span>
        </div>
        <div class="recap-meter-row">
          <span>Orte</span>
          <strong data-testid="recap-place-count">${places} von 1</strong>
          ${placeReady ? `<span class="recap-ok" data-testid="recap-place-ok" aria-label="genug Orte">✓</span>` : `<span></span>`}
        </div>
        <div class="recap-meter-row">
          <span>Notizen</span>
          <strong data-testid="recap-note-count">${notes} · optional</strong>
          <span></span>
        </div>
      </section>
      <section class="settings-card">
        <div class="settings-item">
          <p class="recap-hint" data-testid="recap-diary-hint">Reisetagebuch geht schon. Es braucht nur deinen Text, Fotos kommen dazu, sobald sie da sind.</p>
        </div>
      </section>
      <button type="button" class="btn btn-emaille btn-emaille--block" data-action="mediathek" data-testid="recap-open-library">Fotos aus der Mediathek holen</button>
      <button type="button" class="btn btn-emaille btn-emaille--ghost btn-emaille--block recap-soon" data-action="open-diary" data-testid="recap-diary-empty">Reisetagebuch erstellen</button>
    `;
    main.querySelector('[data-action="mediathek"]')?.addEventListener("click", () => {
      navigate({ name: "urlaub-mediathek", id: tripId });
    });
    main.querySelector('[data-action="open-diary"]')?.addEventListener("click", () => {
      navigate({ name: "urlaub-tagebuch", id: tripId });
    });
  }

  function linePhotoCount(source, viewCounts) {
    if (!Array.isArray(source?.photos)) return viewCounts.photos || 0;
    const counted = countMaterialPhotos(source.photos);
    if (counted > 0) return counted;
    return viewCounts.photos || 0;
  }

  async function loadSceneThumbs(photos, ids) {
    const signable = (photos || []).some(
      (photo) => ids.has(photo.id) && (photo.thumbPath || photo.storagePath)
    );
    const missing = (map) => signable && ids.size > 0 && !Object.keys(map || {}).length;
    const once = () => resolveThumbUrlMap(photos || [], ids);
    try {
      const first = await once();
      if (!missing(first)) return { thumbs: first, failed: false };
    } catch {
      /* einmal erneut versuchen */
    }
    await new Promise((resolve) => setTimeout(resolve, THUMB_RETRY_MS));
    if (!alive()) return { thumbs: {}, failed: false };
    try {
      const second = await once();
      if (!missing(second)) return { thumbs: second, failed: false };
    } catch {
      /* Hinweis statt leerer Kacheln ohne Erklärung */
    }
    return { thumbs: {}, failed: signable };
  }

  async function paintStory(current, row, source, { readonly, offerNewDraft = false }) {
    const view = viewModel(row.content, source.places);
    const thumbIds = new Set();
    for (const scene of view.scenes) {
      for (const mediaId of scene.mediaIds || []) thumbIds.add(mediaId);
    }
    const loaded = await loadSceneThumbs(source.photos || [], thumbIds);
    const thumbs = loaded.thumbs || {};
    const thumbsFailed = loaded.failed;
    if (!alive()) return;
    paintShell(current, { preview: true });
    const main = appEl.querySelector('[data-testid="recap-main"]');
    if (!main) return;
    const sceneCount = view.scenes.length;
    const sceneWord = sceneCount === 1 ? "Szene" : "Szenen";
    const kicker = readonly
      ? "Final"
      : `Entwurf ${row.version || 1} · Storyboard · ${sceneCount} ${sceneWord}`;
    const photosUsed = view.scenes.reduce((sum, scene) => sum + (scene.mediaIds?.length || 0), 0);
    const perPhoto = view.formula.perPhotoS ?? P.perPhotoS;
    const perNote = view.formula.perNoteS ?? P.perNoteS;
    function sceneCard(scene, index) {
      const color = sceneColor(scene, current);
      if (scene.type === "daymap") {
        return `
          <article class="settings-card recap-scene recap-scene--daymap" data-testid="recap-scene" data-kind="tageskarte" style="border-left-color:${color}">
            ${dayMapMount(scene.points, color, 120, "recap-daymap__map")}
            <div class="settings-item recap-scene__row">
              <span class="recap-scene__no">${index + 1}</span>
              <span class="recap-scene__text">
                <strong>${escapeHtml(sceneTitle(scene, current))}</strong>
                <span>${escapeHtml(sceneSub(scene, current))}</span>
              </span>
              <span class="recap-scene__time" data-testid="recap-scene-seconds">${escapeHtml(formatSeconds(scene.seconds))}</span>
            </div>
          </article>`;
      }
      const thumb = scene.mediaIds?.[0] ? thumbs[scene.mediaIds[0]] : "";
      const thumbHtml = thumb
        ? `<img class="recap-scene__thumb" src="${escapeHtml(thumb)}" alt="" />`
        : `<span class="recap-scene__thumb recap-scene__thumb--empty" style="background:${color}">${
            scene.type === "title" ? escapeHtml(monthName(current.startDate) || "") : ""
          }</span>`;
      return `
          <article class="settings-card recap-scene" data-testid="recap-scene" style="border-left-color:${color}">
            <div class="settings-item recap-scene__row">
              <span class="recap-scene__no">${index + 1}</span>
              ${thumbHtml}
              <span class="recap-scene__text">
                <strong>${escapeHtml(sceneTitle(scene, current))}</strong>
                <span>${escapeHtml(sceneSub(scene, current))}</span>
              </span>
              <span class="recap-scene__time" data-testid="recap-scene-seconds">${escapeHtml(formatSeconds(scene.seconds))}</span>
            </div>
          </article>`;
    }
    const actions = readonly
      ? offerNewDraft
        ? `<button type="button" class="btn btn-emaille btn-emaille--block" data-testid="recap-new-draft">Neuer Entwurf</button>`
        : ""
      : `
        <form class="recap-feedback" data-testid="recap-feedback-form">
          <label class="field">
            <input type="text" data-testid="recap-feedback-input" maxlength="2000" placeholder="Änderung wünschen, z. B. «langsamer»" />
          </label>
          <button type="submit" class="btn btn-emaille" data-testid="recap-feedback-send">Senden</button>
        </form>
        <div class="recap-actions">
          <button type="button" class="btn btn-emaille btn-emaille--ghost" data-testid="recap-discard">Verwerfen</button>
          <button type="button" class="btn btn-emaille" data-testid="recap-adopt">Übernehmen</button>
        </div>`;
    main.innerHTML = `
      <div data-testid="recap-storyboard">
        <h2 class="recap-trip-title">${escapeHtml(current.title)}</h2>
        <p class="recap-kicker" data-testid="recap-kicker">${escapeHtml(kicker)}</p>
        <section class="settings-card recap-duration" data-testid="recap-duration">
          <div class="settings-item settings-item--stack">
            <div class="recap-duration__head">
              <strong data-testid="recap-duration-label">${escapeHtml(fmt(view.seconds))}</strong>
              <span class="recap-tag" data-testid="recap-startwert">Startwert</span>
            </div>
            <p class="recap-duration__line" data-testid="recap-counts">${escapeHtml(
              ausZeile({ ...view.counts, photos: linePhotoCount(source, view.counts) })
            )}</p>
            <p class="recap-duration__meta" data-testid="recap-formula-line">${escapeHtml(
              `${countWord(photosUsed, "Foto", "Fotos")} im Video · ${formatDeNumber(perPhoto)} s je Foto · +${formatDeNumber(perNote)} s je Notiz`
            )}</p>
          </div>
        </section>
        ${
          thumbsFailed
            ? `<p class="recap-hint" data-testid="recap-thumb-hint">Vorschau gerade nicht verfügbar</p>`
            : ""
        }
        <div data-testid="recap-scenes"></div>
        ${actions}
      </div>`;
    let showAll = false;
    const paintSceneList = () => {
      const host = main.querySelector('[data-testid="recap-scenes"]');
      if (!host) return;
      const visible = showAll ? view.scenes : view.scenes.slice(0, SHOWN_SCENES);
      const toggle =
        view.scenes.length > SHOWN_SCENES
          ? `<button type="button" class="recap-show-all" data-testid="recap-show-all" aria-expanded="${showAll ? "true" : "false"}">${showAll ? "Weniger zeigen" : "Alle Szenen zeigen"}</button>`
          : "";
      host.innerHTML = visible.map((scene, index) => sceneCard(scene, index)).join("") + toggle;
      fillDayMaps(host);
    };
    paintSceneList();
    main.addEventListener("click", (event) => {
      const button = event.target?.closest?.('[data-testid="recap-show-all"]');
      if (!button) return;
      showAll = !showAll;
      paintSceneList();
    });
    appEl.querySelector('[data-action="preview"]')?.addEventListener("click", () => {
      openPreview(current, view, thumbs);
    });
    if (readonly) {
      main.querySelector('[data-testid="recap-new-draft"]')?.addEventListener("click", () => {
        void startNewDraft(row);
      });
      return;
    }
    const form = main.querySelector('[data-testid="recap-feedback-form"]');
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = form.querySelector('[data-testid="recap-feedback-input"]');
      const text = input?.value || "";
      if (!text.trim()) return;
      const send = form.querySelector('[data-testid="recap-feedback-send"]');
      if (send) send.disabled = true;
      try {
        const updated = await appendVideoFeedback(row, text);
        if (updated) Object.assign(row, updated);
        if (input) input.value = "";
        showToast("Wunsch gespeichert");
      } catch (err) {
        const message = err instanceof RecapUnavailableError ? err.message : err?.message || "Der Wunsch konnte nicht gespeichert werden.";
        showWarnToast(message);
      } finally {
        if (send) send.disabled = false;
      }
    });
    main.querySelector('[data-testid="recap-discard"]')?.addEventListener("click", async () => {
      const ok = await openConfirmDialog({
        title: "Entwurf verwerfen?",
        message: "Nur dieser Entwurf wird gelöscht. Eine freigegebene Fassung bleibt.",
        confirmLabel: "Verwerfen",
        cancelLabel: "Abbrechen",
        danger: true,
        testId: "recap-discard-confirm",
      });
      if (!ok || !alive()) return;
      try {
        await discardVideoDraft(row.id);
        showToast("Entwurf verworfen");
        navigate({ name: "urlaub-detail", id: tripId });
      } catch (err) {
        const message = err instanceof RecapUnavailableError ? err.message : err?.message || "Der Entwurf konnte nicht verworfen werden.";
        showWarnToast(message);
      }
    });
    main.querySelector('[data-testid="recap-adopt"]')?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await adoptVideoDraft(row);
        showToast("Storyboard übernommen");
        if (!alive()) return;
        await renderRecapVideo(appEl, tripId);
      } catch (err) {
        button.disabled = false;
        const message = err instanceof RecapUnavailableError ? err.message : err?.message || "Das Storyboard konnte nicht übernommen werden.";
        showWarnToast(message);
      }
    });
  }

  async function startNewDraft(sourceRow) {
    paintShell(vacation, { busy: true });
    try {
      const version = (Number(sourceRow?.version) || 1) + 1;
      const created = await createVideoDraft(tripId, { version, basedOn: sourceRow?.id || null });
      if (!alive()) return;
      if (!created.row) {
        paintEmpty(vacation, created.built?.counts || { photos: 0, places: 0, notes: 0 });
        return;
      }
      await paintStory(vacation, created.row, material, { readonly: false });
    } catch (err) {
      if (!alive()) return;
      const message = err instanceof RecapUnavailableError ? err.message : err?.message || "Der Entwurf konnte nicht gespeichert werden.";
      showWarnToast(message);
      paintUnavailable(vacation, message);
    }
  }

  function openPreview(current, view, thumbs) {
    stopPreview();
    const overlay = document.getElementById("overlay-root");
    if (!overlay) return;
    const frames = framesFor(current, view, thumbs);
    const loadedPhotos = frames.filter((frame) => frame.src && frame.mediaId).map((frame) => frame.mediaId);
    overlay.hidden = false;
    overlay.innerHTML = `
      <div class="sheet" data-testid="recap-slideshow" data-loaded-photos="${escapeHtml(loadedPhotos.join(" "))}" role="dialog" aria-modal="true" aria-label="Vorschau">
        <header class="sheet__header"><h2>Vorschau</h2></header>
        <div class="recap-stage" data-testid="recap-slide"></div>
        <button type="button" class="btn btn-emaille btn-emaille--block" data-testid="recap-slideshow-close">Schließen</button>
      </div>`;
    const stage = overlay.querySelector('[data-testid="recap-slide"]');
    let index = 0;
    const show = () => {
      const frame = frames[index] || frames[0];
      if (!frame || !stage) return;
      stage.classList.remove("recap-stage--on", "recap-stage--day");
      if (frame.kind === "daymap") {
        stage.classList.add("recap-stage--day");
        stage.innerHTML = `
          ${dayMapMount(frame.points, frame.color, 180, "recap-stage__map")}
          <div class="recap-stage__day">
            <span class="recap-stage__kicker">Tageskarte</span>
            ${frame.dateLabel ? `<strong>${escapeHtml(frame.dateLabel)}</strong>` : ""}
            <span class="recap-stage__sub">${escapeHtml(frame.subtitle || "")}</span>
          </div>`;
        fillDayMaps(stage);
      } else {
        stage.innerHTML = `
        ${frame.src ? `<img src="${escapeHtml(frame.src)}" alt="" />` : ""}
        <p>${escapeHtml(frame.title)}</p>`;
      }
      void stage.offsetWidth;
      stage.classList.add("recap-stage--on");
    };
    const step = () => {
      show();
      const wait = Math.max(400, frames[index]?.ms || 1500);
      previewTimer = window.setTimeout(() => {
        index = (index + 1) % frames.length;
        step();
      }, wait);
    };
    step();
    const domClose = () => {
      stopPreview();
      closePreview = null;
      overlay.hidden = true;
      overlay.innerHTML = "";
    };
    const active = bindOverlay(overlay, domClose);
    closePreview = () => closeOverlayHistory(active);
    overlay.querySelector('[data-testid="recap-slideshow-close"]')?.addEventListener("click", () => {
      if (closePreview) closePreview();
    });
  }
}

function framesFor(vacation, view, thumbs) {
  const perPhoto = (view.formula.perPhotoS ?? P.perPhotoS) * 1000;
  const perNote = (view.formula.perNoteS ?? P.perNoteS) * 1000;
  const perPlace = (view.formula.perPlaceS ?? P.perPlaceS) * 1000;
  const frames = [];
  for (const scene of view.scenes) {
    if (scene.type === "title") {
      frames.push({ ms: (scene.seconds || P.introS) * 1000, title: vacation.title, src: "" });
      continue;
    }
    if (scene.type === "outro") {
      frames.push({ ms: (scene.seconds || P.outroS) * 1000, title: "Schluss", src: "" });
      continue;
    }
    if (scene.type === "daymap") {
      const copy = dayMapCopy(scene, vacation);
      frames.push({
        kind: "daymap",
        ms: (scene.seconds || P.dayMapS) * 1000,
        points: scene.points || [],
        color: scene.date ? dayColorFor(vacation, scene.date) : "#1F6DB5",
        dateLabel: dayMapDateLabel(scene.date),
        subtitle: copy.subtitle,
      });
      continue;
    }
    const ids = scene.mediaIds || [];
    const noteMs = (scene.noteIds?.length || 0) * perNote;
    frames.push({ ms: perPlace, title: scene.name || "Ort", src: "" });
    if (!ids.length) {
      frames.push({ ms: Math.max(perPhoto, noteMs), title: scene.name || "Ort", src: "" });
      continue;
    }
    ids.forEach((id, index) => {
      const extra = index === ids.length - 1 ? noteMs : 0;
      frames.push({
        ms: perPhoto + extra,
        title: scene.name || "Ort",
        src: thumbs[id] || "",
        mediaId: id,
      });
    });
  }
  return frames.length ? frames : [{ ms: 1500, title: vacation.title, src: "" }];
}
