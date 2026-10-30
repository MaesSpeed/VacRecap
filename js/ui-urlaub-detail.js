import {
  adjacentDay,
  dayChipDateLine,
  dayIndexInTrip,
  dayRoleLabel,
  defaultActiveDay,
  vacationDays,
} from "./days.js";
import { getFreeNotesForDay, getPlacesForDay, getPlacesForVacation, getVacation } from "./db.js";
import { ICON_BACK_CHEVRON, ICON_GEAR, ICON_MAP } from "./icons.js";
import { fallbackPlaceName, formatTimeFromTs } from "./geo.js";
import { readPhotoTakenAt } from "./exif-taken-at.js";
import { rememberPlaceFromGps, trySoftPointOnOpen } from "./place-service.js";
import { newestHardPlace } from "./places.js";
import { leaveTripToOverview, navigate } from "./router.js";
import { getRememberLocationOnOpen } from "./settings-store.js";
import {
  createCapturePlace,
  createPlaceRedirect,
  deletePlaceIfEmpty,
  getOrCreateOhneOrtPlace,
  movePlacePhotos,
  previewNoteCaptureTarget,
  resolveCaptureTarget,
  resolvePhotoCaptureTarget,
} from "./target-place.js";
import { consumePendingFooter } from "./pending-footer.js";
import { loadTripSelection, saveTripSelection } from "./trip-selection-store.js";
import { prefetchCaptureGps, resetCaptureGpsPrefetch } from "./capture-gps-prefetch.js";
import { blockTripFooter, isTripFooterBlocked, SHEET_INPUT_BLOCK_MS } from "./overlay-stack.js";
import { photoKeptMessage } from "./cloud-errors.js";
import { dismissActiveToast, showToast, showTwoLineToast, showWarnToast } from "./toast.js";
import { openNoteSheet } from "./ui-note-sheet.js";
import { DAY_SWIPE_MS, daySwipeEase, installDaySwipe, setDaySwipeNeighbor, setDaySwipePage } from "./day-swipe.js";
import {
  filterViewableMedia,
  loadDayPlacesEnriched,
  renderPlaceListHtml,
  resolveThumbUrlMap,
  revokeThumbUrls,
  visibleThumbMediaIds,
  withFreeNotesHtml,
  wrapPlaceList,
} from "./ui-place-list.js";
import { canEditTripMedia, getMyTripRole } from "./trip-role.js";
import { deleteMedia } from "./db.js";
import { openConfirmDialog } from "./ui-confirm.js";
import { startGalleryPhotoUpload } from "./gallery-upload.js";
import { openPhotoUploadSheet } from "./ui-photo-upload-sheet.js";
import { openPhotoTargetSheet } from "./ui-photo-target-sheet.js";
import { openMediaViewer } from "./ui-media-viewer.js";

import { openEditPlaceSheet, openSoftPointSheet } from "./ui-place-sheets.js";
import { mountTripFooter } from "./ui-trip-footer.js";
import { escapeHtml, todayIso } from "./utils.js";

const tripUiState = new Map();

export function clearTripUiState(vacationId) {
  const state = tripUiState.get(vacationId);
  if (state?.thumbUrls) revokeThumbUrls(state.thumbUrls);
  tripUiState.delete(vacationId);
}

export function setTripSelection(vacationId, day, placeId) {
  const state = tripUiState.get(vacationId);
  if (!state) return;
  state.activeDay = day;
  state.selectedByDay[day] = placeId;
}

export async function storeTripSelection(vacationId, day, placeId) {
  const state = tripUiState.get(vacationId);
  if (state) {
    state.activeDay = day;
    if (placeId) state.selectedByDay[day] = placeId;
    persistSelection(vacationId, state);
    return;
  }
  const saved = (await loadTripSelection(vacationId)) || { selectedByDay: {}, activeDay: day };
  saved.activeDay = day;
  if (placeId) saved.selectedByDay[day] = placeId;
  await saveTripSelection(vacationId, saved);
}

async function getState(id, vacation) {
  let state = tripUiState.get(id);
  if (!state) {
    const saved = await loadTripSelection(id);
    state = {
      activeDay: saved?.activeDay ?? defaultActiveDay(vacation),
      selectedByDay: saved?.selectedByDay ?? {},
      notesExpanded: new Set(),
      freeNotesExpanded: false,
      openGeoDone: new Set(),
      captureBusy: false,
      listRefreshToken: 0,
      thumbUrls: {},
      freshPlaceIds: new Set(),
    };
    tripUiState.set(id, state);
  }
  if (!state.freshPlaceIds) state.freshPlaceIds = new Set();
  return state;
}

function persistSelection(id, state) {
  void saveTripSelection(id, {
    selectedByDay: state.selectedByDay,
    activeDay: state.activeDay,
  });
}

