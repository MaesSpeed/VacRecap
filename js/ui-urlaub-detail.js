import {
  adjacentDay,
  dayChipDateLine,
  dayIndexInTrip,
  dayRoleLabel,
  defaultActiveDay,
  vacationDays,
} from "./days.js";
import { getUserId } from "./auth-service.js";
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
import { blockTripFooter, hasActiveOverlay, isTripFooterBlocked, requestOverlayDismiss, SHEET_INPUT_BLOCK_MS } from "./overlay-stack.js";
import { CloudNetworkError, CloudOfflineError, photoKeptMessage } from "./cloud-errors.js";
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
import { canCaptionMedia, mediaOwnedBy, movePhotosToPlace, restorePhotoPlacement } from "./photo-move.js";
import { openPhotoMoveSheet } from "./ui-photo-move-sheet.js";
import { openPhotoTargetSheet } from "./ui-photo-target-sheet.js";
import { openMediaViewer } from "./ui-media-viewer.js";
import { openPhotoCaptionSheet } from "./ui-photo-caption-sheet.js";

import { openEditPlaceSheet, openSoftPointSheet } from "./ui-place-sheets.js";
import { mountTripFooter } from "./ui-trip-footer.js";
import { escapeHtml, todayIso } from "./utils.js";
import { tripCompanionsMarkup } from "./vacation.js";

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
      photoSelecting: false,
      photoSelected: new Set(),
      userId: null,
      moveBusy: false,
      captionBusy: false,
    };
    tripUiState.set(id, state);
  }
  if (!state.freshPlaceIds) state.freshPlaceIds = new Set();
  if (!state.photoSelected) state.photoSelected = new Set();
  if (state.photoSelecting == null) state.photoSelecting = false;
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
  if (!state.userId) {
    try {
      state.userId = await getUserId();
    } catch {
      state.userId = null;
    }
  }

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
    ${tripCompanionsMarkup(vacation)}
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

  let ignoreSelectPop = false;
  let exitSelectAfterOverlayPop = false;
  let leaveAfterSelectPop = false;

  appEl.querySelector('[data-action="back"]').addEventListener("click", () => {
    if (history.state?.vacrecapPhotoSelect) {
      leaveAfterSelectPop = true;
      clearPhotoSelect();
      history.back();
      return;
    }
    clearTripUiState(id);
    leaveTripToOverview();
  });

  const onTripPop = () => {
    if (ignoreSelectPop) {
      ignoreSelectPop = false;
      return;
    }
    if (exitSelectAfterOverlayPop) {
      exitSelectAfterOverlayPop = false;
      clearPhotoSelect();
      if (history.state?.vacrecapPhotoSelect) {
        ignoreSelectPop = true;
        history.back();
      }
      void paintCachedDays([state.activeDay]);
      return;
    }
    if (leaveAfterSelectPop) {
      leaveAfterSelectPop = false;
      clearTripUiState(id);
      leaveTripToOverview();
      return;
    }
    if (!state.photoSelecting) return;
    if (history.state?.vacrecapPhotoSelect || history.state?.vacrecapOverlay) return;
    if (hasActiveOverlay()) return;
    void exitPhotoSelect({ fromPop: true });
  };

  const onTripKey = (event) => {
    if (event.key !== "Escape") return;
    const moveOpen = Boolean(document.querySelector('[data-testid="photo-move-sheet"]'));
    if (!moveOpen && !state.photoSelecting) return;
    event.preventDefault();
    if (moveOpen) {
      exitSelectAfterOverlayPop = Boolean(state.photoSelecting);
      const closed = requestOverlayDismiss();
      if (!closed || (exitSelectAfterOverlayPop && !history.state?.vacrecapOverlay)) {
        exitSelectAfterOverlayPop = false;
        if (state.photoSelecting) void exitPhotoSelect();
      }
      return;
    }
    void exitPhotoSelect();
  };

  if (appEl?.dataset?.appRenderGen === mountGen) {
    window.addEventListener("popstate", onTripPop);
    window.addEventListener("keydown", onTripKey);
    appEl._screenCleanup = () => {
      window.removeEventListener("popstate", onTripPop);
      window.removeEventListener("keydown", onTripKey);
    };
  }

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
  syncDayEdges({ active: false });
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

  const dayErrorHtml = `
        <div class="trip-empty" data-testid="day-load-error">
          <p class="trip-empty__title">Der Tag konnte nicht geladen werden.</p>
          <p class="trip-empty__hint">Bitte erneut versuchen.</p>
          <button type="button" class="notes-more" data-action="retry-day-load">Erneut laden</button>
        </div>`;

  const daySkeletonHtml = `
        <div class="place-list-wrap" data-testid="day-skeleton" aria-busy="true">
          <ul class="place-list" data-testid="place-list">
            <li><article class="oc oc--skeleton" aria-hidden="true"><div class="pinb"></div><div class="oc__body"><h4 class="oc__title">&nbsp;</h4><div class="oc__meta">&nbsp;</div></div></article></li>
            <li><article class="oc oc--skeleton" aria-hidden="true"><div class="pinb"></div><div class="oc__body"><h4 class="oc__title">&nbsp;</h4><div class="oc__meta">&nbsp;</div></div></article></li>
          </ul>
        </div>`;

  let warmHtml = new Map();
  let warmPlaces = null;
  let dayCache = new Map();
  let cacheEpoch = 0;
  const thumbPool = {};

  function stripTestIds(html) {
    return String(html || "").replace(/\sdata-testid="[^"]*"/g, "");
  }

  function syncMediaCounts(item) {
    const media = item.media || [];
    item.photos = media.filter((entry) => entry.type !== "video" && (entry.uploadStatus || "uploaded") === "uploaded").length;
    item.videos = media.filter((entry) => entry.type === "video").length;
  }

  function findCachedMedia(mediaId) {
    for (const bundle of dayCache.values()) {
      for (const item of bundle.items || []) {
        const hit = item.media?.find((entry) => entry.id === mediaId);
        if (hit) return hit;
      }
    }
    return null;
  }

  function applyPlacement(mediaList, placeId, day) {
    const ids = new Set(mediaList.map((entry) => entry.id));
    for (const bundle of dayCache.values()) {
      for (const item of bundle.items || []) {
        if (!item.media?.length) continue;
        const next = item.media.filter((entry) => !ids.has(entry.id));
        if (next.length !== item.media.length) {
          item.media = next;
          syncMediaCounts(item);
        }
      }
    }
    const bundle = dayCache.get(day);
    const item = bundle?.items?.find((entry) => entry.place.id === placeId);
    if (!item) return;
    for (const entry of mediaList) {
      entry.placeId = placeId;
      entry.day = day;
      if (!item.media.some((existing) => existing.id === entry.id)) item.media.push(entry);
    }
    item.media.sort((a, b) => a.ts - b.ts);
    syncMediaCounts(item);
  }

  async function thumbUrlsFor(media, ids) {
    const map = {};
    const missing = new Set();
    for (const mediaId of ids) {
      if (thumbPool[mediaId]) map[mediaId] = thumbPool[mediaId];
      else missing.add(mediaId);
    }
    if (missing.size) {
      const extra = await resolveThumbUrlMap(media, missing);
      Object.assign(thumbPool, extra);
      Object.assign(map, extra);
    }
    return map;
  }

  async function buildDayHtml(dayIso, knownPlaces, { fresh = false, selection = false } = {}) {
    const epochAtStart = cacheEpoch;
    let bundle = !fresh && dayCache.has(dayIso) ? dayCache.get(dayIso) : null;
    if (!bundle) {
      const items = await loadDayPlacesEnriched(id, dayIso, knownPlaces);
      const freeNotes = await getFreeNotesForDay(id, dayIso);
      if (cacheEpoch === epochAtStart) {
        bundle = { items, freeNotes };
        dayCache.set(dayIso, bundle);
      } else if (dayCache.has(dayIso)) {
        bundle = dayCache.get(dayIso);
      } else {
        bundle = { items, freeNotes };
      }
    }
    const stale = cacheEpoch !== epochAtStart;
    const active = dayIso === state.activeDay;
    const selectedId = await ensureSelectedForDay(bundle.items, dayIso);
    const selecting = Boolean(selection) && active && state.photoSelecting;
    const allMedia = bundle.items.flatMap((entry) => entry.media);
    const visibleIds = visibleThumbMediaIds(bundle.items, selectedId);
    if (selecting) {
      const card = bundle.items.find((entry) => entry.place.id === selectedId);
      for (const entry of card?.media || []) {
        if ((entry.uploadStatus || "uploaded") === "uploaded") visibleIds.add(entry.id);
      }
    }
    const thumbUrls = await thumbUrlsFor(allMedia, visibleIds);
    const canEditMedia = canEditTripMedia(await getMyTripRole(id));
    let placeHtml = emptyDayHtml;
    if (bundle.items.length) {
      const { listHtml, mediaErrorHtml, selectBarHtml } = renderPlaceListHtml(bundle.items, {
        selectedId,
        notesExpanded: active ? state.notesExpanded : new Set(),
        thumbUrls,
        canEditMedia,
        freshPlaceIds: state.freshPlaceIds,
        photoSelect: {
          active: selecting,
          selectedIds: state.photoSelected || new Set(),
          userId: state.userId,
        },
      });
      placeHtml = wrapPlaceList(listHtml, mediaErrorHtml, selectBarHtml || "");
    }
    return {
      html: withFreeNotesHtml(placeHtml, bundle.freeNotes, {
        expanded: active && state.freeNotesExpanded,
        replaceEmpty: bundle.items.length === 0,
      }),
      thumbUrls,
      stale,
    };
  }

  function clearWarm() {
    for (const built of warmHtml.values()) revokeThumbUrls(built?.thumbUrls);
    warmHtml = new Map();
    warmPlaces = null;
    dayCache = new Map();
    for (const key of Object.keys(thumbPool)) delete thumbPool[key];
  }

  function syncNeighborHold() {
    const idx = days.indexOf(state.activeDay);
    const prev = idx > 0 ? days[idx - 1] : null;
    const next = idx < days.length - 1 ? days[idx + 1] : null;
    neighborHold.prev = prev && warmHtml.get(prev)?.html ? stripTestIds(warmHtml.get(prev).html) : "";
    neighborHold.next = next && warmHtml.get(next)?.html ? stripTestIds(warmHtml.get(next).html) : "";
  }

  async function paintCachedDays(dayList) {
    const unique = [...new Set(dayList.filter(Boolean))];
    for (const day of unique) {
      if (!dayCache.has(day)) continue;
      const plain = await buildDayHtml(day, warmPlaces, { selection: false });
      if (!plain.stale) warmHtml.set(day, plain);
    }
    syncNeighborHold();
    const active = state.photoSelecting
      ? await buildDayHtml(state.activeDay, warmPlaces, { selection: true })
      : warmHtml.get(state.activeDay);
    if (!active?.html || active.stale) return;
    contentEl.dataset.photoSelecting = state.photoSelecting ? "1" : "0";
    queuePaint(active, state.listRefreshToken, { keepScroll: true });
  }

  function clearPhotoSelect() {
    state.photoSelecting = false;
    state.photoSelected = new Set();
    if (contentEl?.isConnected) contentEl.dataset.photoSelecting = "0";
  }

  function dropPhotoSelectEntry() {
    if (!history.state?.vacrecapPhotoSelect) return;
    ignoreSelectPop = true;
    history.back();
  }

  async function ensureDayBundle(day) {
    if (!day || dayCache.has(day)) return;
    if (!warmPlaces) warmPlaces = await getPlacesForVacation(id);
    await buildDayHtml(day, warmPlaces, { fresh: true, selection: false });
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
        try {
          built = await buildDayHtml(day, warmPlaces);
        } catch {
          if (token !== state.listRefreshToken || !contentEl.isConnected) return;
          continue;
        }
        if (token !== state.listRefreshToken || !contentEl.isConnected) {
          revokeThumbUrls(built?.thumbUrls);
          return;
        }
        if (built?.stale) continue;
        warmHtml.set(day, built);
      }
      neighborHold[key] = stripTestIds(built.html);
    }
  }

  let pendingPaint = null;
  let paintTimer = 0;
  let scrolling = false;
  let scrollTimer = 0;

  function syncDayEdges({ active = true } = {}) {
    const idx = days.indexOf(state.activeDay);
    contentEl.dataset.canPrev = idx > 0 ? "1" : "0";
    contentEl.dataset.canNext = idx < days.length - 1 ? "1" : "0";
    if (active) contentEl.dataset.activeDay = state.activeDay;
  }

  function pageShows(html) {
    const current = contentEl.querySelector("[data-page='current']")?.innerHTML || "";
    if (!current || !html) return false;
    return stripTestIds(current) === stripTestIds(html);
  }

  function paintBlocked() {
    return contentEl.dataset.gesture === "1" || scrolling;
  }

  function paintDay(built, { keepScroll = false } = {}) {
    if (!contentEl.isConnected || !built?.html) return;
    contentEl.dataset.photoSelecting = state.photoSelecting ? "1" : "0";
    const previousThumbUrls = state.thumbUrls;
    state.thumbUrls = built.thumbUrls || {};
    syncDayEdges();
    setDaySwipePage(contentEl, built.html, { keepScroll });
    bindBrokenThumbs(contentEl);
    if (previousThumbUrls && previousThumbUrls !== state.thumbUrls) revokeThumbUrls(previousThumbUrls);
  }

  function flushPendingPaint() {
    if (!pendingPaint || !contentEl.isConnected) {
      if (!contentEl.isConnected) pendingPaint = null;
      return;
    }
    if (pendingPaint.token !== state.listRefreshToken) {
      pendingPaint = null;
      return;
    }
    if (paintBlocked()) return;
    const { built, keepScroll } = pendingPaint;
    pendingPaint = null;
    if (pageShows(built.html)) return;
    const page = contentEl.querySelector("[data-page='current']");
    paintDay(built, { keepScroll: keepScroll || (page?.scrollTop || 0) > 0 });
  }

  function armPaintFlush() {
    if (paintTimer) return;
    paintTimer = setInterval(() => {
      if (!contentEl.isConnected) {
        clearInterval(paintTimer);
        paintTimer = 0;
        pendingPaint = null;
        return;
      }
      flushPendingPaint();
      if (!pendingPaint) {
        clearInterval(paintTimer);
        paintTimer = 0;
      }
    }, 50);
  }

  function queuePaint(built, token, { keepScroll = false } = {}) {
    if (pageShows(built.html)) {
      syncDayEdges();
      if (pendingPaint?.token === token) pendingPaint = null;
      return;
    }
    if (!paintBlocked()) {
      pendingPaint = null;
      const page = contentEl.querySelector("[data-page='current']");
      paintDay(built, { keepScroll: keepScroll || (page?.scrollTop || 0) > 0 });
      return;
    }
    pendingPaint = { built, token, keepScroll };
    armPaintFlush();
  }

  contentEl.addEventListener(
    "scroll",
    (e) => {
      if (e.target?.dataset?.page !== "current") return;
      scrolling = true;
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        scrolling = false;
        flushPendingPaint();
      }, 160);
    },
    true
  );

  function paintCachedOrSkeleton(dayIso) {
    syncDayEdges();
    const cached = warmHtml.get(dayIso);
    if (cached?.html) {
      paintDay(cached);
      return;
    }
    const previousThumbUrls = state.thumbUrls;
    state.thumbUrls = {};
    setDaySwipePage(contentEl, daySkeletonHtml);
    if (previousThumbUrls && previousThumbUrls !== state.thumbUrls) revokeThumbUrls(previousThumbUrls);
  }

  function showDayLoadError() {
    const page = contentEl.querySelector("[data-page='current']");
    const skeleton = page?.querySelector("[data-testid='day-skeleton']");
    const loaded = page?.querySelector(
      "[data-testid='place-list'] .oc:not(.oc--skeleton), [data-testid='trip-empty'], [data-testid='free-notes']"
    );
    if (!skeleton && loaded) return;
    pendingPaint = null;
    syncDayEdges();
    setDaySwipePage(contentEl, dayErrorHtml);
  }

  async function refreshDayList({ reuse = false } = {}) {
    const token = ++state.listRefreshToken;
    try {
      await maybeSoftOnOpen();
      if (token !== state.listRefreshToken) return;
      if (!reuse) clearWarm();
      if (!warmPlaces) warmPlaces = await getPlacesForVacation(id);
      if (token !== state.listRefreshToken) return;
      let built = reuse ? warmHtml.get(state.activeDay) : null;
      if (!built) {
        built = await buildDayHtml(state.activeDay, warmPlaces, { selection: false });
        if (token !== state.listRefreshToken) {
          revokeThumbUrls(built?.thumbUrls);
          return;
        }
        if (built?.stale) {
          built = await buildDayHtml(state.activeDay, warmPlaces, { selection: false });
        }
        if (!built?.stale) warmHtml.set(state.activeDay, built);
      }
      if (!contentEl.isConnected || !built?.html) return;
      const view = state.photoSelecting
        ? await buildDayHtml(state.activeDay, warmPlaces, { selection: true })
        : built;
      queuePaint(view?.html && !view.stale ? view : built, token, { keepScroll: reuse });
      persistSelection(id, state);
      if (token !== state.listRefreshToken || !contentEl.isConnected) return;
      void prefetchNeighbors(token);
    } catch {
      if (token !== state.listRefreshToken || !contentEl.isConnected) return;
      showDayLoadError();
    }
  }

  function setActiveDay(dayIso) {
    if (!days.includes(dayIso) || dayIso === state.activeDay) return;
    const selecting = state.photoSelecting;
    clearPhotoSelect();
    if (selecting) dropPhotoSelectEntry();
    state.activeDay = dayIso;
    persistSelection(id, state);
    renderChips();
    paintCachedOrSkeleton(dayIso);
    void refreshDayList({ reuse: true });
  }

  function shiftDay(direction) {
    const next = adjacentDay(vacation, state.activeDay, direction);
    if (next === state.activeDay) return;
    const selecting = state.photoSelecting;
    clearPhotoSelect();
    if (selecting) dropPhotoSelectEntry();
    state.activeDay = next;
    persistSelection(id, state);
    renderChips();
    syncDayEdges();
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
    const captureId = r?.place?.id;
    if (!captureId) return;
    void r?.renamed?.then((updated) => {
      if (!updated?.name || updated.id !== captureId) return;
      if (r.place?.id === captureId) {
        r.place.name = updated.name;
        r.place.title = updated.name;
      }
      if (r.toast?.title?.startsWith("Neue Karte")) {
        r.toast.title = `Neue Karte «${updated.name}»`;
      }
      const title = document.querySelector(
        `[data-testid="app-toast"][data-capture-id="${CSS.escape(captureId)}"] .toast__line--title`
      );
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
    const captureId = r.place?.id;
    if (toast.variant === "warn") {
      showWarnToast(toast.line, {
        title: toast.title,
        captureId,
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
        captureId,
        onUndo: () => {
          void undoNewCapture(r, redirect);
        },
      });
      return;
    }
    if (toast.line) showTwoLineToast(toast.title, toast.line, { captureId });
    else if (toast.title) showToast(toast.title, { captureId });
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

  function moveErrorText(err) {
    if (!navigator.onLine || err instanceof CloudOfflineError) {
      return "Du bist offline. Die Fotos bleiben am bisherigen Ort.";
    }
    if (err instanceof CloudNetworkError) {
      return "Die Fotos konnten nicht verschoben werden. Bitte Verbindung prüfen.";
    }
    return "Die Fotos konnten nicht verschoben werden. Bitte erneut versuchen.";
  }

  function chosenPhotos() {
    const ids = [...(state.photoSelected || [])];
    return ids.map((mediaId) => findCachedMedia(mediaId)).filter((media) => mediaOwnedBy(media, state.userId));
  }

  async function enterPhotoSelect({ mediaId = null, placeId = null } = {}) {
    if (placeId) {
      state.selectedByDay[state.activeDay] = placeId;
      persistSelection(id, state);
    }
    state.photoSelecting = true;
    if (!state.photoSelected) state.photoSelected = new Set();
    if (mediaId) state.photoSelected.add(mediaId);
    contentEl.dataset.photoSelecting = "1";
    if (!history.state?.vacrecapPhotoSelect) {
      history.pushState({ vacrecapPhotoSelect: true }, "");
    }
    await paintCachedDays([state.activeDay]);
  }

  async function exitPhotoSelect({ fromPop = false } = {}) {
    clearPhotoSelect();
    if (!fromPop) dropPhotoSelectEntry();
    await paintCachedDays([state.activeDay]);
  }

  async function onMoveSelectedPhotos() {
    if (state.moveBusy || !state.photoSelecting) return;
    const chosen = chosenPhotos();
    if (!chosen.length) {
      showWarnToast("Wähle mindestens ein eigenes Foto.");
      return;
    }
    state.moveBusy = true;
    try {
      if (!warmPlaces) warmPlaces = await getPlacesForVacation(id);
      const blockedPlaceId = chosen.every((media) => media.placeId === chosen[0].placeId) ? chosen[0].placeId : null;
      const place = await openPhotoMoveSheet({
        vacation,
        places: warmPlaces.filter((entry) => !entry.soft),
        initialDay: state.activeDay,
        blockedPlaceId,
      });
      if (!place || !contentEl.isConnected) return;
      const targetDay = place.day || place.dayDate;
      if (!targetDay || chosen.every((media) => media.placeId === place.id)) return;
      const previous = chosen.map((media) => ({ id: media.id, placeId: media.placeId, day: media.day }));
      const sourceDays = [...new Set(previous.map((snap) => snap.day).filter(Boolean))];
      await movePhotosToPlace(chosen, place);
      cacheEpoch += 1;
      await ensureDayBundle(targetDay);
      applyPlacement(chosen, place.id, targetDay);
      clearPhotoSelect();
      dropPhotoSelectEntry();
      await paintCachedDays([...sourceDays, targetDay, state.activeDay]);
      const count = chosen.length;
      showToast(count === 1 ? "1 Foto verschoben" : `${count} Fotos verschoben`, {
        undoLabel: "Rückgängig",
        onUndo: () => {
          void undoPhotoMove(chosen, previous);
        },
      });
    } catch (err) {
      if (err?.placementRolledBack === false) {
        cacheEpoch += 1;
        await refreshDayList();
      }
      showWarnToast(moveErrorText(err));
    } finally {
      state.moveBusy = false;
    }
  }

  async function undoPhotoMove(chosen, previous) {
    if (state.moveBusy) return;
    state.moveBusy = true;
    const destinationDays = [...new Set(chosen.map((media) => media.day).filter(Boolean))];
    try {
      await restorePhotoPlacement(previous);
      cacheEpoch += 1;
      const groups = new Map();
      for (const snap of previous) {
        const key = `${snap.day}|${snap.placeId}`;
        if (!groups.has(key)) groups.set(key, { day: snap.day, placeId: snap.placeId, media: [] });
        const media = chosen.find((entry) => entry.id === snap.id);
        if (media) groups.get(key).media.push(media);
      }
      for (const group of groups.values()) {
        await ensureDayBundle(group.day);
        applyPlacement(group.media, group.placeId, group.day);
      }
      await paintCachedDays(
        [...groups.values()].map((group) => group.day).concat(destinationDays, state.activeDay)
      );
      showToast("Wieder am bisherigen Ort.");
    } catch {
      cacheEpoch += 1;
      await refreshDayList();
      showWarnToast("Rückgängig ist fehlgeschlagen. Bitte erneut versuchen.");
    } finally {
      state.moveBusy = false;
    }
  }

  let suppressTileClick = false;
  const photoPress = { timer: 0, x: 0, y: 0, id: null, placeId: null };

  function clearPhotoPress() {
    if (photoPress.timer) clearTimeout(photoPress.timer);
    photoPress.timer = 0;
  }

  contentEl.addEventListener("pointerdown", (event) => {
    if (event.button > 0) return;
    const tile = event.target.closest(".tile[data-media-id], .th[data-media-id]");
    if (!tile) return;
    clearPhotoPress();
    photoPress.x = event.clientX;
    photoPress.y = event.clientY;
    photoPress.id = tile.dataset.mediaId;
    photoPress.placeId = tile.closest("[data-place-id]")?.dataset.placeId || null;
    photoPress.timer = setTimeout(() => {
      photoPress.timer = 0;
      suppressTileClick = true;
      setTimeout(() => {
        suppressTileClick = false;
      }, 700);
      const media = findCachedMedia(photoPress.id);
      const own = mediaOwnedBy(media, state.userId);
      if (!own) showWarnToast("Nur eigene Fotos kannst du verschieben.");
      void enterPhotoSelect({ mediaId: own ? photoPress.id : null, placeId: photoPress.placeId });
    }, 550);
  });
  contentEl.addEventListener("pointermove", (event) => {
    if (!photoPress.timer) return;
    if (Math.hypot(event.clientX - photoPress.x, event.clientY - photoPress.y) > 12) clearPhotoPress();
  });
  for (const type of ["pointerup", "pointercancel"]) {
    contentEl.addEventListener(type, clearPhotoPress);
  }
  contentEl.addEventListener("contextmenu", (event) => {
    if (event.target.closest(".tile[data-media-id], .th[data-media-id]")) event.preventDefault();
  });

  contentEl.addEventListener("click", async (e) => {
    if (suppressTileClick) {
      suppressTileClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (e.target.closest("[data-action='photo-select-exit']")) {
      e.preventDefault();
      await exitPhotoSelect();
      return;
    }
    if (e.target.closest("[data-action='photo-select-start']")) {
      e.preventDefault();
      const host = e.target.closest(".oc[data-place-id]");
      await enterPhotoSelect({ placeId: host?.dataset.placeId || null });
      return;
    }
    if (e.target.closest("[data-action='photo-move']")) {
      e.preventDefault();
      await onMoveSelectedPhotos();
      return;
    }
    if (state.photoSelecting) {
      const tile = e.target.closest(".tile[data-media-id], .th[data-media-id]");
      if (tile) {
        e.preventDefault();
        if (tile.dataset.own !== "1") {
          showWarnToast("Nur eigene Fotos kannst du verschieben.");
          return;
        }
        if (!state.photoSelected) state.photoSelected = new Set();
        if (state.photoSelected.has(tile.dataset.mediaId)) state.photoSelected.delete(tile.dataset.mediaId);
        else state.photoSelected.add(tile.dataset.mediaId);
        await paintCachedDays([state.activeDay]);
      }
      return;
    }

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
      const role = await getMyTripRole(id);
      const canDelete = canEditTripMedia(role);
      openMediaViewer(viewable, tile.dataset.mediaId, {
        canDelete,
        canEditCaption: (entry) => canCaptionMedia(entry, role, state.userId),
        onChanged: () => refreshDayList(),
      });
      return;
    }

    const editCaption = e.target.closest("[data-action='edit-photo-caption']");
    if (editCaption) {
      e.preventDefault();
      if (state.captionBusy) return;
      state.captionBusy = true;
      try {
        const media = findCachedMedia(editCaption.dataset.mediaId);
        const role = await getMyTripRole(id);
        if (!media || !canCaptionMedia(media, role, state.userId)) return;
        await openPhotoCaptionSheet({
          media,
          onSaved: () => refreshDayList(),
        });
      } finally {
        state.captionBusy = false;
      }
      return;
    }

    const openCaption = e.target.closest("[data-action='open-photo-caption']");
    if (openCaption) {
      e.preventDefault();
      const placeId = e.target.closest(".oc[data-place-id]")?.dataset.placeId;
      const mediaId = openCaption.dataset.mediaId;
      if (!placeId || !mediaId) return;
      const items = await loadDayPlacesEnriched(id, state.activeDay);
      const item = items.find((entry) => entry.place.id === placeId);
      if (!item) return;
      const viewable = filterViewableMedia(item.media);
      const role = await getMyTripRole(id);
      openMediaViewer(viewable, mediaId, {
        canDelete: canEditTripMedia(role),
        canEditCaption: (entry) => canCaptionMedia(entry, role, state.userId),
        onChanged: () => refreshDayList(),
      });
      return;
    }

    const retryMedia = e.target.closest('[data-action="retry-media-load"]');
    if (retryMedia) {
      await refreshDayList();
      return;
    }

    const retryDay = e.target.closest('[data-action="retry-day-load"]');
    if (retryDay) {
      paintCachedOrSkeleton(state.activeDay);
      void refreshDayList({ reuse: true });
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

