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
import { coordinatesAreUsable, fallbackPlaceName, formatTimeFromTs, getCapturePosition } from "./geo.js";
import { placeTsForCapture } from "./capture-time.js";
import { readPhotoTakenAt } from "./exif-taken-at.js";
import { rememberPlaceFromGps, trySoftPointOnOpen } from "./place-service.js";
import { findPlaceWithinMeters, newestHardPlace } from "./places.js";
import { leaveTripToOverview, navigate } from "./router.js";
import { getRememberCaptureLocation, getRememberLocationOnOpen, getSamePlaceRadiusM } from "./settings-store.js";
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
import {
  cancelDaySwipeSettle,
  DAY_SWIPE_MS,
  daySwipeEase,
  installDaySwipe,
  setDaySwipeNeighbor,
  setDaySwipePage,
} from "./day-swipe.js";
import {
  dropTripPlaceMemory,
  filterViewableMedia,
  loadDayPlacesEnriched,
  renderPlaceListHtml,
  resolveThumbUrlMap,
  revokeThumbUrls,
  visibleThumbMediaIds,
  withFreeNotesHtml,
  wrapPlaceList,
} from "./ui-place-list.js";
import { bindCircleTips, shareContext } from "./member-marks.js";
import { canAddOwn, canEditItem, getConfirmedTripRole } from "./trip-role.js";
import { loadTripPeople } from "./trip-people.js";
import { takeStaleNotice } from "./save-conflict.js";
import { loadRecapEntry, recapEntryCardHtml } from "./ui-recap-video.js";
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
import { applyMediaRanks, compareMediaOrder } from "./media-order.js";
import { escapeHtml, todayIso } from "./utils.js";

const CHIP_ARROW_PREV = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 6l-6 6 6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHIP_ARROW_NEXT = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M10 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const tripUiState = new Map();

export function clearTripUiState(vacationId) {
  const state = tripUiState.get(vacationId);
  if (state?.thumbUrls) revokeThumbUrls(state.thumbUrls);
  if (state?.warmHtml) {
    for (const built of state.warmHtml.values()) revokeThumbUrls(built?.thumbUrls);
  }
  tripUiState.delete(vacationId);
}

export function noteFreshPlace(vacationId, placeId) {
  const state = tripUiState.get(vacationId);
  if (!state?.freshPlaceIds || !placeId) return;
  state.freshPlaceIds.add(placeId);
}