export async function renderUrlaubDetail(appEl, id) {
  const mountGen = appEl?.dataset?.appRenderGen ?? "";
  const vacation = await getVacation(id);
  if (appEl?.dataset?.appRenderGen !== mountGen) return;
  if (!vacation) {
    navigate({ name: "urlaube" });
    return;
  }

  const days = vacationDays(vacation);
  const state = await getState(id, vacation);

  appEl.className = "screen screen--trip screen--trip-swipe";
  appEl.dataset.vacationId = id;

  appEl.innerHTML = `
    <header class="trip-header">
      <button type="button" class="link-btn link-btn--back" data-action="back">${ICON_BACK_CHEVRON}<span>Reisen</span></button>
      <h1 class="trip-header__title">${escapeHtml(vacation.title)}</h1>
      <div class="trip-header__actions">
        <button type="button" class="icon-btn icon-btn--map-draft" data-action="map" aria-label="Karte">${ICON_MAP}</button>
        <button type="button" class="icon-btn icon-btn--gear-draft" data-action="settings" aria-label="Einstellungen">${ICON_GEAR}</button>
      </div>
    </header>
    <div class="day-nav">
      <div class="day-chips-wrap">
        <div class="day-chips" data-role="chips" role="tablist"></div>
      </div>
    </div>
    <main class="trip-content trip-content--places" data-role="day-content" data-testid="trip-content"></main>
    <input type="file" accept="image/*" capture="environment" hidden data-role="capture-photo-input" data-testid="capture-photo-input" />
    <input type="file" accept="video/*" capture="environment" hidden data-role="capture-video-input" data-testid="capture-video-input" />
    <input type="file" accept="image/*" multiple hidden data-role="gallery-input" data-testid="gallery-input" />
    <div data-role="footer-mount"></div>
  `;

  appEl.querySelector('[data-action="back"]').addEventListener("click", () => {
    clearTripUiState(id);
    leaveTripToOverview();
  });
  appEl.querySelector('[data-action="map"]').addEventListener("click", () => {
    navigate({ name: "urlaub-map", id }, { fromTrip: true });
  });
  appEl.querySelector('[data-action="settings"]').addEventListener("click", () => {
    navigate({ name: "urlaub-settings", id });
  });

  const chipsEl = appEl.querySelector('[data-role="chips"]');
  const contentEl = appEl.querySelector('[data-role="day-content"]');
  const neighborHold = { prev: "", next: "" };
  let chipFollowDay = null;
  let chipScrollToken = 0;
  installDaySwipe(contentEl, (dir) => shiftDay(dir), {
    onLock: () => {
      setDaySwipeNeighbor(contentEl, "prev", neighborHold.prev);
      setDaySwipeNeighbor(contentEl, "next", neighborHold.next);
    },
    onRest: () => {
      setDaySwipeNeighbor(contentEl, "prev", "");
      setDaySwipeNeighbor(contentEl, "next", "");
    },
    onCommit: (dir) => previewChipShift(dir),
  });
  const footerMount = appEl.querySelector('[data-role="footer-mount"]');
  const capturePhotoInput = appEl.querySelector('[data-role="capture-photo-input"]');
  const captureVideoInput = appEl.querySelector('[data-role="capture-video-input"]');
  const galleryInput = appEl.querySelector('[data-role="gallery-input"]');
  let captureTargetPlaceId = null;

  const VIDEO_LONGPRESS_HINT_KEY = "vacrecap-video-longpress-hint";
  const VIDEO_HINT_AFTER_PHOTO_MS = 3000;

  const CHIP_CENTER_EPS = 2;

  function chipsHtml() {
    const total = days.length;
    return days
      .map((iso, i) => {
        const active = iso === state.activeDay;
        const role = dayRoleLabel(i + 1, total);
        return `
        <button type="button" role="tab" aria-selected="${active}"
          class="day-chip${active ? " day-chip--active" : ""}" data-day="${iso}">
          <span class="day-chip__date">${dayChipDateLine(iso)}</span>
          <span class="day-chip__role">${role}</span>
        </button>`;
      })
      .join("");
  }

  function chipsMatchDays() {
    const nodes = chipsEl.querySelectorAll(".day-chip");
    if (nodes.length !== days.length) return false;
    for (let i = 0; i < days.length; i++) {
      if (nodes[i].dataset.day !== days[i]) return false;
    }
    return true;
  }

  function applyChipActive(dayIso) {
    for (const btn of chipsEl.querySelectorAll(".day-chip")) {
      const on = btn.dataset.day === dayIso;
      btn.classList.toggle("day-chip--active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  function chipScrollTarget(container, chip) {
    const c = container.getBoundingClientRect();
    const r = chip.getBoundingClientRect();
    const delta = r.left + r.width / 2 - (c.left + c.width / 2);
    const max = Math.max(0, container.scrollWidth - container.clientWidth);
    return Math.max(0, Math.min(max, container.scrollLeft + delta));
  }

  function scrollChipWithPage(dayIso, duration) {
    const chip = chipsEl.querySelector(`[data-day="${dayIso}"]`);
    if (!chip) return;
    chipsEl.scrollTo({ left: chipsEl.scrollLeft, behavior: "auto" });
    chipFollowDay = dayIso;
    const token = ++chipScrollToken;
    const target = chipScrollTarget(chipsEl, chip);
    const start = chipsEl.scrollLeft;
    const clearFollow = () => {
      if (token === chipScrollToken && chipFollowDay === dayIso) chipFollowDay = null;
    };
    if (duration <= 0 || Math.abs(target - start) <= CHIP_CENTER_EPS) {
      chipsEl.scrollLeft = target;
      clearFollow();
      return;
    }
    const t0 = performance.now();
    const step = (now) => {
      if (token !== chipScrollToken) return;
      const p = Math.min(1, (now - t0) / duration);
      chipsEl.scrollLeft = p >= 1 ? target : start + (target - start) * daySwipeEase(p);
      if (p < 1) requestAnimationFrame(step);
      else clearFollow();
    };
    requestAnimationFrame(step);
  }

  function previewChipShift(dir) {
    const next = adjacentDay(vacation, state.activeDay, dir);
    if (next === state.activeDay) return;
    if (!chipsEl.querySelector(`[data-day="${next}"]`)) return;
    applyChipActive(next);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollChipWithPage(next, reduce ? 0 : DAY_SWIPE_MS);
  }

  function renderChips() {
    const total = days.length;
    chipsEl.classList.toggle("day-chips--fill", total <= 4);
    if (!chipsMatchDays()) {
      const keep = chipsEl.scrollLeft;
      chipsEl.innerHTML = chipsHtml();
      if (chipsEl.scrollLeft !== keep) chipsEl.scrollLeft = keep;
      chipScrollToken += 1;
      chipFollowDay = null;
    } else {
      applyChipActive(state.activeDay);
    }
    if (chipFollowDay && chipFollowDay !== state.activeDay) {
      chipScrollToken += 1;
      chipFollowDay = null;
    }
    const chip = chipsEl.querySelector(`[data-day="${state.activeDay}"]`);
    if (!chip || chipFollowDay === state.activeDay) return;
    if (Math.abs(chipsEl.scrollLeft - chipScrollTarget(chipsEl, chip)) <= CHIP_CENTER_EPS) return;
    requestAnimationFrame(() => {
      if (chipFollowDay) return;
      const live = chipsEl.querySelector(`[data-day="${state.activeDay}"]`);
      if (!live || !live.isConnected) return;
      if (Math.abs(chipsEl.scrollLeft - chipScrollTarget(chipsEl, live)) <= CHIP_CENTER_EPS) return;
      live.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    });
  }

  async function ensureSelectedForDay(items, dayIso = state.activeDay) {
    if (state.selectedByDay[dayIso]) return state.selectedByDay[dayIso];
    const hard = items.map((i) => i.place).filter((p) => !p.soft);
    const newest = newestHardPlace(hard);
    if (newest) {
      state.selectedByDay[dayIso] = newest.id;
      persistSelection(id, state);
    }
    return state.selectedByDay[dayIso] ?? null;
  }

  async function maybeSoftOnOpen() {
    const day = state.activeDay;
    if (state.openGeoDone.has(day)) return;
    state.openGeoDone.add(day);
    const remember = await getRememberLocationOnOpen();
    if (!remember || day !== todayIso()) return;
    await trySoftPointOnOpen({
      vacationId: id,
      day,
      isToday: true,
    });
  }

  const emptyDayHtml = `
        <div class="trip-empty" data-testid="trip-empty">
          <p class="trip-empty__title">Noch keine Orte heute</p>
          <p class="trip-empty__hint">Ort merken, Foto machen oder Notiz schreiben.</p>
        </div>`;

  let warmHtml = new Map();
  let warmPlaces = null;

  function stripTestIds(html) {
    return String(html || "").replace(/\sdata-testid="[^"]*"/g, "");
  }

  async function buildDayHtml(dayIso, knownPlaces) {
    const items = await loadDayPlacesEnriched(id, dayIso, knownPlaces);
    const active = dayIso === state.activeDay;
    const selectedId = await ensureSelectedForDay(items, dayIso);
    const freeNotes = await getFreeNotesForDay(id, dayIso);
    const allMedia = items.flatMap((i) => i.media);
    const visibleIds = visibleThumbMediaIds(items, selectedId);
    const thumbUrls = active ? await resolveThumbUrlMap(allMedia, visibleIds) : {};
    const canEditMedia = active ? canEditTripMedia(await getMyTripRole(id)) : false;
    let placeHtml = emptyDayHtml;
    if (items.length) {
      const { listHtml, mediaErrorHtml } = renderPlaceListHtml(items, {
        selectedId,
        notesExpanded: active ? state.notesExpanded : new Set(),
        thumbUrls,
        canEditMedia,
        freshPlaceIds: state.freshPlaceIds,
      });
      placeHtml = wrapPlaceList(listHtml, mediaErrorHtml);
    }
    return {
      html: withFreeNotesHtml(placeHtml, freeNotes, {
        expanded: active && state.freeNotesExpanded,
        replaceEmpty: items.length === 0,
      }),
      thumbUrls,
    };
  }

  function clearWarm() {
    for (const built of warmHtml.values()) revokeThumbUrls(built?.thumbUrls);
    warmHtml = new Map();
    warmPlaces = null;
  }

  async function prefetchNeighbors(token) {
    const idx = days.indexOf(state.activeDay);
    const prev = idx > 0 ? days[idx - 1] : null;
    const next = idx < days.length - 1 ? days[idx + 1] : null;
    neighborHold.prev = "";
    neighborHold.next = "";
    for (const [key, day] of [
      ["prev", prev],
      ["next", next],
    ]) {
      if (!day) continue;
      let built = warmHtml.get(day);
      if (!built) {
        built = await buildDayHtml(day, warmPlaces);
        if (token !== state.listRefreshToken || !contentEl.isConnected) {
          revokeThumbUrls(built?.thumbUrls);
          return;
        }
        warmHtml.set(day, built);
      }
      neighborHold[key] = stripTestIds(built.html);
    }
  }

  async function refreshDayList({ reuse = false } = {}) {
    const token = ++state.listRefreshToken;
    await maybeSoftOnOpen();
    if (token !== state.listRefreshToken) return;
    if (!reuse) clearWarm();
    if (!warmPlaces) warmPlaces = await getPlacesForVacation(id);
    if (token !== state.listRefreshToken) return;
    let built = reuse ? warmHtml.get(state.activeDay) : null;
    if (!built) {
      built = await buildDayHtml(state.activeDay, warmPlaces);
      if (token !== state.listRefreshToken) {
        revokeThumbUrls(built?.thumbUrls);
        return;
      }
      warmHtml.set(state.activeDay, built);
    }
    if (!contentEl.isConnected) return;
    const previousThumbUrls = state.thumbUrls;
    state.thumbUrls = built.thumbUrls;
    const idx = days.indexOf(state.activeDay);
    contentEl.dataset.canPrev = idx > 0 ? "1" : "0";
    contentEl.dataset.canNext = idx < days.length - 1 ? "1" : "0";
    setDaySwipePage(contentEl, built.html);
    contentEl.dataset.activeDay = state.activeDay;
    bindBrokenThumbs(contentEl);
    if (previousThumbUrls && previousThumbUrls !== built.thumbUrls) revokeThumbUrls(previousThumbUrls);
    persistSelection(id, state);
    void prefetchNeighbors(token);
  }

  async function setActiveDay(dayIso) {
    if (!days.includes(dayIso) || dayIso === state.activeDay) return;
    state.activeDay = dayIso;
    persistSelection(id, state);
    renderChips();
    await refreshDayList();
  }

  function shiftDay(direction) {
    const next = adjacentDay(vacation, state.activeDay, direction);
    if (next === state.activeDay) return;
    state.activeDay = next;
    persistSelection(id, state);
    renderChips();
    void refreshDayList({ reuse: true });
  }

  async function onRememberPlace() {
    let result;
    try {
      result = await rememberPlaceFromGps({
        vacationId: id,
        day: state.activeDay,
      });
    } catch (err) {
      showWarnToast(err?.message || "Der Ort konnte nicht angelegt werden. Bitte erneut versuchen.");
      return;
    }
    if (!result) return;
    state.selectedByDay[state.activeDay] = result.place.id;
    persistSelection(id, state);
    if (result.duplicate) {
      showTwoLineToast("Schon gemerkt", `Zu «${result.place.name}» hinzugefügt`);
    } else if (!result.noGps) {
      showTwoLineToast("Neuer Ort", result.place.name);
    }
    await refreshDayList();
  }

  function watchCaptureRename(r) {
    void r?.renamed?.then((updated) => {
      if (!updated?.name) return;
      r.place.name = updated.name;
      r.place.title = updated.name;
      if (r.toast?.title?.startsWith("Neue Karte")) {
        r.toast.title = `Neue Karte «${updated.name}»`;
      }
      const title = document.querySelector('[data-testid="app-toast"] .toast__line--title');
      if (title?.textContent?.startsWith("Neue Karte")) {
        title.textContent = `Neue Karte «${updated.name}»`;
      }
    });
  }

  function applyCaptureSelection(r) {
    if (r.day && days.includes(r.day)) state.activeDay = r.day;
    state.selectedByDay[r.day] = r.place.id;
    if (r.createdNew) state.freshPlaceIds.add(r.place.id);
    persistSelection(id, state);
    watchCaptureRename(r);
  }

  async function undoNewCapture(r, redirect) {
    const previous = r.previousPlace;
    if (!previous || !r.createdNew) return;
    r.cancelRename?.();
    const gate = r.enqueue || ((fn) => fn());
    await gate(() =>
      redirect.run(async () => {
        redirect.place = previous;
        redirect.retirePlaceId = r.place.id;
        const ids = redirect.captureMediaIds();
        if (ids.length) await movePlacePhotos(r.place.id, previous, ids);
        if (redirect.pending === 0) await deletePlaceIfEmpty(r.place.id);
      })
    );
    state.freshPlaceIds.delete(r.place.id);
    state.selectedByDay[previous.day || previous.dayDate || r.day] = previous.id;
    if (previous.day && days.includes(previous.day)) state.activeDay = previous.day;
    persistSelection(id, state);
    await refreshDayList();
  }

  async function changeInaccurateCapture(r, redirect) {
    const captureDay = r.day;
    const places = (await getPlacesForDay(id, captureDay)).filter((p) => !p.soft);
    const options = [];
    if (r.position?.latitude != null) {
      const ts = Date.now();
      options.push({
        key: "new",
        kind: "new",
        title: `Neue Karte «${fallbackPlaceName(ts)}»`,
        sub: "Name aus Standort",
        selected: false,
        ts,
      });
    }
    for (const place of places) {
      const selected = place.id === r.place?.id;
      options.push({
        key: place.id,
        kind: "place",
        place,
        title: place.name,
        sub: selected ? `ausgewählte Karte · ${formatTimeFromTs(place.ts)}` : formatTimeFromTs(place.ts),
        selected,
      });
    }
    options.push({
      key: "ohne",
      kind: "ohne",
      title: "Ohne Ort",
      sub: "keine Karte, nur der Tag",
      selected: r.place?.name === "Ohne Ort" && r.place?.lat == null,
    });
    const choice = await openPhotoTargetSheet({ title: "Ziel für 1 Foto", options });
    if (!choice) return;
    let next = choice.place || null;
    if (choice.kind === "new") {
      const created = await createCapturePlace({
        vacationId: id,
        day: captureDay,
        lat: r.position.latitude,
        lng: r.position.longitude,
        accuracy: r.position.accuracy,
        ts: choice.ts || Date.now(),
      });
      next = created.place;
      state.freshPlaceIds.add(next.id);
      watchCaptureRename({ place: next, toast: null, renamed: created.renamed });
    } else if (choice.kind === "ohne") {
      next = (await getOrCreateOhneOrtPlace({ vacationId: id, day: captureDay, showToastOnCreate: false })).place;
    }
    if (!next || next.id === redirect.place?.id) return;
    const fromId = redirect.place?.id;
    await redirect.run(async () => {
      const ids = redirect.captureMediaIds();
      redirect.place = next;
      if (fromId && fromId !== next.id && ids.length) await movePlacePhotos(fromId, next, ids);
    });
    state.selectedByDay[next.day || captureDay] = next.id;
    persistSelection(id, state);
    await refreshDayList();
  }

  function presentCaptureToast(r, redirect) {
    const toast = r.toast;
    if (!toast?.line && !toast?.title) return;
    if (toast.variant === "warn") {
      showWarnToast(toast.line, {
        title: toast.title,
        undoLabel: "Ändern",
        onUndo: () => {
          void changeInaccurateCapture(r, redirect);
        },
      });
      return;
    }
    if (toast.action === "undo" && r.previousPlace) {
      showTwoLineToast(toast.title, toast.line, {
        undoLabel: "Rückgängig",
        onUndo: () => {
          void undoNewCapture(r, redirect);
        },
      });
      return;
    }
    if (toast.line) showTwoLineToast(toast.title, toast.line);
    else if (toast.title) showToast(toast.title);
  }

  function showCaptureResultToast(r, mediaKind) {
    const defaultTitle =
      mediaKind === "video"
        ? "Video gespeichert"
        : mediaKind === "note"
          ? "Notiz gespeichert"
          : "Foto gespeichert";
    const title = r.toast?.title || defaultTitle;
    const line = r.toast?.line || "";
    if (!line) return;
    if (r.toast?.variant === "warn") {
      showWarnToast(line);
    } else {
      showTwoLineToast(title, line);
    }
  }

  function openCapturePhotoInput(placeId = null) {
    if (state.captureBusy || isTripFooterBlocked()) return;
    captureTargetPlaceId = placeId;
    blockTripFooter(SHEET_INPUT_BLOCK_MS);
    if (!placeId) prefetchCaptureGps();
    capturePhotoInput.click();
  }

  function openNativeCamera() {
    openCapturePhotoInput(null);
  }

  function openNativeVideoCamera() {
    showToast("Videos kommen in einem späteren Paket.", { icon: "none" });
  }

  async function resolveCameraTarget(files) {
    const selectedPlaceId = captureTargetPlaceId || state.selectedByDay[state.activeDay];
    const takenAt = (await readPhotoTakenAt(files?.[0])) ?? Date.now();
    const r = await resolvePhotoCaptureTarget({
      vacation,
      vacationId: id,
      day: state.activeDay,
      selectedPlaceId,
      takenAt,
      mediaKind: "photo",
    });
    applyCaptureSelection(r);
    if (r.needsRefresh) {
      renderChips();
      await refreshDayList();
    }
    return r;
  }

  async function beginPhotoUpload(files) {
    if (!files?.length || state.captureBusy) return;
    state.captureBusy = true;
    appEl.dataset.captureBusy = "1";
    try {
      const r = await resolveCameraTarget(files);
      const redirect = createPlaceRedirect(r.place);
      openPhotoUploadSheet({
        files,
        place: r.place,
        vacationId: id,
        day: r.day,
        redirect,
        onDone: () => refreshDayList(),
      });
      presentCaptureToast(r, redirect);
    } catch (err) {
      const message = photoKeptMessage(err);
      showWarnToast(message);
      openPhotoUploadSheet({
        files,
        place: null,
        vacationId: id,
        day: state.activeDay,
        heldMessage: message,
        ensurePlace: async () => (await resolveCameraTarget(files)).place,
        onDone: () => refreshDayList(),
      });
    } finally {
      state.captureBusy = false;
      appEl.dataset.captureBusy = "0";
      captureTargetPlaceId = null;
      capturePhotoInput.value = "";
      galleryInput.value = "";
      resetCaptureGpsPrefetch();
    }
  }

  async function handleMediaFile(file, kind) {
    if (!file || state.captureBusy) return;
    if (kind === "video") {
      openNativeVideoCamera();
      captureVideoInput.value = "";
      return;
    }
    await beginPhotoUpload([file]);
  }

  function bindBrokenThumbs(root) {
    root.querySelectorAll("img.tile__img, img.th__img").forEach((img) => {
      if (img.dataset.brokenBound === "1") return;
      img.dataset.brokenBound = "1";
      img.addEventListener("error", () => {
        const host = img.closest(".tile, .th");
        if (!host || host.querySelector("[data-testid='thumb-missing']")) {
          img.remove();
          return;
        }
        img.remove();
        const hint = document.createElement("span");
        hint.className = "thumb-missing";
        hint.dataset.testid = "thumb-missing";
        hint.textContent = "Datei fehlt";
        host.appendChild(hint);
      });
    });
  }

  const onCaptureInputAborted = () => {
    captureTargetPlaceId = null;
    resetCaptureGpsPrefetch();
  };

  capturePhotoInput.addEventListener("change", () => {
    const file = capturePhotoInput.files?.[0];
    if (!file) {
      onCaptureInputAborted();
      return;
    }
    handleMediaFile(file, "photo");
  });
  capturePhotoInput.addEventListener("cancel", onCaptureInputAborted);

  captureVideoInput.addEventListener("change", () => {
    const file = captureVideoInput.files?.[0];
    if (!file) {
      onCaptureInputAborted();
      return;
    }
    handleMediaFile(file, "video");
  });
  captureVideoInput.addEventListener("cancel", onCaptureInputAborted);

  async function onNoteFooter() {
    if (state.captureBusy) return;
    const items = await loadDayPlacesEnriched(id, state.activeDay);
    const selectedId = await ensureSelectedForDay(items);
    const initialPlace = selectedId
      ? items.find((i) => i.place.id === selectedId)?.place ?? null
      : null;
    openNoteSheet({
      place: initialPlace,
      vacationId: id,
      vacation,
      day: state.activeDay,
      dayIndex: dayIndexInTrip(vacation, state.activeDay),
      placesForDay: async () => {
        const items = await loadDayPlacesEnriched(id, state.activeDay);
        return items.map((i) => i.place).filter((p) => !p.soft);
      },
      previewPlaceLabel: () =>
        previewNoteCaptureTarget({
          vacationId: id,
          day: state.activeDay,
          selectedPlaceId: state.selectedByDay[state.activeDay],
        }),
      resolvePlaceOnSave: async () => {
        const r = await resolveCaptureTarget({
          vacationId: id,
          day: state.activeDay,
          selectedPlaceId: state.selectedByDay[state.activeDay],
          mediaKind: "note",
        });
        state.selectedByDay[state.activeDay] = r.place.id;
        persistSelection(id, state);
        return r;
      },
      onSaved: (captureResult) => {
        if (captureResult?.toast?.line) {
          showCaptureResultToast(captureResult, "note");
        }
        return refreshDayList();
      },
      onPlaceChange: (placeId) => {
        state.selectedByDay[state.activeDay] = placeId;
        persistSelection(id, state);
      },
    });
  }

  contentEl.addEventListener("click", async (e) => {
    const camBtn = e.target.closest('[data-action="camera-place"]');
    const galleryPlaceBtn = e.target.closest('[data-action="gallery-place"]');
    if (camBtn || galleryPlaceBtn) {
      const host = e.target.closest(".oc[data-place-id]");
      if (!host) return;
      const placeId = host.dataset.placeId;
      state.selectedByDay[state.activeDay] = placeId;
      persistSelection(id, state);
      if (galleryPlaceBtn) {
        if (state.captureBusy || isTripFooterBlocked()) return;
        blockTripFooter(SHEET_INPUT_BLOCK_MS);
        galleryInput.click();
        return;
      }
      openCapturePhotoInput(placeId);
      return;
    }

    const removeFailed = e.target.closest('[data-action="remove-failed-media"]');
    if (removeFailed) {
      e.preventDefault();
      e.stopPropagation();
      const mediaId = removeFailed.dataset.mediaId;
      const placeHost = e.target.closest(".oc[data-place-id]");
      if (!mediaId || !placeHost) return;
      const ok = await openConfirmDialog({
        title: "Fehlgeschlagenes Foto entfernen?",
        message: "Der Eintrag wird gelöscht. Du kannst das Foto erneut hochladen.",
        testId: "confirm-remove-failed-media",
      });
      if (!ok) return;
      await deleteMedia(mediaId);
      await refreshDayList();
      return;
    }

    const tile = e.target.closest(".tile[data-media-id]");
    if (tile) {
      const status = tile.dataset.uploadStatus || "uploaded";
      if (status !== "uploaded") {
        return;
      }
      const placeId = e.target.closest(".oc[data-place-id]")?.dataset.placeId;
      if (!placeId) return;
      const items = await loadDayPlacesEnriched(id, state.activeDay);
      const item = items.find((i) => i.place.id === placeId);
      if (!item) return;
      const viewable = filterViewableMedia(item.media);
      const canDelete = canEditTripMedia(await getMyTripRole(id));
      openMediaViewer(viewable, tile.dataset.mediaId, {
        canDelete,
        onChanged: () => refreshDayList(),
      });
      return;
    }

    const retryMedia = e.target.closest('[data-action="retry-media-load"]');
    if (retryMedia) {
      await refreshDayList();
      return;
    }

    const noteRowClick = e.target.closest(".oc .nr[data-note-id]");
    if (noteRowClick && !e.target.closest('[data-action="edit-note"]')) {
      const placeHost = e.target.closest(".oc[data-place-id]");
      if (!placeHost) return;
      const placeId = placeHost.dataset.placeId;
      if (placeId !== state.selectedByDay[state.activeDay]) {
        state.selectedByDay[state.activeDay] = placeId;
        persistSelection(id, state);
        await refreshDayList();
        return;
      }
    }

    const editNoteBtn = e.target.closest('[data-action="edit-note"]');
    if (editNoteBtn) {
      const noteRow = editNoteBtn.closest("[data-note-id]");
      const placeHost = e.target.closest(".oc[data-place-id]");
      if (!noteRow || !placeHost) return;
      const placeId = placeHost.dataset.placeId;
      if (placeId !== state.selectedByDay[state.activeDay]) {
        state.selectedByDay[state.activeDay] = placeId;
        persistSelection(id, state);
        await refreshDayList();
        return;
      }
      const items = await loadDayPlacesEnriched(id, state.activeDay);
      const item = items.find((i) => i.place.id === placeHost.dataset.placeId);
      const note = item?.notes.find((n) => n.id === noteRow.dataset.noteId);
      if (!note || !item) return;
      openNoteSheet({
        place: item.place,
        vacationId: id,
        vacation,
        day: state.activeDay,
        dayIndex: dayIndexInTrip(vacation, state.activeDay),
        placesForDay: async () => {
          const list = await loadDayPlacesEnriched(id, state.activeDay);
          return list.map((i) => i.place).filter((p) => !p.soft);
        },
        note,
        onSaved: () => refreshDayList(),
        onPlaceChange: (pid) => {
          state.selectedByDay[state.activeDay] = pid;
          persistSelection(id, state);
        },
      });
      return;
    }

    const freeHost = e.target.closest('[data-testid="free-notes"]');
    if (freeHost) {
      if (e.target.closest('[data-action="expand-free-notes"]')) {
        state.freeNotesExpanded = true;
        await refreshDayList();
        return;
      }
      if (e.target.closest('[data-action="collapse-free-notes"]')) {
        state.freeNotesExpanded = false;
        await refreshDayList();
        return;
      }
      const editFree =
        e.target.closest('[data-action="edit-free-note"]') || e.target.closest("[data-free-note]");
      const addFree = e.target.closest('[data-action="add-free-note"]');
      if (editFree || addFree) {
        const notes = await getFreeNotesForDay(id, state.activeDay);
        const note = editFree
          ? notes.find((n) => n.id === editFree.closest("[data-note-id]")?.dataset.noteId)
          : null;
        if (editFree && !note) return;
        openNoteSheet({
          place: null,
          initialFree: true,
          vacationId: id,
          vacation,
          day: state.activeDay,
          dayIndex: dayIndexInTrip(vacation, state.activeDay),
          placesForDay: async () => {
            const list = await loadDayPlacesEnriched(id, state.activeDay);
            return list.map((i) => i.place).filter((p) => !p.soft);
          },
          note: note || undefined,
          onSaved: () => refreshDayList(),
          onPlaceChange: (pid) => {
            if (!pid) return;
            state.selectedByDay[state.activeDay] = pid;
            persistSelection(id, state);
          },
        });
      }
      return;
    }

    const addNoteBtn = e.target.closest('[data-action="add-note"]');
    if (addNoteBtn) {
      const host = e.target.closest(".oc[data-place-id]");
      if (!host) return;
      const placeId = host.dataset.placeId;
      const items = await loadDayPlacesEnriched(id, state.activeDay);
      const item = items.find((i) => i.place.id === placeId);
      if (!item) return;
      state.selectedByDay[state.activeDay] = placeId;
      persistSelection(id, state);
      openNoteSheet({
        place: item.place,
        vacationId: id,
        vacation,
        day: state.activeDay,
        dayIndex: dayIndexInTrip(vacation, state.activeDay),
        placesForDay: async () => {
          const list = await loadDayPlacesEnriched(id, state.activeDay);
          return list.map((i) => i.place).filter((p) => !p.soft);
        },
        onSaved: () => refreshDayList(),
        onPlaceChange: (pid) => {
          state.selectedByDay[state.activeDay] = pid;
          persistSelection(id, state);
        },
      });
      return;
    }

    const editBtn = e.target.closest('[data-action="edit-place"]');
    const expandBtn = e.target.closest('[data-action="expand-notes"]');
    const collapseBtn = e.target.closest('[data-action="collapse-notes"]');
    if (editBtn || expandBtn || collapseBtn) {
      const host = e.target.closest(".oc[data-place-id]");
      if (!host) return;
      const placeId = host.dataset.placeId;
      const items = await loadDayPlacesEnriched(id, state.activeDay);
      const item = items.find((i) => i.place.id === placeId);
      if (!item) return;
      if (editBtn) {
        openEditPlaceSheet(item.place, {
          onSaved: async () => refreshDayList(),
          onDeleted: async (pid) => {
            if (state.selectedByDay[state.activeDay] === pid) {
              delete state.selectedByDay[state.activeDay];
            }
            await refreshDayList();
          },
        });
      } else if (expandBtn) {
        state.notesExpanded.add(placeId);
        await refreshDayList();
      } else if (collapseBtn) {
        state.notesExpanded.delete(placeId);
        await refreshDayList();
      }
      return;
    }

    const soft = e.target.closest(".soft[data-place-id]");
    if (soft) {
      const placeId = soft.dataset.placeId;
      const items = await loadDayPlacesEnriched(id, state.activeDay);
      const item = items.find((i) => i.place.id === placeId);
      if (!item) return;
      openSoftPointSheet(item.place, {
        vacationId: id,
        day: state.activeDay,
        onPromoted: async (p, duplicate) => {
          state.selectedByDay[state.activeDay] = p.id;
          persistSelection(id, state);
          if (duplicate) {
            showTwoLineToast("Schon gemerkt", `Zu «${p.name}» hinzugefügt`);
          } else {
            showTwoLineToast("Neuer Ort", p.name);
          }
          await refreshDayList();
        },
        onDiscarded: async () => refreshDayList(),
      });
      return;
    }

    const card = e.target.closest(".oc[data-place-id]");
    if (card && !card.classList.contains("oc--selected")) {
      state.selectedByDay[state.activeDay] = card.dataset.placeId;
      persistSelection(id, state);
      await refreshDayList();
    }
  });

  renderChips();
  await refreshDayList();
  if (appEl?.dataset?.appRenderGen !== mountGen) return;

  galleryInput.addEventListener("change", () => {
    const files = [...(galleryInput.files || [])];
    galleryInput.value = "";
    if (!files.length || state.captureBusy) return;
    state.captureBusy = true;
    appEl.dataset.captureBusy = "1";
    void startGalleryPhotoUpload({
      vacation,
      vacationId: id,
      files,
      day: state.activeDay,
      selectedPlaceId: state.selectedByDay[state.activeDay],
      onDone: () => refreshDayList(),
    })
      .then((target) => {
        if (!target?.place) return;
        if (target.day && days.includes(target.day)) state.selectedByDay[target.day] = target.place.id;
        else state.selectedByDay[state.activeDay] = target.place.id;
        for (const freshId of target.freshIds || []) state.freshPlaceIds.add(freshId);
        persistSelection(id, state);
        if (target.needsRefresh) return refreshDayList();
        return null;
      })
      .catch((err) => {
        showWarnToast(err?.message || "Foto konnte nicht zugeordnet werden.");
      })
      .finally(() => {
        state.captureBusy = false;
        appEl.dataset.captureBusy = "0";
        galleryInput.value = "";
      });
  });

  mountTripFooter(footerMount, {
    onRememberPlace,
    onCamera: openNativeCamera,
    onCameraVideo: openNativeVideoCamera,
    onNote: onNoteFooter,
    onGallery: () => {
      if (state.captureBusy || isTripFooterBlocked()) return;
      navigate({ name: "urlaub-mediathek", id });
    },
  });

  chipsEl.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-day]");
    if (chip) setActiveDay(chip.dataset.day);
  });


  const pendingFooter = consumePendingFooter();
  if (pendingFooter === "note") {
    requestAnimationFrame(() => void onNoteFooter());
  } else if (pendingFooter === "gallery") {
    requestAnimationFrame(() => navigate({ name: "urlaub-mediathek", id }));
  } else if (pendingFooter === "camera") {
    requestAnimationFrame(() => openNativeCamera());
  }
}

