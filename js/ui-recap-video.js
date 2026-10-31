import { RecapUnavailableError } from "./cloud-errors.js";
import { dayColorFor } from "./day-colors.js";
import { dayChipDateLine } from "./days.js";
import { getVacation } from "./db.js";
import { ICON_BACK_CHEVRON } from "./icons.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { P, fmt } from "./recap-duration.js";
import {
  adoptVideoDraft,
  appendVideoFeedback,
  createVideoDraft,
  discardVideoDraft,
  listVideoRecaps,
  loadRecapMaterial,
} from "./recap-service.js";
import { buildVideoRecap } from "./recap-storyboard.js";
import { navigate } from "./router.js";
import { canEditTripMedia, getMyTripRole, tripRoleLoadFailed } from "./trip-role.js";
import { openConfirmDialog } from "./ui-confirm.js";
import { resolveThumbUrlMap } from "./ui-place-list.js";
import { showToast, showWarnToast } from "./toast.js";
import { escapeHtml, formatDateShort, parseIsoDate } from "./utils.js";

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

async function canEditRecap(tripId) {
  const role = await getMyTripRole(tripId);
  if (tripRoleLoadFailed(tripId)) return false;
  return canEditTripMedia(role);
}

export async function loadRecapEntry(tripId) {
  try {
    const canEdit = await canEditRecap(tripId);
    if (canEdit) return { canEdit: true, hasFinal: false };
    const rows = await listVideoRecaps(tripId);
    return { canEdit: false, hasFinal: rows.some((row) => row.status === "final") };
  } catch {
    return { canEdit: false, hasFinal: false };
  }
}

export function recapEntryCardHtml({ canEdit, hasFinal }) {
  if (!canEdit && !hasFinal) return "";
  const primary = canEdit
    ? `<button type="button" class="btn btn-emaille btn-emaille--ghost recap-banner__btn" data-action="open-recap-video" data-testid="recap-create"><span class="recap-banner__btn-title">Recap-Video</span><span class="recap-banner__btn-sub">erstellen</span></button>`
    : `<button type="button" class="btn btn-emaille btn-emaille--ghost recap-banner__btn" data-action="open-recap-video" data-testid="recap-open-final"><span class="recap-banner__btn-title">Recap-Video</span><span class="recap-banner__btn-sub">ansehen</span></button>`;
  const diary = canEdit
    ? `<button type="button" class="btn btn-emaille btn-emaille--ghost recap-banner__btn" data-testid="recap-diary-soon" disabled><span class="recap-banner__btn-title">Reisetagebuch</span><span class="recap-banner__btn-sub">bald</span></button>`
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

function moreLine(scenes) {
  if (scenes.length <= SHOWN_SCENES) return "";
  const rest = scenes.slice(SHOWN_SCENES);
  const places = rest.filter((scene) => scene.type === "place");
  const parts = [];
  if (places.length === 1) parts.push(places[0].name);
  else if (places.length > 1) parts.push(`${places[0].name} … ${places[places.length - 1].name}`);
  if (rest.some((scene) => scene.type === "outro")) parts.push("Schluss");
  const n = rest.length;
  const noun = n === 1 ? "Szene" : "Szenen";
  const inner = parts.join(", ");
  return `+ ${n} ${noun}${inner ? ` (${inner})` : ""}`;
}

function sceneTitle(scene, vacation) {
  if (scene.type === "title") return "Titel";
  if (scene.type === "outro") return "Schluss";
  const day = scene.date ? dayChipDateLine(scene.date) : "";
  return day ? `${day} · ${scene.name}` : scene.name;
}

function sceneSub(scene, vacation) {
  if (scene.type === "title") {
    const month = monthName(vacation.startDate);
    return month ? `${vacation.title} · ${month}` : vacation.title;
  }
  if (scene.type === "outro") return "Ende der Reise";
  return sceneMeta(scene);
}

export async function renderRecapVideo(appEl, tripId) {
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

  if (!canEdit) {
    if (!finalRow) {
      paintUnavailable(vacation, "Noch kein Recap-Video.");
      return;
    }
    await paintStory(vacation, finalRow, material, { readonly: true, offerNewDraft: false });
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
      <button type="button" class="btn btn-emaille btn-emaille--ghost btn-emaille--block recap-soon" data-testid="recap-diary-soon" disabled>Reisetagebuch erstellen · bald</button>
    `;
    main.querySelector('[data-action="mediathek"]')?.addEventListener("click", () => {
      navigate({ name: "urlaub-mediathek", id: tripId });
    });
  }

  async function paintStory(current, row, source, { readonly, offerNewDraft = false }) {
    const view = viewModel(row.content, source.places);
    const thumbIds = new Set();
    for (const scene of view.scenes) {
      for (const mediaId of scene.mediaIds || []) thumbIds.add(mediaId);
    }
    let thumbs = {};
    try {
      thumbs = await resolveThumbUrlMap(source.photos || [], thumbIds);
    } catch {
      thumbs = {};
    }
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
    const visible = view.scenes.slice(0, SHOWN_SCENES);
    const extra = moreLine(view.scenes);
    const rowsHtml = visible
      .map((scene, index) => {
        const color =
          scene.type === "place" && scene.date
            ? dayColorFor(current, scene.date)
            : scene.type === "title"
              ? "#163a78"
              : "#5b6b7a";
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
      })
      .join("");
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
            <p class="recap-duration__line" data-testid="recap-counts">${escapeHtml(ausZeile(view.counts))}</p>
            <p class="recap-duration__meta" data-testid="recap-formula-line">${escapeHtml(
              `${countWord(photosUsed, "Foto", "Fotos")} im Video · ${formatDeNumber(perPhoto)} s je Foto · +${formatDeNumber(perNote)} s je Notiz`
            )}</p>
          </div>
        </section>
        <div data-testid="recap-scenes">${rowsHtml}</div>
        ${extra ? `<p class="recap-more" data-testid="recap-more">${escapeHtml(extra)}</p>` : ""}
        ${actions}
      </div>`;
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
      stage.classList.remove("recap-stage--on");
      stage.innerHTML = `
        ${frame.src ? `<img src="${escapeHtml(frame.src)}" alt="" />` : ""}
        <p>${escapeHtml(frame.title)}</p>`;
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