export function forgetFreshPlace(vacationId, placeId) {
  tripUiState.get(vacationId)?.freshPlaceIds?.delete(placeId);
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
  const days = vacationDays(vacation);
  let state = tripUiState.get(id);
  if (!state) {
    const saved = await loadTripSelection(id);
    const savedDay = saved?.activeDay;
    state = {
      activeDay: savedDay && days.includes(savedDay) ? savedDay : defaultActiveDay(vacation),
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
      dayBundles: new Map(),
      warmHtml: new Map(),
      warmPlaces: null,
      thumbPool: {},
      dayCacheEpoch: 0,
    };
    tripUiState.set(id, state);
  }
  if (!state.dayBundles) state.dayBundles = new Map();
  if (!state.warmHtml) state.warmHtml = new Map();
  if (!state.thumbPool) state.thumbPool = Object.create(null);
  if (state.dayCacheEpoch == null) state.dayCacheEpoch = 0;
  if (!days.includes(state.activeDay)) state.activeDay = defaultActiveDay(vacation);
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
  const ownDaySave = window.vacrecapOwnDaySave === true;
  window.vacrecapOwnDaySave = false;
  const vacation = await getVacation(id);
  if (appEl?.dataset?.appRenderGen !== mountGen) return;
  if (!vacation) {
    navigate({ name: "urlaube" });
    return;
  }

  const days = vacationDays(vacation);
  const [state, recapEntry, roleInfo, people] = await Promise.all([
    getState(id, vacation),
    loadRecapEntry(id),
    getConfirmedTripRole(id),
    loadTripPeople(id, { refresh: true }),
  ]);
  if (!state.userId) {
    try {
      state.userId = await getUserId();
    } catch {
      state.userId = null;
    }
  }
  const share = shareContext(roleInfo.role, state.userId, people);
  const roleBanner = share.viewer
    ? `<div class="fg-role" data-testid="role-banner"><span aria-hidden="true">ⓘ</span><span>Du bist <b>Beitragender</b>. Eigenes hinzufügen und ändern, Fremdes nur ansehen.</span></div>`
    : "";

  if (appEl?.dataset?.appRenderGen !== mountGen) return;

  const sameTrip = appEl.dataset.vacationId === id;
  const keptDayScroll = sameTrip ? appEl.querySelector("[data-page='current']")?.scrollTop || 0 : 0;
  const keptChipScroll = sameTrip ? appEl.querySelector("[data-role='chips']")?.scrollLeft || 0 : 0;

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
    ${roleBanner}
    <div class="day-nav">
      <button type="button" class="day-chips-arrow day-chips-arrow--prev" data-action="chips-prev" data-testid="day-chips-prev" aria-label="Frühere Tage" hidden>${CHIP_ARROW_PREV}</button>
      <div class="day-chips-wrap">
        <div class="day-chip-mark" data-testid="day-chip-mark" aria-hidden="true"></div>
        <div class="day-chips" data-role="chips" role="tablist"></div>
      </div>
      <button type="button" class="day-chips-arrow day-chips-arrow--next" data-action="chips-next" data-testid="day-chips-next" aria-label="Spätere Tage" hidden>${CHIP_ARROW_NEXT}</button>
    </div>
    <main class="trip-content trip-content--places" data-role="day-content" data-testid="trip-content"></main>
    <input type="file" accept="image/*" capture="environment" hidden data-role="capture-photo-input" data-testid="capture-photo-input" />
    <input type="file" accept="video/*" capture="environment" hidden data-role="capture-video-input" data-testid="capture-video-input" />
    <input type="file" accept="image/*" multiple hidden data-role="gallery-input" data-testid="gallery-input" />
    <div data-role="footer-mount"></div>
  `;

  bindCircleTips(appEl);
  const staleNotice = takeStaleNotice(id);
  if (staleNotice?.line) showToast(staleNotice.line);

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
  const pageSnaps = new WeakMap();
  const mountedNeighborHtml = new WeakMap();
  const dayDataSeen = new Map();
  let chipFollowDay = null;
  let chipScrollToken = 0;
  let chipPhase = "idle";
  let chipOriginScroll = 0;
  let chipMarkBox = null;
  let chipDragIso = "";
  let chipDragBase = 0;
  installDaySwipe(contentEl, (dir) => shiftDay(dir), {
    onLock: () => {
      chipOriginScroll = chipsEl.scrollLeft;
      if (chipPhase === "anim") {
        chipScrollToken += 1;
        chipFollowDay = null;
      }
      prepareNeighborPages();
      restorePageActions(contentEl.querySelector("[data-page='prev']"));
      restorePageActions(contentEl.querySelector("[data-page='next']"));
    },
    onDrag: (info) => onChipDrag(info),
    onCancel: () => onChipCancel(),
    onRest: () => {
      holdPageActions(contentEl.querySelector("[data-page='prev']"));
      holdPageActions(contentEl.querySelector("[data-page='next']"));
      prepareNeighborPages();
    },
    beforeSwap: () => snapshotLeavingPage(),
    afterSwap: () => restoreArrivingPage(),
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
        const dateLine = dayChipDateLine(iso);
        return `
        <button type="button" role="tab" aria-selected="${active}"
          class="day-chip${active ? " day-chip--active" : ""}" data-day="${iso}">
          <span class="day-chip__plate" aria-hidden="true"></span>
          <span class="day-chip__date">${dateLine}</span>
          <span class="day-chip__role">${role}</span>
          <span class="day-chip__ink" aria-hidden="true">
            <span class="day-chip__date">${dateLine}</span>
            <span class="day-chip__role">${role}</span>
          </span>
          <span class="day-chip__ghost" aria-hidden="true">
            <span class="day-chip__date">${dateLine}</span>
            <span class="day-chip__role">${role}</span>
          </span>
        </button>`;
      })
      .join("");
  }

  function markEl() {
    return chipsEl.parentElement?.querySelector("[data-testid='day-chip-mark']") || null;
  }

  function chipBox(iso) {
    const chip = chipsEl.querySelector(`[data-day="${iso}"]`);
    if (!chip) return null;
    return {
      left: chip.offsetLeft,
      top: chip.offsetTop,
      width: chip.offsetWidth,
      height: chip.offsetHeight,
    };
  }

  function lerpBox(a, b, t) {
    return {
      left: a.left + (b.left - a.left) * t,
      top: a.top + (b.top - a.top) * t,
      width: a.width + (b.width - a.width) * t,
      height: a.height + (b.height - a.height) * t,
    };
  }

  function placeMark(box) {
    const el = markEl();
    if (!el || !box) return;
    chipMarkBox = box;
    const host = el.parentElement.getBoundingClientRect();
    const scroller = chipsEl.getBoundingClientRect();
    let x = scroller.left - host.left + box.left - chipsEl.scrollLeft;
    const y = scroller.top - host.top + box.top - chipsEl.scrollTop;
    const maxX = Math.max(0, host.width - box.width);
    if (x < 0) x = 0;
    else if (x > maxX) x = maxX;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  function clearChipTint() {
    for (const btn of chipsEl.querySelectorAll(".day-chip")) {
      btn.style.background = "";
      btn.style.borderColor = "";
      btn.style.boxShadow = "";
      const ghost = btn.querySelector(".day-chip__ghost");
      const ink = btn.querySelector(".day-chip__ink");
      if (ghost) ghost.style.clipPath = "";
      if (ink) {
        ink.style.clipPath = "";
        ink.style.maskImage = "";
        ink.style.webkitMaskImage = "";
      }
    }
  }

  function punchClip(width, height, holeL, holeR) {
    if (holeR - holeL < 0.5) return "";
    return `polygon(evenodd, 0px 0px, ${width}px 0px, ${width}px ${height}px, 0px ${height}px, 0px 0px, ${holeL}px 0px, ${holeL}px ${height}px, ${holeR}px ${height}px, ${holeR}px 0px, ${holeL}px 0px)`;
  }

  function markContentBox(box) {
    const host = markEl()?.parentElement?.getBoundingClientRect();
    const scroller = chipsEl.getBoundingClientRect();
    if (!host) return { left: box.left, width: box.width };
    let x = scroller.left - host.left + box.left - chipsEl.scrollLeft;
    const maxX = Math.max(0, host.width - box.width);
    if (x < 0) x = 0;
    else if (x > maxX) x = maxX;
    const left = chipsEl.scrollLeft + x - (scroller.left - host.left);
    return { left, width: box.width };
  }

  function applyMarkTint(box) {
    if (!box) return;
    const placed = markContentBox(box);
    for (const btn of chipsEl.querySelectorAll(".day-chip")) {
      const ghost = btn.querySelector(".day-chip__ghost");
      const ink = btn.querySelector(".day-chip__ink");
      const left = btn.offsetLeft;
      const width = btn.offsetWidth || 1;
      const height = btn.offsetHeight || 1;
      const overlapL = placed.left - left;
      const overlapR = overlapL + placed.width;
      const clipL = Math.max(0, overlapL);
      const clipR = Math.max(0, width - overlapR);
      if (ghost) {
        ghost.style.clipPath =
          clipL + clipR >= width - 0.5 ? "inset(50%)" : `inset(0px ${clipR}px 0px ${clipL}px)`;
      }
      if (ink) {
        const holeR = width - clipR;
        const mask = `linear-gradient(90deg, #000 0px, #000 ${clipL}px, transparent ${clipL}px, transparent ${holeR}px, #000 ${holeR}px, #000 ${width}px)`;
        ink.style.maskImage = mask;
        ink.style.webkitMaskImage = mask;
      }
    }
  }

  function setChipFollow(on) {
    chipsEl.classList.toggle("day-chips--follow", on);
    chipsEl.parentElement?.classList.toggle("day-chips-wrap--follow", on);
    chipsEl.style.zIndex = on ? "auto" : "";
    const mark = markEl();
    if (mark) {
      mark.style.zIndex = on ? "2" : "";
      mark.style.opacity = on ? "1" : "";
    }
  }

  function endFollowVisual() {
    chipPhase = "idle";
    setChipFollow(false);
    clearChipTint();
    syncChipArrows();
  }

  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
    const startBox = chipMarkBox || chipBox(dayIso);
    const endBox = chipBox(dayIso);
    const markNeedsMove = Boolean(
      startBox && endBox && (Math.abs(startBox.left - endBox.left) > 0.5 || Math.abs(startBox.width - endBox.width) > 0.5)
    );
    const clearFollow = () => {
      if (token === chipScrollToken && chipFollowDay === dayIso) chipFollowDay = null;
    };
    const finishVisual = () => {
      if (endBox) placeMark(endBox);
      if (chipPhase !== "idle") endFollowVisual();
    };
    if (duration <= 0 || (Math.abs(target - start) <= CHIP_CENTER_EPS && !markNeedsMove)) {
      chipsEl.scrollLeft = target;
      clearFollow();
      finishVisual();
      return;
    }
    chipPhase = "anim";
    setChipFollow(true);
    const t0 = performance.now();
    const step = (now) => {
      if (token !== chipScrollToken) return;
      const p = Math.min(1, (now - t0) / duration);
      const e = p >= 1 ? 1 : daySwipeEase(p);
      chipsEl.scrollLeft = p >= 1 ? target : start + (target - start) * e;
      if (startBox && endBox) {
        const box = lerpBox(startBox, endBox, e);
        placeMark(box);
        applyMarkTint(box);
      }
      if (p < 1) requestAnimationFrame(step);
      else {
        clearFollow();
        finishVisual();
      }
    };
    requestAnimationFrame(step);
  }

  function animateChipReturn() {
    const token = ++chipScrollToken;
    chipFollowDay = null;
    const startScroll = chipsEl.scrollLeft;
    const endScroll = chipOriginScroll;
    const startBox = chipMarkBox || chipBox(state.activeDay);
    const endBox = chipBox(state.activeDay);
    const duration = prefersReducedMotion() ? 0 : 280;
    if (!endBox || duration <= 0) {
      chipsEl.scrollLeft = endScroll;
      if (endBox) placeMark(endBox);
      endFollowVisual();
      return;
    }
    chipPhase = "anim";
    setChipFollow(true);
    const t0 = performance.now();
    const step = (now) => {
      if (token !== chipScrollToken) return;
      const p = Math.min(1, (now - t0) / duration);
      const e = p >= 1 ? 1 : 1 - (1 - p) ** 3;
      chipsEl.scrollLeft = p >= 1 ? endScroll : startScroll + (endScroll - startScroll) * e;
      const box = lerpBox(startBox, endBox, e);
      placeMark(box);
      applyMarkTint(box);
      if (p < 1) requestAnimationFrame(step);
      else endFollowVisual();
    };
    requestAnimationFrame(step);
  }

  function onChipDrag({ ratio }) {
    if (!Number.isFinite(ratio)) return;
    if (chipPhase === "anim") {
      chipScrollToken += 1;
      chipFollowDay = null;
    }
    if (chipPhase !== "drag") {
      chipPhase = "drag";
      setChipFollow(true);
      chipDragIso = "";
    }
    const from = chipBox(state.activeDay);
    if (!from) return;
    const dir = ratio < 0 ? 1 : ratio > 0 ? -1 : 0;
    if (!dir) {
      chipDragIso = "";
      if (chipsEl.scrollLeft !== chipOriginScroll) chipsEl.scrollLeft = chipOriginScroll;
      placeMark(from);
      applyMarkTint(from);
      return;
    }
    const nextIso = adjacentDay(vacation, state.activeDay, dir);
    const to = nextIso !== state.activeDay ? chipBox(nextIso) : null;
    if (!to) {
      if (chipsEl.scrollLeft !== chipOriginScroll) chipsEl.scrollLeft = chipOriginScroll;
      const cap = from.width * 0.28;
      const shift = Math.max(-cap, Math.min(cap, -ratio * (from.width + 8)));
      const box = { ...from, left: from.left + shift };
      placeMark(box);
      applyMarkTint(box);
      return;
    }
    const fromEl = chipsEl.querySelector(`[data-day="${state.activeDay}"]`);
    const toEl = chipsEl.querySelector(`[data-day="${nextIso}"]`);
    if (fromEl && toEl && chipDragIso !== nextIso) {
      chipDragIso = nextIso;
      chipsEl.scrollLeft = revealChipScroll(fromEl, toEl);
      chipDragBase = chipsEl.scrollLeft;
    }
    const t = Math.max(0, Math.min(1, Math.abs(ratio)));
    const box = lerpBox(from, to, t);
    const dest = chipScrollTarget(chipsEl, toEl);
    const base = chipDragIso === nextIso ? chipDragBase : chipsEl.scrollLeft;
    chipsEl.scrollLeft = base + (dest - base) * t;
    placeMark(box);
    applyMarkTint(box);
  }

  function revealChipScroll(fromEl, toEl) {
    const view = chipsEl.clientWidth;
    const max = Math.max(0, chipsEl.scrollWidth - view);
    const left = Math.min(fromEl.offsetLeft, toEl.offsetLeft);
    const right = Math.max(fromEl.offsetLeft + fromEl.offsetWidth, toEl.offsetLeft + toEl.offsetWidth);
    const cur = chipsEl.scrollLeft;
    if (right - left <= view + 1) {
      if (cur <= left + 1 && cur + view >= right - 1) return cur;
      if (left < cur) return Math.max(0, left);
      return Math.max(0, Math.min(max, right - view));
    }
    const targetRight = toEl.offsetLeft + toEl.offsetWidth;
    if (cur <= toEl.offsetLeft + 1 && cur + view >= targetRight - 1) return cur;
    if (targetRight > cur + view) return Math.max(0, Math.min(max, targetRight - view));
    return Math.max(0, Math.min(max, toEl.offsetLeft));
  }

  function onChipCancel() {
    if (chipPhase !== "drag") return;
    animateChipReturn();
  }

  function previewChipShift(dir) {
    const next = adjacentDay(vacation, state.activeDay, dir);
    if (next === state.activeDay) return;
    if (!chipsEl.querySelector(`[data-day="${next}"]`)) return;
    applyChipActive(next);
    scrollChipWithPage(next, prefersReducedMotion() ? 0 : DAY_SWIPE_MS);
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
      if (chipPhase !== "idle") endFollowVisual();
    } else {
      applyChipActive(state.activeDay);
    }
    syncChipArrows();
    if (chipFollowDay && chipFollowDay !== state.activeDay) {
      chipScrollToken += 1;
      chipFollowDay = null;
      if (chipPhase !== "idle") endFollowVisual();
    }
    const chip = chipsEl.querySelector(`[data-day="${state.activeDay}"]`);
    if (!chip || chipFollowDay === state.activeDay) return;
    if (sameTrip) {
      if (chipsEl.scrollLeft !== keptChipScroll) chipsEl.scrollLeft = keptChipScroll;
      syncChipArrows();
      return;
    }
    if (Math.abs(chipsEl.scrollLeft - chipScrollTarget(chipsEl, chip)) <= CHIP_CENTER_EPS) return;
    requestAnimationFrame(() => {
      if (chipFollowDay || chipPhase !== "idle") return;
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

  let warmHtml = state.warmHtml;
  let warmPlaces = state.warmPlaces;
  const dayCache = state.dayBundles;
  let cacheEpoch = state.dayCacheEpoch;
  const thumbPool = state.thumbPool;

  function dropWarmPaint(dayIso) {
    if (!dayIso) return;
    warmHtml.delete(dayIso);
  }

  function mergePlaceInMemory(place) {
    if (!place?.id) return false;
    const day = place.day || place.dayDate;
    let hit = false;
    if (warmPlaces) {
      const idx = warmPlaces.findIndex((entry) => entry.id === place.id);
      if (idx >= 0) {
        warmPlaces[idx] = { ...warmPlaces[idx], ...place };
        state.warmPlaces = warmPlaces;
        hit = true;
      }
    }
    for (const bundle of dayCache.values()) {
      for (const item of bundle.items || []) {
        if (item.place?.id === place.id) {
          item.place = { ...item.place, ...place };
          hit = true;
        }
      }
    }
    if (hit) dropWarmPaint(day);
    return hit;
  }

  function mergeNoteInMemory(note) {
    if (!note?.id) return false;
    const day = String(note.day || state.activeDay || "").slice(0, 10);
    const bundle = dayCache.get(day);
    if (!bundle) return false;
    const placeId = note.placeId || null;
    if (placeId && !bundle.items?.some((entry) => entry.place.id === placeId)) return false;
    for (const item of bundle.items || []) {
      if (!item.notes?.length) continue;
      item.notes = item.notes.filter((entry) => entry.id !== note.id);
    }
    bundle.freeNotes = (bundle.freeNotes || []).filter((entry) => entry.id !== note.id);
    if (!placeId) {
      bundle.freeNotes = [...bundle.freeNotes, note];
      state.freeNotesExpanded = true;
    } else {
      const item = bundle.items.find((entry) => entry.place.id === placeId);
      item.notes = [note, ...(item.notes || [])];
      item.notes.sort((a, b) => (b.ts ?? b.createdAt ?? 0) - (a.ts ?? a.createdAt ?? 0));
    }
    dropWarmPaint(day);
    return true;
  }

  function forgetNoteInMemory(note) {
    if (!note?.id) return false;
    let hit = false;
    for (const [day, bundle] of dayCache.entries()) {
      let changed = false;
      for (const item of bundle.items || []) {
        if (!item.notes?.some((entry) => entry.id === note.id)) continue;
        item.notes = item.notes.filter((entry) => entry.id !== note.id);
        changed = true;
      }
      const free = bundle.freeNotes || [];
      if (free.some((entry) => entry.id === note.id)) {
        bundle.freeNotes = free.filter((entry) => entry.id !== note.id);
        changed = true;
      }
      if (changed) {
        dropWarmPaint(day);
        hit = true;
      }
    }
    return hit;
  }

  function applyPendingCaption() {
    const pending = window.vacrecapPendingCaption;
    if (!pending?.id) return;
    let hits = 0;
    for (const bundle of dayCache.values()) {
      for (const item of bundle.items || []) {
        const hit = item.media?.find((entry) => entry.id === pending.id);
        if (hit) {
          hit.caption = pending.caption ?? null;
          hits += 1;
        }
      }
    }
    window.vacrecapPendingCaption = null;
  }

  // Eigenes Speichern malt nur die Tagesliste aus dem Cache. Kein data-changed,
  // damit der globale View-Refresh ausbleibt. Fremde Events laden den Tag neu.
  async function publishSaved(payload) {
    const isNote = payload && typeof payload.text === "string" && payload.id;
    const isPlace = payload?.id && payload.name && typeof payload.text !== "string";
    let cached = true;
    if (payload?.deleted) cached = forgetNoteInMemory(payload);
    else if (isNote) cached = mergeNoteInMemory(payload);
    else if (isPlace) cached = mergePlaceInMemory(payload);
    else if (payload?.place?.id) cached = mergePlaceInMemory(payload.place);
    if (!cached) {
      await refreshDayList();
      return;
    }
    await refreshDayList({ reuse: true });
  }

  // Paket 3: Reihenfolge nur im Tagescache, dann der vorhandene publishSaved-Anstrich.
  // Kein data-changed und kein zweiter Refresh.
  const applyMediaOrder = async (placeId, orderedIds) => {
    if (appEl?.dataset?.appRenderGen !== mountGen || !contentEl?.isConnected) return;
    const bundle = dayCache.get(state.activeDay);
    const item = bundle?.items?.find((entry) => entry.place?.id === placeId);
    if (item?.media) {
      applyMediaRanks(item.media, orderedIds);
      item.media.sort(compareMediaOrder);
    }
    await publishSaved({ id: placeId, mediaOrder: true });
  };
  window.vacrecapApplyMediaOrder = applyMediaOrder;
  const orderCleanup = appEl._screenCleanup;
  appEl._screenCleanup = () => {
    if (window.vacrecapApplyMediaOrder === applyMediaOrder) window.vacrecapApplyMediaOrder = null;
    orderCleanup?.();
  };

  async function activeDayItems() {
    const bundle = dayCache.get(state.activeDay);
    if (bundle?.items) return bundle.items;
    if (!warmPlaces) {
      warmPlaces = await getPlacesForVacation(id);
      state.warmPlaces = warmPlaces;
    }
    return loadDayPlacesEnriched(id, state.activeDay, warmPlaces);
  }

  async function previewNoteLabelFromCache() {
    const selectedId = state.selectedByDay[state.activeDay];
    const bundle = dayCache.get(state.activeDay);
    if (!bundle?.items) {
      return previewNoteCaptureTarget({
        vacationId: id,
        day: state.activeDay,
        selectedPlaceId: selectedId,
      });
    }
    const hard = bundle.items.map((entry) => entry.place).filter((place) => !place.soft);
    if (selectedId) {
      const selected = hard.find((place) => place.id === selectedId);
      if (selected) return { label: selected.name, kind: "selected" };
    }
    const ohne = hard.find((place) => place.name === "Ohne Ort" && place.lat == null && place.lng == null);
    if (await getRememberCaptureLocation()) {
      try {
        const pos = await getCapturePosition();
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        if (!coordinatesAreUsable(lat, lng)) throw new Error("position unavailable");
        const near = findPlaceWithinMeters(hard, lat, lng, await getSamePlaceRadiusM());
        if (near) return { label: near.name, kind: "gps-match" };
        return { label: "Neuer Ort", kind: "gps-new" };
      } catch {
        const newest = newestHardPlace(hard);
        if (newest) return { label: newest.name, kind: "fallback" };
        if (ohne) return { label: ohne.name, kind: "fallback" };
        return { label: "Ohne Ort", kind: "fallback" };
      }
    }
    const newest = newestHardPlace(hard);
    if (newest) return { label: newest.name, kind: "fallback" };
    if (ohne) return { label: ohne.name, kind: "fallback" };
    return { label: "Ohne Ort", kind: "fallback" };
  }

  async function showSelectedPlace(placeId) {
    state.selectedByDay[state.activeDay] = placeId;
    persistSelection(id, state);
    if (dayCache.has(state.activeDay)) {
      await paintCachedDays([state.activeDay]);
      return;
    }
    await refreshDayList({ reuse: true });
  }

  function placesForDayFromCache() {
    const bundle = dayCache.get(state.activeDay);
    if (bundle?.items) {
      return bundle.items.map((entry) => entry.place).filter((p) => !p.soft);
    }
    return activeDayItems().then((items) => items.map((entry) => entry.place).filter((p) => !p.soft));
  }

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
    const roleNow = (await getConfirmedTripRole(id)).role;
    return {
      html: composeDayHtml(dayIso, bundle, {
        active,
        selectedId,
        thumbUrls,
        roleNow,
        selecting,
      }),
      thumbUrls,
      stale,
    };
  }

  function composeDayHtml(dayIso, bundle, { active, selectedId, thumbUrls, roleNow, selecting }) {
    const canEditMedia = canAddOwn(roleNow);
    let placeHtml = emptyDayHtml;
    const items = bundle.items || [];
    if (items.length) {
      const { listHtml, mediaErrorHtml, selectBarHtml } = renderPlaceListHtml(items, {
        selectedId,
        notesExpanded: active ? state.notesExpanded : new Set(),
        thumbUrls,
        canEditMedia,
        freshPlaceIds: state.freshPlaceIds,
        share,
        canEditPlace: (place) => canEditItem(roleNow, place, state.userId),
        photoSelect: {
          active: Boolean(selecting),
          selectedIds: state.photoSelected || new Set(),
          userId: state.userId,
        },
      });
      placeHtml = wrapPlaceList(listHtml, mediaErrorHtml, selectBarHtml || "");
    }
    const lastDay = days[days.length - 1];
    const showRecapEntry = dayIso === lastDay && todayIso() >= (vacation.endDate || "");
    const entryHtml = showRecapEntry ? recapEntryCardHtml(recapEntry) : "";
    return (
      entryHtml +
      withFreeNotesHtml(placeHtml, bundle.freeNotes || [], {
        expanded: Boolean(active && state.freeNotesExpanded),
        replaceEmpty: items.length === 0,
        share,
      })
    );
  }

  function htmlForCachedDay(dayIso) {
    if (!dayIso) return "";
    const warm = warmHtml.get(dayIso);
    if (warm?.html && !warm.stale) return warm.html;
    const bundle = dayCache.get(dayIso);
    if (!bundle?.items) return "";
    let selectedId = state.selectedByDay[dayIso] || null;
    if (!selectedId) {
      const hard = bundle.items.map((entry) => entry.place).filter((place) => !place.soft);
      const newest = newestHardPlace(hard);
      if (newest) {
        selectedId = newest.id;
        state.selectedByDay[dayIso] = newest.id;
        persistSelection(id, state);
      }
    }
    const visibleIds = visibleThumbMediaIds(bundle.items, selectedId);
    const thumbUrls = {};
    for (const mediaId of visibleIds) {
      if (thumbPool[mediaId]) thumbUrls[mediaId] = thumbPool[mediaId];
    }
    return composeDayHtml(dayIso, bundle, {
      active: false,
      selectedId,
      thumbUrls,
      roleNow: roleInfo.role,
      selecting: false,
    });
  }

  function neighborIso(which) {
    const idx = days.indexOf(state.activeDay);
    if (which === "prev") return idx > 0 ? days[idx - 1] : "";
    if (which === "next") return idx >= 0 && idx < days.length - 1 ? days[idx + 1] : "";
    return "";
  }

  function bundleStamp(dayIso) {
    const bundle = dayCache.get(dayIso);
    if (!bundle) return null;
    const items = (bundle.items || [])
      .map((item) => {
        const media = (item.media || []).map((entry) => `${entry.id}:${entry.placeId || ""}:${entry.day || ""}`).join(",");
        const notes = (item.notes || []).map((entry) => `${entry.id}:${entry.text || ""}`).join(",");
        return `${item.place?.id || ""}#${media}#${notes}`;
      })
      .join(";");
    const free = (bundle.freeNotes || []).map((entry) => `${entry.id}:${entry.text || ""}`).join(",");
    return `${items}|${free}`;
  }

  function rememberDayData(dayIso) {
    const stamp = bundleStamp(dayIso);
    if (!dayIso || stamp == null) return;
    dayDataSeen.set(dayIso, stamp);
  }

  function holdPageActions(page) {
    if (!page) return;
    for (const el of page.querySelectorAll("[data-action]")) {
      el.dataset.actionHold = el.getAttribute("data-action");
      el.removeAttribute("data-action");
    }
    const selected = page.querySelector(".oc--selected");
    if (selected) {
      page.dataset.heldSelection = selected.dataset.placeId || "";
      selected.classList.remove("oc--selected");
      selected.querySelector(".pinb--selected")?.classList.remove("pinb--selected");
    }
  }

  function restorePageActions(page) {
    if (!page) return;
    for (const el of page.querySelectorAll("[data-action-hold]")) {
      if (!el.getAttribute("data-action")) el.setAttribute("data-action", el.dataset.actionHold);
      el.removeAttribute("data-action-hold");
    }
    const held = page.dataset.heldSelection;
    if (!held) return;
    delete page.dataset.heldSelection;
    const card = page.querySelector(`[data-place-id="${held}"]`);
    if (!card) return;
    card.classList.add("oc--selected");
    card.querySelector(".pinb")?.classList.add("pinb--selected");
  }

  function prepareNeighborPages() {
    if (!contentEl?.isConnected) return;
    let mounted = false;
    for (const which of ["prev", "next"]) {
      const dayIso = neighborIso(which);
      const page = contentEl.querySelector(`[data-page="${which}"]`);
      if (!page) continue;
      const html = htmlForCachedDay(dayIso);
      const sameDay = Boolean(dayIso) && page.dataset.swipeDay === dayIso && page.childElementCount > 0;
      const seen = dayIso ? dayDataSeen.get(dayIso) : undefined;
      const now = dayIso ? bundleStamp(dayIso) : null;
      const dataChanged = now != null && seen !== undefined && now !== seen;
      if (sameDay && page.dataset.live === "1" && !dataChanged) continue;
      if (sameDay && !dataChanged && mountedNeighborHtml.get(page) === html) continue;
      const wrote = setDaySwipeNeighbor(contentEl, which, html, { day: dayIso, force: dataChanged });
      if (!wrote) continue;
      holdPageActions(page);
      mounted = true;
      pageSnaps.delete(page);
      if (html) {
        mountedNeighborHtml.set(page, html);
        rememberDayData(dayIso);
      } else {
        mountedNeighborHtml.delete(page);
        if (dayIso) dayDataSeen.delete(dayIso);
      }
    }
    if (mounted) bindBrokenThumbs(contentEl);
  }

  function snapshotLeavingPage() {
    const page = contentEl.querySelector("[data-page='current']");
    if (!page) return;
    page.dataset.live = "1";
    pageSnaps.set(page, {
      day: page.dataset.swipeDay || state.activeDay,
      photoSelecting: Boolean(state.photoSelecting),
      photoSelected: [...(state.photoSelected || [])],
    });
  }

  function restoreArrivingPage() {
    const page = contentEl.querySelector("[data-page='current']");
    const snap = page ? pageSnaps.get(page) : null;
    const day = page?.dataset.swipeDay || "";
    if (snap && snap.day && snap.day === day) {
      state.photoSelecting = snap.photoSelecting;
      state.photoSelected = new Set(snap.photoSelected);
    } else {
      if (page && snap) pageSnaps.delete(page);
      state.photoSelecting = false;
      state.photoSelected = new Set();
    }
    if (contentEl) contentEl.dataset.photoSelecting = state.photoSelecting ? "1" : "0";
    syncPhotoSelectMark();
    restorePageActions(page);
    holdPageActions(contentEl.querySelector("[data-page='prev']"));
    holdPageActions(contentEl.querySelector("[data-page='next']"));
  }

  function clearWarm() {
    for (const built of warmHtml.values()) revokeThumbUrls(built?.thumbUrls);
    warmHtml.clear();
    warmPlaces = null;
    state.warmPlaces = null;
    dropTripPlaceMemory(id);
    dayCache.clear();
    for (const key of Object.keys(thumbPool)) delete thumbPool[key];
  }

  async function paintCachedDays(dayList) {
    const unique = [...new Set(dayList.filter(Boolean))];
    for (const day of unique) {
      if (!dayCache.has(day)) continue;
      const plain = await buildDayHtml(day, warmPlaces, { selection: false });
      if (!plain.stale) warmHtml.set(day, plain);
    }
    prepareNeighborPages();
    const active = state.photoSelecting
      ? await buildDayHtml(state.activeDay, warmPlaces, { selection: true })
      : warmHtml.get(state.activeDay);
    if (!active?.html || active.stale) return;
    contentEl.dataset.photoSelecting = state.photoSelecting ? "1" : "0";
    syncPhotoSelectMark();
    queuePaint(active, state.listRefreshToken, { keepScroll: true });
  }

  function syncPhotoSelectMark() {
    if (appEl) appEl.dataset.photoSelect = state.photoSelecting ? "1" : "0";
  }

  function clearPhotoSelect() {
    state.photoSelecting = false;
    state.photoSelected = new Set();
    if (contentEl?.isConnected) contentEl.dataset.photoSelecting = "0";
    syncPhotoSelectMark();
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
    const prev = neighborIso("prev");
    const next = neighborIso("next");
    for (const day of [prev, next]) {
      if (!day || (warmHtml.get(day)?.html && !warmHtml.get(day)?.stale)) continue;
      if (dayCache.has(day)) continue;
      let built;
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
    if (token !== state.listRefreshToken || !contentEl.isConnected) return;
    prepareNeighborPages();
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
    return contentEl.dataset.gesture === "1" || contentEl.dataset.swipeLock === "1" || scrolling;
  }

  function paintDay(built, { keepScroll = false } = {}) {
    if (!contentEl.isConnected || !built?.html) return;
    contentEl.dataset.photoSelecting = state.photoSelecting ? "1" : "0";
    const previousThumbUrls = state.thumbUrls;
    state.thumbUrls = built.thumbUrls || {};
    syncDayEdges();
    setDaySwipePage(contentEl, built.html, { keepScroll, day: state.activeDay });
    rememberDayData(state.activeDay);
    bindBrokenThumbs(contentEl);
    prepareNeighborPages();
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
    setDaySwipePage(contentEl, daySkeletonHtml, { day: state.activeDay });
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
    setDaySwipePage(contentEl, dayErrorHtml, { day: state.activeDay });
  }

  async function refreshDayList({ reuse = false, prefetch = !reuse } = {}) {
    const token = ++state.listRefreshToken;
    try {
      await maybeSoftOnOpen();
      if (token !== state.listRefreshToken) return;
      if (!reuse) clearWarm();
      if (!warmPlaces) {
        warmPlaces = await getPlacesForVacation(id);
        state.warmPlaces = warmPlaces;
      }
      if (token !== state.listRefreshToken) return;
      let built = await buildDayHtml(state.activeDay, warmPlaces, {
        selection: Boolean(state.photoSelecting),
      });
      if (token !== state.listRefreshToken) {
        revokeThumbUrls(built?.thumbUrls);
        return;
      }
      if (built?.stale) {
        built = await buildDayHtml(state.activeDay, warmPlaces, {
          selection: Boolean(state.photoSelecting),
        });
      }
      if (!built?.stale) warmHtml.set(state.activeDay, built);
      if (!contentEl.isConnected || !built?.html) return;
      queuePaint(built, token, { keepScroll: reuse });
      persistSelection(id, state);
      if (token !== state.listRefreshToken || !contentEl.isConnected) return;
      if (prefetch) void prefetchNeighbors(token);
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
    const page = contentEl.querySelector("[data-page='current']");
    const adopted = Boolean(page?.dataset.swipeDay === next && page.childElementCount > 0);
    state.listRefreshToken += 1;
    pendingPaint = null;
    state.activeDay = next;
    persistSelection(id, state);
    renderChips();
    syncDayEdges();
    prepareNeighborPages();
    if (!adopted) void refreshDayList({ reuse: true });
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
      const ts = placeTsForCapture(captureDay, null, places);
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
        ts: choice.ts || placeTsForCapture(captureDay, null, places),
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
    const takenAt = (await readPhotoTakenAt(files?.[0])) ?? null;
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
    const items = await activeDayItems();
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
        const items = await activeDayItems();
        return items.map((i) => i.place).filter((p) => !p.soft);
      },
      previewPlaceLabel: () => previewNoteLabelFromCache(),
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
      onSaved: async (payload) => {
        if (payload?.toast?.line) {
          showCaptureResultToast(payload, "note");
        }
        publishSaved(payload);
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
    syncPhotoSelectMark();
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
      if (!warmPlaces) {
        warmPlaces = await getPlacesForVacation(id);
        state.warmPlaces = warmPlaces;
      }
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

  let photoSelectChain = Promise.resolve();

  contentEl.addEventListener("click", async (e) => {
    if (e.target.closest("[data-kr-tip]")) return;
    if (e.target.closest("[data-action='open-recap-video']")) {
      e.preventDefault();
      navigate({ name: "urlaub-recap", id });
      return;
    }
    if (e.target.closest("[data-action='open-diary']")) {
      e.preventDefault();
      navigate({ name: "urlaub-tagebuch", id });
      return;
    }

    if (e.target.closest("[data-action='photo-select-exit']")) {
      e.preventDefault();
      await exitPhotoSelect();
      return;
    }
    const photoCheck = e.target.closest("[data-action='photo-row-check']");
    if (photoCheck) {
      e.preventDefault();
      e.stopPropagation();
      photoSelectChain = photoSelectChain.catch(() => {}).then(async () => {
        const mediaId = photoCheck.dataset.mediaId;
        const placeId = photoCheck.closest("[data-place-id]")?.dataset.placeId || null;
        if (photoCheck.dataset.own !== "1") {
          showWarnToast("Nur eigene Fotos kannst du verschieben.");
          return;
        }
        if (!state.photoSelecting) {
          await enterPhotoSelect({ mediaId, placeId });
          return;
        }
        if (!state.photoSelected) state.photoSelected = new Set();
        if (state.photoSelected.has(mediaId)) state.photoSelected.delete(mediaId);
        else state.photoSelected.add(mediaId);
        await paintCachedDays([state.activeDay]);
      });
      await photoSelectChain;
      return;
    }
    if (e.target.closest("[data-action='photo-move']")) {
      e.preventDefault();
      await onMoveSelectedPhotos();
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
      const items = await activeDayItems();
      const item = items.find((i) => i.place.id === placeId);
      if (!item) return;
      const viewable = filterViewableMedia(item.media);
      const role = (await getConfirmedTripRole(id)).role;
      openMediaViewer(viewable, tile.dataset.mediaId, {
        canDelete: (entry) => canEditItem(role, entry, state.userId),
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
        const role = (await getConfirmedTripRole(id)).role;
        if (!media || !canCaptionMedia(media, role, state.userId)) return;
        await openPhotoCaptionSheet({ media });
      } finally {
        state.captionBusy = false;
      }
      return;
    }

    const openCaption = e.target.closest("[data-action='open-photo-caption']");
    if (openCaption) {
      e.preventDefault();
      if (state.captionBusy) return;
      state.captionBusy = true;
      try {
        const media = findCachedMedia(openCaption.dataset.mediaId);
        if (!media) return;
        await openPhotoCaptionSheet({ media, readOnly: true });
      } finally {
        state.captionBusy = false;
      }
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
        await showSelectedPlace(placeId);
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
        await showSelectedPlace(placeId);
        return;
      }
      const items = await activeDayItems();
      const item = items.find((i) => i.place.id === placeHost.dataset.placeId);
      const note = item?.notes.find((n) => n.id === noteRow.dataset.noteId);
      if (!note || !item) return;
      openNoteSheet({
        place: item.place,
        vacationId: id,
        vacation,
        day: state.activeDay,
        dayIndex: dayIndexInTrip(vacation, state.activeDay),
        placesForDay: () => placesForDayFromCache(),
        note,
        onSaved: async (saved) => {
          publishSaved(saved);
        },
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
        await refreshDayList({ reuse: true });
        return;
      }
      if (e.target.closest('[data-action="collapse-free-notes"]')) {
        state.freeNotesExpanded = false;
        await refreshDayList({ reuse: true });
        return;
      }
      const editFree =
        e.target.closest('[data-action="edit-free-note"]') || e.target.closest("[data-free-note]");
      const addFree = e.target.closest('[data-action="add-free-note"]');
      if (editFree || addFree) {
        const bundle = dayCache.get(state.activeDay);
        const notes = bundle ? bundle.freeNotes || [] : await getFreeNotesForDay(id, state.activeDay);
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
          placesForDay: () => placesForDayFromCache(),
          note: note || undefined,
          onSaved: async (saved) => {
            publishSaved(saved);
          },
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
      const items = await activeDayItems();
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
        placesForDay: () => placesForDayFromCache(),
        onSaved: async (saved) => {
          publishSaved(saved);
        },
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
      const items = await activeDayItems();
      const item = items.find((i) => i.place.id === placeId);
      if (!item) return;
      if (editBtn) {
        openEditPlaceSheet(item.place, {
          onSaved: (updated) => publishSaved(updated),
          onDeleted: async (pid) => {
            if (state.selectedByDay[state.activeDay] === pid) {
              delete state.selectedByDay[state.activeDay];
            }
            await refreshDayList();
          },
        });
      } else if (expandBtn) {
        state.notesExpanded.add(placeId);
        await refreshDayList({ reuse: true });
      } else if (collapseBtn) {
        state.notesExpanded.delete(placeId);
        await refreshDayList({ reuse: true });
      }
      return;
    }

    const soft = e.target.closest(".soft[data-place-id]");
    if (soft) {
      const placeId = soft.dataset.placeId;
      const items = await activeDayItems();
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
      await showSelectedPlace(card.dataset.placeId);
    }
  });

  function syncChipArrows() {
    const prev = appEl.querySelector("[data-action='chips-prev']");
    const next = appEl.querySelector("[data-action='chips-next']");
    if (!prev || !next) return;
    const max = chipsEl.scrollWidth - chipsEl.clientWidth;
    const over = max > 1 && !chipsEl.classList.contains("day-chips--follow");
    prev.hidden = !(over && chipsEl.scrollLeft > 1);
    next.hidden = !(over && chipsEl.scrollLeft < max - 1);
  }

  function scrollChipsStep(dir) {
    if (chipPhase !== "idle") return;
    const sample = chipsEl.querySelector(".day-chip");
    const step = (sample?.offsetWidth || 80) + 8;
    const max = Math.max(0, chipsEl.scrollWidth - chipsEl.clientWidth);
    chipsEl.scrollLeft = Math.max(0, Math.min(max, chipsEl.scrollLeft + dir * step));
    syncChipArrows();
  }

  function bindChipBarDesktop() {
    appEl.querySelector("[data-action='chips-prev']")?.addEventListener("click", () => scrollChipsStep(-1));
    appEl.querySelector("[data-action='chips-next']")?.addEventListener("click", () => scrollChipsStep(1));
    chipsEl.addEventListener(
      "scroll",
      () => {
        syncChipArrows();
        if (chipPhase !== "idle" && chipMarkBox) {
          placeMark(chipMarkBox);
          applyMarkTint(chipMarkBox);
        }
      },
      { passive: true }
    );
    const onResize = () => syncChipArrows();
    window.addEventListener("resize", onResize);
    const chipResize = typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
    chipResize?.observe(chipsEl);
    const prevCleanup = appEl._screenCleanup;
    appEl._screenCleanup = () => {
      chipResize?.disconnect();
      window.removeEventListener("resize", onResize);
      prevCleanup?.();
    };

    chipsEl.addEventListener(
      "wheel",
      (event) => {
        if (chipPhase !== "idle") return;
        if (event.ctrlKey) return;
        const max = chipsEl.scrollWidth - chipsEl.clientWidth;
        if (max <= 1) return;
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        event.preventDefault();
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? chipsEl.clientWidth : 1;
        chipsEl.scrollLeft = Math.max(0, Math.min(max, chipsEl.scrollLeft + event.deltaY * unit));
        syncChipArrows();
      },
      { passive: false }
    );

    let chipGrab = null;
    let suppressChipClick = false;
    chipsEl.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      if (chipPhase !== "idle") return;
      chipGrab = { id: event.pointerId, x: event.clientX, left: chipsEl.scrollLeft, moved: false };
    });
    chipsEl.addEventListener("pointermove", (event) => {
      if (!chipGrab || event.pointerId !== chipGrab.id) return;
      const dx = event.clientX - chipGrab.x;
      if (!chipGrab.moved) {
        if (Math.abs(dx) < 5) return;
        chipGrab.moved = true;
        chipsEl.classList.add("day-chips--grab");
        try {
          chipsEl.setPointerCapture(event.pointerId);
        } catch {
          /* synthetischer Pointer */
        }
      }
      chipsEl.scrollLeft = chipGrab.left - dx;
      syncChipArrows();
      if (event.cancelable) event.preventDefault();
    });
    const endChipGrab = (event) => {
      if (!chipGrab || event.pointerId !== chipGrab.id) return;
      const moved = chipGrab.moved;
      chipGrab = null;
      chipsEl.classList.remove("day-chips--grab");
      if (!moved) return;
      suppressChipClick = true;
      setTimeout(() => {
        suppressChipClick = false;
      }, 400);
    };
    chipsEl.addEventListener("pointerup", endChipGrab);
    chipsEl.addEventListener("pointercancel", endChipGrab);
    chipsEl.addEventListener(
      "click",
      (event) => {
        if (!suppressChipClick) return;
        suppressChipClick = false;
        event.preventDefault();
        event.stopPropagation();
      },
      true
    );
  }

  bindChipBarDesktop();

  chipsEl.addEventListener("click", (e) => {
    const chip = e.target.closest(".day-chip");
    if (!chip?.dataset.day) return;
    const dayIso = chip.dataset.day;
    const settling = contentEl.dataset.swipeLock === "1";
    if (settling) cancelDaySwipeSettle(contentEl);
    const moving = chipPhase !== "idle";
    if (moving) {
      chipScrollToken += 1;
      chipFollowDay = null;
      endFollowVisual();
    }
    if (settling && dayIso === state.activeDay) {
      applyChipActive(state.activeDay);
      const live = chipsEl.querySelector(`[data-day="${state.activeDay}"]`);
      if (live) chipsEl.scrollLeft = chipScrollTarget(chipsEl, live);
      return;
    }
    setActiveDay(dayIso);
  });

  renderChips();
  if (appEl?.dataset?.appRenderGen !== mountGen) return;
  if (ownDaySave) applyPendingCaption();
  const reuseDay = ownDaySave && Boolean(warmPlaces && dayCache.has(state.activeDay));
  await refreshDayList(reuseDay ? { reuse: true } : {});
  if (appEl?.dataset?.appRenderGen !== mountGen) return;
  if (keptDayScroll) {
    const page = contentEl.querySelector("[data-page='current']");
    if (page) page.scrollTop = keptDayScroll;
  }
  if (keptChipScroll) {
    requestAnimationFrame(() => {
      if (!chipsEl.isConnected || appEl?.dataset?.appRenderGen !== mountGen) return;
      chipsEl.scrollLeft = keptChipScroll;
    });
  }

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


  const pendingFooter = consumePendingFooter();
  if (pendingFooter === "note") {
    requestAnimationFrame(() => void onNoteFooter());
  } else if (pendingFooter === "gallery") {
    requestAnimationFrame(() => navigate({ name: "urlaub-mediathek", id }));
  } else if (pendingFooter === "camera") {
    requestAnimationFrame(() => openNativeCamera());
  }
}

