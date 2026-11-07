import {
  adjacentDay,
  dayChipDateLine,
  dayIndexInTrip,
  dayRoleLabel,
  defaultActiveDay,
  vacationDays,
} from "./days.js";
import { getSession, getUserId } from "./auth-service.js";
import {
  fetchMediaForPlace,
  fetchUploadedPhotosForTrip,
  getFreeNotesForDay,
  getNotesForPlace,
  getPlace,
  getPlacesForDay,
  getPlacesForVacation,
  getVacation,
} from "./db.js";
import { ICON_BACK_CHEVRON, ICON_GEAR, ICON_MAP } from "./icons.js";
import { fallbackPlaceName, formatTimeFromTs } from "./geo.js";
import { placeTsForCapture } from "./capture-time.js";
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
import { readCache, writeCache } from "./local-cache.js";
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
  normalizeDaySwipePages,
  setDaySwipeNeighbor,
  setDaySwipePage,
} from "./day-swipe.js";
import {
  filterViewableMedia,
  loadDayPlacesEnriched,
  renderPlaceListHtml,
  resolveThumbUrlMap,
  revokeThumbUrls,
  visibleThumbMediaIds,
  withFreeNotesHtml,
  wrapPlaceList,
  renderPlaceCardHtml,
  renderFreeNotesHtml,
} from "./ui-place-list.js";
import { bindCircleTips, shareContext, showCircleTip } from "./member-marks.js";
import { canAddOwn, canEditItem, getConfirmedTripRole, isReadOnlyTripRole, ROLE_LABEL } from "./trip-role.js";
import { loadTripPeople, personLetter } from "./trip-people.js";
import { watchTripActivity } from "./trip-presence.js";
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
import { escapeHtml, todayIso } from "./utils.js";
import { computeVacationStats, formatVacationStatsLine } from "./vacation-stats.js";

const CHIP_ARROW_PREV = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 6l-6 6 6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHIP_ARROW_NEXT = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M10 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const tripUiState = new Map();

export function clearTripUiState(vacationId) {
  const state = tripUiState.get(vacationId);
  if (state?.thumbUrls) revokeThumbUrls(state.thumbUrls);
  tripUiState.delete(vacationId);
  delete window.__vacrecapTripListPatch;
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
    };
    tripUiState.set(id, state);
  }
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
  let vacation = await getVacation(id);
  if (appEl?.dataset?.appRenderGen !== mountGen) return;
  if (!vacation) {
    navigate({ name: "urlaube" });
    return;
  }

  const days = vacationDays(vacation);
  const [state, recapEntry, people] = await Promise.all([
    getState(id, vacation),
    loadRecapEntry(id),
    loadTripPeople(id, { refresh: true }),
  ]);
  // tripUiState hängt am Trip; nach Kontowechsel muss userId neu aus der Session kommen
  // (sonst bleibt die alte Id und z. B. photoBadges zeigen kein «Du»).
  try {
    const session = await getSession();
    state.userId = session?.user?.id ?? null;
  } catch {
    state.userId = null;
  }
  if (!state.userId) {
    try {
      state.userId = await getUserId();
    } catch {
      state.userId = null;
    }
  }
  const roleInfo = await getConfirmedTripRole(id);
  const share = shareContext(roleInfo.role, state.userId, people);
  const tripRoleNow = roleInfo.role;
  const tripReadOnly = isReadOnlyTripRole(tripRoleNow);
  const liveUsers = new Set();

  appEl.className = "screen screen--trip screen--trip-swipe";
  appEl.dataset.vacationId = id;

  appEl.innerHTML = `
    <header class="trip-header">
      <button type="button" class="link-btn link-btn--back" data-action="back">${ICON_BACK_CHEVRON}<span>Reisen</span></button>
      <h1 class="trip-header__title">${escapeHtml(vacation.title)}</h1>
      <div class="trip-header__actions">
        <button type="button" class="icon-btn icon-btn--map-draft" data-action="map" aria-label="Karte">${ICON_MAP}</button>
        <button type="button" class="icon-btn icon-btn--gear-draft" data-action="settings" aria-label="Einstellungen"${tripReadOnly ? " disabled" : ""}>${ICON_GEAR}</button>
      </div>
    </header>
    <div data-role="member-bar"></div>
    <div data-role="role-banner"></div>
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

  const paintMemberChrome = () => {
    const barHost = appEl.querySelector('[data-role="member-bar"]');
    const bannerHost = appEl.querySelector('[data-role="role-banner"]');
    if (bannerHost) {
      if (share.readOnly) {
        bannerHost.innerHTML = `<div class="fg-role" data-testid="role-banner"><span aria-hidden="true">ⓘ</span><span>Du bist <b>Betrachter</b>. Alles ansehen, nichts hinzufügen oder ändern.</span></div>`;
      } else if (share.viewer) {
        bannerHost.innerHTML = `<div class="fg-role" data-testid="role-banner"><span aria-hidden="true">ⓘ</span><span>Du bist <b>Beitragender</b>. Eigenes hinzufügen und ändern, Fremdes nur ansehen.</span></div>`;
      } else {
        bannerHost.innerHTML = "";
      }
    }
    if (!barHost) return;
    if (!share.showBar) {
      barHost.innerHTML = "";
      return;
    }
    const parts = share.members
      .map((person, index) => {
        const label = ROLE_LABEL[person.role] || "";
        const color = share.colors.get(person.user_id) || person.avatar_color || "#5D6D7E";
        const live = liveUsers.has(person.user_id) ? " kr-m--live" : "";
        const sep = index ? `<span class="kr-sep" aria-hidden="true"></span>` : "";
        return `${sep}<button type="button" class="kr-m${live}" data-kr-tip="${escapeHtml(`${person.display_name || ""} · ${label}`)}" data-user-id="${escapeHtml(person.user_id || "")}" data-testid="member-chip">${`<span class="kr-av kr-av--md" style="--kr:${escapeHtml(color)}">${escapeHtml(personLetter(person))}</span>`}<span>${escapeHtml(label)}</span></button>`;
      })
      .join("");
    barHost.innerHTML = `<div class="kr-bar" data-testid="member-bar">${parts}</div>`;
  };
  paintMemberChrome();
  bindCircleTips(appEl);
  appEl.querySelector('[data-role="member-bar"]')?.addEventListener("click", async (event) => {
    const chip = event.target.closest("[data-testid='member-chip']");
    if (!chip) return;
    event.preventDefault();
    event.stopPropagation();
    let count = 0;
    try {
      const result = await fetchUploadedPhotosForTrip(id);
      count = (result?.media || []).filter((item) => item.author === chip.dataset.userId && !item.deletedAt).length;
    } catch {
      count = 0;
    }
    const noun = count === 1 ? "Foto" : "Fotos";
    chip.dataset.krSub = `${count} ${noun} hier beigetragen`;
    showCircleTip(chip);
  });
  const staleNotice = takeStaleNotice(id);
  if (staleNotice?.line) showToast(staleNotice.line);

  let ignoreSelectPop = false;
  let exitSelectAfterOverlayPop = false;
  let leaveAfterSelectPop = false;
  let queuedPlacePatch = null;
  let placePatchInflight = null;
  let listRefreshInflight = null;

  async function drainPlacePatchQueue() {
    for (;;) {
      const job = queuedPlacePatch;
      if (!job) break;
      queuedPlacePatch = null;
      if (appEl?.dataset?.appRenderGen !== mountGen) return;
      await refreshDayList(job);
    }
  }

  async function runCoalescedPlacePatch(opts) {
    queuedPlacePatch = { ...(queuedPlacePatch || {}), ...opts };
    if (!placePatchInflight) {
      placePatchInflight = drainPlacePatchQueue().finally(() => {
        placePatchInflight = null;
      });
    }
    return placePatchInflight;
  }

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
    void (async () => {
      if (moveOpen) {
        exitSelectAfterOverlayPop = false;
        requestOverlayDismiss();
      }
      if (state.photoSelecting) await exitPhotoSelect();
    })();
  };

  async function onTripDataChanged(ev) {
    if (appEl?.dataset?.appRenderGen !== mountGen) return;
    const detail = ev?.detail || {};
    try {
      if (detail.mergeTrip && !detail.noteListPatch) {
        try {
          const next = await getVacation(id);
          if (next) await mergeVacationInLocalList(next);
        } catch {
          /* ignorieren */
        }
      }
      if (!(detail.skipFullRender && detail.tripId === id)) {
        if (detail.mergeTrip && !detail.noteListPatch) {
          try {
            warmPlaces = await getPlacesForVacation(id);
          } catch {
            /* ignorieren */
          }
          await mergeDayBundleFromRemote(state.activeDay, warmPlaces);
          await refreshDayList({ reuse: true });
        }
        return;
      }

      const pids = detail.placeIds?.length ? detail.placeIds : detail.placeId ? [detail.placeId] : [];
      const placeDayOnly =
        detail.placeDay != null && String(detail.placeDay).trim() !== "" && !detail.placeId && !pids.length;

      if (detail.noteListPatch) {
        ++state.listRefreshToken;
        dropStaleFullDayPaint();
        if (detail.placeId) {
          const dayIso = placeDayIso(detail.placeId);
          hydratePlaceNotesInBundleFromCache(detail.placeId, dayIso, detail.patchedNote || null);
          if (dayIso === state.activeDay && contentEl.isConnected) {
            patchPlaceCardNotesOnly(detail.placeId);
          }
        } else if (placeDayOnly || detail.placeDay != null) {
          const dayIso = String(detail.placeDay).slice(0, 10);
          hydrateFreeNotesInBundleFromCache(dayIso);
          if (dayIso === state.activeDay && contentEl.isConnected) {
            patchFreeNotesDom();
          }
        }
        return;
      }

      if (pids.length && state.moveBusy) return;

      if (pids.length) {
        if (pids.length === 1) {
          await runCoalescedPlacePatch({
            reuse: true,
            placeId: pids[0],
            mergeTrip: Boolean(detail.mergeTrip),
            bundleFresh: true,
          });
        } else {
          await refreshDayList({
            reuse: true,
            placeIds: pids,
            mergeTrip: Boolean(detail.mergeTrip),
          });
        }
        return;
      }

      if (placeDayOnly) {
        const dayIso = String(detail.placeDay).slice(0, 10);
        hydrateFreeNotesInBundleFromCache(dayIso);
        if (dayIso === state.activeDay && contentEl.isConnected) {
          patchFreeNotesDom();
        }
        return;
      }

      return;
    } catch {
      showWarnToast("Neu laden hat nicht geklappt. Bitte gleich nochmal versuchen.");
    }
  }

  if (appEl?.dataset?.appRenderGen === mountGen) {
    window.addEventListener("popstate", onTripPop);
    window.addEventListener("keydown", onTripKey);
    const stopActivity = watchTripActivity(id, (rows) => {
      liveUsers.clear();
      for (const row of rows || []) {
        if (row.user_id) liveUsers.add(row.user_id);
      }
      paintMemberChrome();
    });
    appEl._screenCleanup = () => {
      stopActivity();
      window.removeEventListener("popstate", onTripPop);
      window.removeEventListener("keydown", onTripKey);
      window.removeEventListener("vacrecap:data-changed", onTripDataChanged);
    };
    window.addEventListener("vacrecap:data-changed", onTripDataChanged);
  }

  appEl.querySelector('[data-action="map"]').addEventListener("click", () => {
    navigate({ name: "urlaub-map", id }, { fromTrip: true });
  });
  appEl.querySelector('[data-action="settings"]').addEventListener("click", (e) => {
    if (tripReadOnly) {
      e.preventDefault();
      return;
    }
    navigate({ name: "urlaub-settings", id });
  });

  const chipsEl = appEl.querySelector('[data-role="chips"]');
  const contentEl = appEl.querySelector('[data-role="day-content"]');
  const neighborHold = { prev: "", next: "" };
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
      setDaySwipeNeighbor(contentEl, "prev", neighborHold.prev);
      setDaySwipeNeighbor(contentEl, "next", neighborHold.next);
    },
    onDrag: (info) => onChipDrag(info),
    onCancel: () => onChipCancel(),
    onRest: () => {
      setDaySwipeNeighbor(contentEl, "prev", "");
      setDaySwipeNeighbor(contentEl, "next", "");
      scheduleIdleNeighborPrefetch();
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

  let warmHtml = new Map();
  let warmPlaces = null;
  let dayCache = new Map();
  let cacheEpoch = 0;
  const thumbPool = {};
  let prefetchIdleTimer = 0;
  const canEditNotesInPlace = !share.readOnly;

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

  async function mergeDayBundleFromRemote(dayIso, knownPlaces) {
    const [items, freeNotes] = await Promise.all([
      loadDayPlacesEnriched(id, dayIso, knownPlaces),
      getFreeNotesForDay(id, dayIso),
    ]);
    const bundle = dayCache.get(dayIso);
    if (bundle) {
      bundle.items = items;
      bundle.freeNotes = freeNotes;
    } else {
      dayCache.set(dayIso, { items, freeNotes });
    }
  }

  function isUploadedPhotoEntry(m) {
    return m.type !== "video" && (m.uploadStatus || "uploaded") === "uploaded";
  }

  async function refreshPlaceItemsInCache(dayIso, placeIds, knownPlaces) {
    if (!dayIso || !placeIds?.length) return;
    let bundle = dayCache.get(dayIso);
    if (!bundle?.items?.length) {
      await mergeDayBundleFromRemote(dayIso, knownPlaces);
      bundle = dayCache.get(dayIso);
    }
    if (!bundle?.items?.length) return;
    for (const pid of placeIds) {
      const idx = bundle.items.findIndex((entry) => entry.place?.id === pid);
      if (idx < 0) continue;
      const place = bundle.items[idx].place;
      if (place?.soft) continue;
      const [mediaResult, notes] = await Promise.all([fetchMediaForPlace(pid), getNotesForPlace(pid)]);
      const sortedMedia = mediaResult.media.slice().sort((a, b) => a.ts - b.ts);
      const photos = mediaResult.media.filter(isUploadedPhotoEntry).length;
      const videos = mediaResult.media.filter((m) => m.type === "video").length;
      const sortedNotes = notes
        .slice()
        .sort((a, b) => (b.createdAt ?? b.ts ?? 0) - (a.createdAt ?? a.ts ?? 0));
      bundle.items[idx] = {
        place,
        photos,
        videos,
        notes: sortedNotes,
        media: sortedMedia,
        mediaLoadError: Boolean(mediaResult.error),
      };
    }
  }

  function patchPlaceInDayCache(dayIso, placeId, fn) {
    const bundle = dayCache.get(dayIso);
    if (!bundle?.items?.length || !placeId) return;
    const idx = bundle.items.findIndex((entry) => entry.place?.id === placeId);
    if (idx < 0) return;
    const next = fn(JSON.parse(JSON.stringify(bundle.items[idx])));
    if (!next) return;
    bundle.items[idx] = next;
  }

  function sameNoteDay(noteDay, day) {
    return String(noteDay || "").slice(0, 10) === String(day || "").slice(0, 10);
  }

  function freeNotesForDayFromCache(dayIso) {
    const list = readCache()?.notes?.[id] || [];
    return list.filter((n) => (n.placeId == null || n.placeId === "") && sameNoteDay(n.day, dayIso));
  }

  function placeNotesFromCache(placeId) {
    const list = readCache()?.notes?.[id] || [];
    return list
      .filter((n) => n.placeId === placeId && !n.deletedAt)
      .slice()
      .sort((a, b) => (b.createdAt ?? b.ts ?? 0) - (a.createdAt ?? a.ts ?? 0));
  }

  function placeDayIso(placeId) {
    const fromWarm = warmPlaces?.find((p) => p.id === placeId);
    if (fromWarm) return String(fromWarm.day || fromWarm.dayDate).slice(0, 10);
    const wps = readCache()?.waypoints?.[id] || [];
    const hit = wps.find((p) => p.id === placeId);
    if (hit) return String(hit.day || hit.dayDate).slice(0, 10);
    return state.activeDay;
  }

  function hydratePlaceNotesInBundleFromCache(placeId, dayIso, patchedNote = null) {
    const day = String(dayIso || placeDayIso(placeId)).slice(0, 10);
    let bundle = dayCache.get(day);
    if (!bundle) {
      bundle = { items: [], freeNotes: [] };
      dayCache.set(day, bundle);
    }
    let notes = placeNotesFromCache(placeId);
    if (patchedNote?.id && patchedNote.placeId === placeId) {
      const rest = notes.filter((n) => n.id !== patchedNote.id);
      notes = [...rest, patchedNote].sort((a, b) => (b.createdAt ?? b.ts ?? 0) - (a.createdAt ?? a.ts ?? 0));
    }
    const idx = bundle.items.findIndex((entry) => entry.place?.id === placeId);
    if (idx >= 0) {
      bundle.items[idx].notes = notes;
    } else {
      const place =
        warmPlaces?.find((p) => p.id === placeId) ||
        (readCache()?.waypoints?.[id] || []).find((p) => p.id === placeId);
      if (place) {
        bundle.items.push({
          place,
          photos: 0,
          videos: 0,
          notes,
          media: [],
          mediaLoadError: false,
        });
      }
    }
  }

  function hydrateFreeNotesInBundleFromCache(dayIso) {
    const day = String(dayIso).slice(0, 10);
    let bundle = dayCache.get(day);
    if (!bundle) {
      bundle = { items: [], freeNotes: [] };
      dayCache.set(day, bundle);
    }
    bundle.freeNotes = freeNotesForDayFromCache(day);
  }

  function dropStaleFullDayPaint() {
    if (pendingPaint?.fullDay) pendingPaint = null;
  }

  function imgReuseMediaId(img) {
    return img?.dataset?.mediaId || "";
  }

  function patchPlaceCardNotesOnly(placeId) {
    const page = contentEl.querySelector("[data-page='current']");
    if (!page) return;
    const bundle = dayCache.get(state.activeDay);
    const item = bundle?.items?.find((entry) => entry.place?.id === placeId);
    if (!item?.place) return;
    const oc = page.querySelector(`.oc[data-place-id="${CSS.escape(placeId)}"]`);
    if (!oc) return;
    const selectedId = state.selectedByDay[state.activeDay];
    const roleNow = tripRoleNow;
    const liHtml = renderPlaceCardHtml(item, {
      selectedId,
      notesExpanded: state.notesExpanded,
      thumbUrls: state.thumbUrls,
      canEditMedia: canAddOwn(roleNow),
      freshPlaceIds: state.freshPlaceIds,
      share,
      canEditPlace: (place) => canEditItem(roleNow, place, state.userId),
      canEditNotesInPlace,
      readOnlyTrip: tripReadOnly,
      photoSelect: {
        active: state.photoSelecting,
        selectedIds: state.photoSelected || new Set(),
        userId: state.userId,
      },
    });
    const wrap = document.createElement("div");
    wrap.innerHTML = liHtml.trim();
    const newOc = wrap.querySelector(`.oc[data-place-id="${CSS.escape(placeId)}"]`);
    if (!newOc) return;
    const newMeta = newOc.querySelector(".oc__meta");
    const oldMeta = oc.querySelector(".oc__meta");
    if (newMeta && oldMeta) oldMeta.innerHTML = newMeta.innerHTML;
    const newNp = newOc.querySelector(".np");
    const oldNp = oc.querySelector(".np");
    if (newNp) {
      if (oldNp) oldNp.replaceWith(newNp);
      else oc.querySelector(".oc__body")?.appendChild(newNp);
    } else if (oldNp) oldNp.remove();
    applySelectionDom();
  }

  function patchFreeNotesDom() {
    const page = contentEl.querySelector("[data-page='current']");
    if (!page) return;
    const dayIso = state.activeDay;
    const bundle = dayCache.get(dayIso);
    const freeNotes = bundle?.freeNotes ?? freeNotesForDayFromCache(dayIso);
    const html = renderFreeNotesHtml(freeNotes, {
      expanded: state.freeNotesExpanded,
      share,
      canEditFreeNotes: canEditNotesInPlace,
    });
    const existing = page.querySelector('[data-testid="free-notes"]');
    if (existing) {
      if (html) {
        const wrap = document.createElement("div");
        wrap.innerHTML = html.trim();
        const next = wrap.firstElementChild;
        if (next) existing.replaceWith(next);
      } else {
        existing.remove();
      }
      return;
    }
    if (!html) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = html.trim();
    const section = wrap.firstElementChild;
    if (!section) return;
    const listWrap = page.querySelector(".place-list-wrap") || page.querySelector('[data-testid="place-list"]')?.closest(".place-list-wrap");
    if (listWrap) listWrap.parentElement.insertBefore(section, listWrap);
    else page.prepend(section);
  }

  async function mergeVacationInLocalList(nextVacation) {
    if (!nextVacation?.id) return;
    vacation = nextVacation;
    const prev = readCache()?.trips || [];
    const list = prev.map((t) => (t.id === nextVacation.id ? { ...t, ...nextVacation } : t));
    if (!list.some((t) => t.id === nextVacation.id)) list.push(nextVacation);
    writeCache({ trips: list });
  }

  function scheduleIdleNeighborPrefetch() {
    if (prefetchIdleTimer) clearTimeout(prefetchIdleTimer);
    const run =
      typeof requestIdleCallback === "function"
        ? (cb) => requestIdleCallback(cb, { timeout: 1200 })
        : (cb) => setTimeout(cb, 200);
    prefetchIdleTimer = run(async () => {
      prefetchIdleTimer = 0;
      const idx = days.indexOf(state.activeDay);
      const targets = [];
      if (idx > 0) targets.push(days[idx - 1]);
      if (idx >= 0 && idx < days.length - 1) targets.push(days[idx + 1]);
      for (const d of targets) {
        if (!d || warmHtml.has(d)) continue;
        try {
          if (!warmPlaces) warmPlaces = await getPlacesForVacation(id);
          const built = await buildDayHtml(d, warmPlaces, { fresh: true, selection: false });
          if (!built.stale && contentEl.isConnected) {
            warmHtml.set(d, built);
            syncNeighborHold();
          } else if (built?.thumbUrls) revokeThumbUrls(built.thumbUrls);
        } catch {
          /* ignorieren */
        }
      }
    });
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
    const roleNow = tripRoleNow;
    const canEditMedia = canAddOwn(roleNow);
    let placeHtml = emptyDayHtml;
    if (bundle.items.length) {
      const { listHtml, mediaErrorHtml, selectBarHtml } = renderPlaceListHtml(bundle.items, {
        selectedId,
        notesExpanded: active ? state.notesExpanded : new Set(),
        thumbUrls,
        canEditMedia,
        freshPlaceIds: state.freshPlaceIds,
        share,
        canEditPlace: (place) => canEditItem(roleNow, place, state.userId),
        canEditFreeNotes: canEditNotesInPlace,
        readOnlyTrip: tripReadOnly,
        photoSelect: {
          active: selecting,
          selectedIds: state.photoSelected || new Set(),
          userId: state.userId,
        },
      });
      placeHtml = wrapPlaceList(listHtml, mediaErrorHtml, selectBarHtml || "");
    }
    const lastDay = days[days.length - 1];
    const showRecapEntry = dayIso === lastDay && todayIso() >= (vacation.endDate || "");
    const entryHtml = showRecapEntry ? recapEntryCardHtml(recapEntry) : "";
    let statsLine = "";
    if (showRecapEntry && entryHtml) {
      try {
        const stats = await computeVacationStats(id);
        statsLine = `<p class="trip-inline-stats" data-testid="trip-inline-stats">${escapeHtml(formatVacationStatsLine(stats))}</p>`;
        const nextVac = { ...vacation, stats };
        vacation = nextVac;
        mergeVacationInLocalList(nextVac);
      } catch {
        statsLine = "";
      }
    }
    return {
      html:
        statsLine +
        entryHtml +
        withFreeNotesHtml(placeHtml, bundle.freeNotes, {
          expanded: active && state.freeNotesExpanded,
          replaceEmpty: bundle.items.length === 0,
          share,
          canEditFreeNotes: canEditNotesInPlace,
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
    syncPhotoSelectMark();
    queuePaint(active, state.listRefreshToken, { keepScroll: true });
  }

  function syncPhotoSelectMark() {
    if (appEl) appEl.dataset.photoSelect = state.photoSelecting ? "1" : "0";
  }

  function clearPhotoSelect() {
    state.photoSelecting = false;
    state.photoSelected = new Set();
    if (contentEl?.isConnected) {
      contentEl.dataset.photoSelecting = "0";
      contentEl.querySelector('[data-testid="photo-select-bar"]')?.remove();
    }
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
    if (!contentEl.isConnected || !built) return;
    contentEl.dataset.photoSelecting = state.photoSelecting ? "1" : "0";
    const previousThumbUrls = state.thumbUrls;
    state.thumbUrls = built.thumbUrls || {};
    syncDayEdges();
    const page = contentEl.querySelector("[data-page='current']");
    if (typeof built.patchDom === "function" && page) {
      built.patchDom(page);
    } else if (built.html) {
      setDaySwipePage(contentEl, built.html, { keepScroll });
      bindBrokenThumbs(contentEl);
    } else {
      return;
    }
    bindBrokenThumbs(contentEl);
    applySelectionDom();
    if (previousThumbUrls && previousThumbUrls !== state.thumbUrls) revokeThumbUrls(previousThumbUrls);
  }

  function flushPendingPaint() {
    if (!pendingPaint || !contentEl.isConnected) {
      if (!contentEl.isConnected) pendingPaint = null;
      return;
    }
    if (pendingPaint.fullDay && pendingPaint.token !== state.listRefreshToken) {
      pendingPaint = null;
      return;
    }
    if (paintBlocked()) return;
    const { built, keepScroll } = pendingPaint;
    pendingPaint = null;
    const isPatch = typeof built.patchDom === "function";
    if (!isPatch && built.html && pageShows(built.html)) return;
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
    const isPatch = typeof built.patchDom === "function";
    const fullDay = !isPatch && Boolean(built.html);
    if (fullDay && token !== state.listRefreshToken) return;
    if (fullDay && pageShows(built.html)) {
      syncDayEdges();
      if (pendingPaint?.token === token && pendingPaint.fullDay) pendingPaint = null;
      return;
    }
    if (!paintBlocked()) {
      if (fullDay && token !== state.listRefreshToken) return;
      pendingPaint = null;
      const page = contentEl.querySelector("[data-page='current']");
      paintDay(built, { keepScroll: keepScroll || (page?.scrollTop || 0) > 0 });
      return;
    }
    pendingPaint = { built, token, keepScroll, fullDay };
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

  function cachedItemsForActiveDay() {
    return dayCache.get(state.activeDay)?.items ?? null;
  }

  function getCachedDayItem(placeId) {
    const items = cachedItemsForActiveDay();
    return items?.find((i) => i.place?.id === placeId) ?? null;
  }

  async function ensureDayItemsInCache() {
    if (!dayCache.has(state.activeDay)) {
      if (!warmPlaces) warmPlaces = await getPlacesForVacation(id);
      await mergeDayBundleFromRemote(state.activeDay, warmPlaces);
    }
    return cachedItemsForActiveDay() || [];
  }

  async function getDayItemFromCacheOrRemote(placeId) {
    const hit = getCachedDayItem(placeId);
    if (hit) return hit;
    if (!warmPlaces) warmPlaces = await getPlacesForVacation(id);
    await mergeDayBundleFromRemote(state.activeDay, warmPlaces);
    const again = getCachedDayItem(placeId);
    if (again) return again;
    const items = await loadDayPlacesEnriched(id, state.activeDay, warmPlaces);
    return items.find((i) => i.place?.id === placeId) ?? null;
  }

  function repaintSelectionCards(prevId, nextId) {
    const ids = [...new Set([prevId, nextId].filter(Boolean))];
    if (!ids.length) return;
    const page = contentEl.querySelector("[data-page='current']");
    if (!page) return;
    const scrollTop = page.scrollTop;
    let built = warmHtml.get(state.activeDay);
    if (!built) built = { thumbUrls: state.thumbUrls || {} };
    for (const pid of ids) {
      const patch = patchPlaceListForDay(built, pid, { keepScroll: true });
      patch?.patchDom?.(page);
    }
    applySelectionDom();
    page.scrollTop = scrollTop;
  }

  function applySelectionDom() {
    const selectedId = state.selectedByDay[state.activeDay];
    const page = contentEl.querySelector("[data-page='current']");
    const host = page?.querySelector(".place-list");
    if (!host) return;
    for (const oc of host.querySelectorAll(".oc[data-place-id]")) {
      const pid = oc.dataset.placeId;
      oc.classList.toggle("oc--selected", pid === selectedId);
      oc.classList.toggle("oc--dim", Boolean(selectedId && pid !== selectedId));
      oc.querySelector(".pinb")?.classList.toggle("pinb--selected", pid === selectedId);
    }
  }

  function patchPlaceListForDay(built, placeId, { keepScroll } = {}) {
    const dayIso = state.activeDay;
    const bundle = dayCache.get(dayIso);
    if (!bundle?.items?.length || !built?.thumbUrls) return null;
    const item = bundle.items.find((entry) => entry.place?.id === placeId);
    if (!item) return null;
    const pageNow = contentEl.querySelector("[data-page='current']");
    const listHost = pageNow?.querySelector(".place-list");
    if (!listHost || !listHost.querySelector(`[data-place-id="${CSS.escape(placeId)}"]`)) {
      return null;
    }
    const active = dayIso === state.activeDay;
    const selectedId = state.selectedByDay[dayIso];
    const selecting = state.photoSelecting;
    const visibleIds = visibleThumbMediaIds(bundle.items, selectedId);
    if (selecting) {
      const card = bundle.items.find((entry) => entry.place.id === selectedId);
      for (const entry of card?.media || []) {
        if ((entry.uploadStatus || "uploaded") === "uploaded") visibleIds.add(entry.id);
      }
    }
    const itemMedia = item.media || [];
    for (const m of itemMedia) {
      if (!visibleIds.has(m.id) || !m.id) continue;
      const desired = built.thumbUrls[m.id];
      if (desired && thumbPool[m.id] !== desired) thumbPool[m.id] = desired;
    }
    return {
      thumbUrls: built.thumbUrls || {},
      patchDom: (page) => {
        const host = page.querySelector(".place-list");
        if (!host) return;
        const li = host.querySelector(`[data-place-id="${CSS.escape(placeId)}"]`)?.closest("li");
        if (!li) return;
        const roleNow = tripRoleNow;
        const canEditMedia = canAddOwn(roleNow);
        const liHtml = renderPlaceCardHtml(item, {
          selectedId,
          notesExpanded: active ? state.notesExpanded : new Set(),
          thumbUrls: built.thumbUrls,
          canEditMedia,
          freshPlaceIds: state.freshPlaceIds,
          share,
          canEditPlace: (place) => canEditItem(roleNow, place, state.userId),
          canEditNotesInPlace,
          readOnlyTrip: tripReadOnly,
          photoSelect: {
            active: selecting,
            selectedIds: state.photoSelected || new Set(),
            userId: state.userId,
          },
        });
        const wrap = document.createElement("div");
        wrap.innerHTML = liHtml.trim();
        const nextLi = wrap.firstElementChild;
        if (!nextLi) return;
        const oldArticle = li.querySelector(`.oc[data-place-id="${CSS.escape(placeId)}"]`);
        const newArticle = nextLi.querySelector(`.oc[data-place-id="${CSS.escape(placeId)}"]`);
        if (oldArticle && newArticle) {
          const imgByKey = new Map();
          for (const img of oldArticle.querySelectorAll("img")) {
            const key = imgReuseMediaId(img);
            if (key) imgByKey.set(key, img);
          }
          oldArticle.className = newArticle.className;
          oldArticle.innerHTML = newArticle.innerHTML;
          for (const img of oldArticle.querySelectorAll("img")) {
            const key = imgReuseMediaId(img);
            const prev = key ? imgByKey.get(key) : null;
            if (prev && prev.getAttribute("src") === img.getAttribute("src")) {
              img.replaceWith(prev);
            }
          }
        }
        applySelectionDom();
        bindBrokenThumbs(contentEl);
        if (!keepScroll) return;
        page.scrollTop = page.scrollTop;
      },
    };
  }

  function patchMultiplePlaceCards(built, placeIds, { keepScroll } = {}) {
    const patches = placeIds
      .map((pid) => patchPlaceListForDay(built, pid, { keepScroll }))
      .filter((patch) => patch?.patchDom);
    if (!patches.length) return null;
    const thumbUrls = { ...(built.thumbUrls || {}) };
    for (const patch of patches) Object.assign(thumbUrls, patch.thumbUrls || {});
    return {
      thumbUrls,
      patchDom: (page) => {
        for (const patch of patches) patch.patchDom(page);
      },
    };
  }

  async function refreshDayListOnce({
    reuse = false,
    placeId = null,
    placeIds = null,
    mergeTrip = false,
    bundleFresh = false,
  } = {}) {
    const token = ++state.listRefreshToken;
    const patchIds =
      placeIds?.length > 1 ? placeIds : placeId ? [placeId] : [];
    if (state.moveBusy && patchIds.length) return;
    const keepScroll = reuse || patchIds.length > 0;
    try {
      await maybeSoftOnOpen();
      if (token !== state.listRefreshToken) return;
      if (!warmPlaces) warmPlaces = await getPlacesForVacation(id);
      if (token !== state.listRefreshToken) return;
      if (patchIds.length) {
        const daysTouched = new Set();
        for (const pid of patchIds) {
          const placeRow = await getPlace(pid);
          if (!placeRow) continue;
          const list = warmPlaces || [];
          warmPlaces = list.some((p) => p.id === pid)
            ? list.map((p) => (p.id === pid ? placeRow : p))
            : [...list, placeRow];
          const dayIso = placeRow.day || placeRow.dayDate;
          if (dayIso) daysTouched.add(String(dayIso).slice(0, 10));
        }
        for (const dayIso of daysTouched) {
          if (dayIso !== state.activeDay && patchIds.length <= 1) continue;
          if (patchIds.length > 1) {
            const onDay = patchIds.filter((pid) => {
              const row = warmPlaces.find((p) => p.id === pid);
              const d = String(row?.day || row?.dayDate || "").slice(0, 10);
              return d === dayIso;
            });
            if (!state.moveBusy) {
              await refreshPlaceItemsInCache(dayIso, onDay.length ? onDay : patchIds, warmPlaces);
            }
          } else if (bundleFresh) {
            await refreshPlaceItemsInCache(dayIso, patchIds, warmPlaces);
          } else {
            await mergeDayBundleFromRemote(dayIso, warmPlaces);
          }
        }
        placeId = patchIds[patchIds.length - 1];
        if (mergeTrip) {
          try {
            const next = await getVacation(id);
            if (next) {
              vacation = next;
              mergeVacationInLocalList(next);
            }
          } catch {
            /* ignorieren */
          }
        }
      } else if (!reuse) {
        clearWarm();
        warmPlaces = await getPlacesForVacation(id);
      }
      if (token !== state.listRefreshToken) return;
      const dayBuildOpts = {
        selection: false,
        fresh: patchIds.length === 1 && Boolean(placeId),
      };
      if (patchIds.length > 1) dayBuildOpts.fresh = false;
      let built = await buildDayHtml(state.activeDay, warmPlaces, dayBuildOpts);
      if (token !== state.listRefreshToken) {
        revokeThumbUrls(built?.thumbUrls);
        return;
      }
      if (built?.stale) {
        built = await buildDayHtml(state.activeDay, warmPlaces, dayBuildOpts);
      }
      if (!built?.stale) warmHtml.set(state.activeDay, built);
      if (!contentEl.isConnected) return;
      if (patchIds.length > 1) {
        const multiPatch = patchMultiplePlaceCards(built, patchIds, { keepScroll });
        if (multiPatch?.patchDom) queuePaint(multiPatch, token, { keepScroll });
      } else if (placeId) {
        const patch = patchPlaceListForDay(built, placeId, { keepScroll });
        if (patch?.patchDom) queuePaint(patch, token, { keepScroll });
      } else {
        if (!built?.html) return;
        const view = state.photoSelecting
          ? await buildDayHtml(state.activeDay, warmPlaces, { selection: true })
          : built;
        queuePaint(view?.html && !view.stale ? view : built, token, { keepScroll });
      }
      persistSelection(id, state);
      if (token !== state.listRefreshToken || !contentEl.isConnected) return;
      void prefetchNeighbors(token);
      scheduleIdleNeighborPrefetch();
    } catch {
      if (token !== state.listRefreshToken || !contentEl.isConnected) return;
      showDayLoadError();
      if (patchIds.length) {
        showWarnToast("Neu laden hat nicht geklappt. Bitte gleich nochmal versuchen.");
      }
    }
  }

  let listRefreshQueued = null;

  async function refreshDayList(opts = {}) {
    listRefreshQueued = { ...(listRefreshQueued || {}), ...opts };
    if (!listRefreshInflight) {
      listRefreshInflight = (async () => {
        while (listRefreshQueued) {
          const runOpts = listRefreshQueued;
          listRefreshQueued = null;
          await refreshDayListOnce(runOpts);
        }
      })().finally(() => {
        listRefreshInflight = null;
        if (listRefreshQueued) void refreshDayList();
      });
    }
    return listRefreshInflight;
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
        onDone: () => refreshDayList({ reuse: true, placeId: r.place?.id, mergeTrip: true }),
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
        onDone: () => refreshDayList({ reuse: true, mergeTrip: true }),
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
    const items = await ensureDayItemsInCache();
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
        const list = await ensureDayItemsInCache();
        return list.map((i) => i.place).filter((p) => !p.soft);
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
      onSaved: async (captureResult) => {
        if (captureResult?.toast?.line) {
          showCaptureResultToast(captureResult, "note");
        }
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
    if (tripReadOnly) return;
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
      if (!warmPlaces) warmPlaces = await getPlacesForVacation(id);
      const blockedPlaceId = chosen.every((media) => media.placeId === chosen[0].placeId) ? chosen[0].placeId : null;
      const place = await openPhotoMoveSheet({
        vacation,
        places: warmPlaces.filter((entry) => !entry.soft),
        initialDay: state.activeDay,
        blockedPlaceId,
        onDismiss: () => {
          void exitPhotoSelect({ fromPop: true });
        },
      });
      if (!place || !contentEl.isConnected) return;
      const targetDay = place.day || place.dayDate;
      if (!targetDay || chosen.every((media) => media.placeId === place.id)) return;
      const previous = chosen.map((media) => ({ id: media.id, placeId: media.placeId, day: media.day }));
      const sourceDays = [...new Set(previous.map((snap) => snap.day).filter(Boolean))];
      await movePhotosToPlace(chosen, { ...place, vacationId: place.vacationId || id });
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
    if (tripReadOnly) return;
    if (!state.photoSelecting && event.target.closest("[data-kr-tip]")) return;
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
    if (!state.photoSelecting && e.target.closest("[data-kr-tip]")) return;
    if (suppressTileClick) {
      suppressTileClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
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
      const host = e.target.closest(".oc[data-place-id]");
      const placeId = host?.dataset.placeId;
      if (placeId && placeId !== state.selectedByDay[state.activeDay]) {
        state.selectedByDay[state.activeDay] = placeId;
        persistSelection(id, state);
        applySelectionDom();
        return;
      }
      const status = tile.dataset.uploadStatus || "uploaded";
      if (status !== "uploaded") {
        return;
      }
      if (!placeId) return;
      const item = await getDayItemFromCacheOrRemote(placeId);
      if (!item) return;
      const viewable = filterViewableMedia(item.media);
      const role = tripRoleNow;
      openMediaViewer(viewable, tile.dataset.mediaId, {
        canDelete: (entry) => canEditItem(role, entry, state.userId),
        canEditCaption: (entry) => canCaptionMedia(entry, role, state.userId),
        onChanged: () => refreshDayList({ reuse: true, placeId, mergeTrip: true }),
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
        const role = tripRoleNow;
        if (!media || !canCaptionMedia(media, role, state.userId)) return;
        await openPhotoCaptionSheet({
          media,
          onSaved: () => refreshDayList({ reuse: true, placeId: media.placeId, mergeTrip: true }),
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
      const item = await getDayItemFromCacheOrRemote(placeId);
      if (!item) return;
      const viewable = filterViewableMedia(item.media);
      const role = tripRoleNow;
      openMediaViewer(viewable, mediaId, {
        canDelete: (entry) => canEditItem(role, entry, state.userId),
        canEditCaption: (entry) => canCaptionMedia(entry, role, state.userId),
        onChanged: () => refreshDayList({ reuse: true, placeId, mergeTrip: true }),
      });
      return;
    }

    const retryMedia = e.target.closest('[data-action="retry-media-load"]');
    if (retryMedia) {
      await refreshDayList({ reuse: true });
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
        applySelectionDom();
        return;
      }
    }

    const editNoteBtn = e.target.closest('[data-action="edit-note"]');
    if (editNoteBtn) {
      const noteRow = editNoteBtn.closest("[data-note-id]");
      const placeHost = e.target.closest(".oc[data-place-id]");
      if (!noteRow || !placeHost) return;
      const placeId = placeHost.dataset.placeId;
      const prevSelected = state.selectedByDay[state.activeDay];
      if (placeId !== prevSelected) {
        state.selectedByDay[state.activeDay] = placeId;
        persistSelection(id, state);
        applySelectionDom();
        repaintSelectionCards(prevSelected, placeId);
      }
      hydratePlaceNotesInBundleFromCache(placeId, state.activeDay);
      let item = getCachedDayItem(placeId);
      let note =
        item?.notes?.find((n) => n.id === noteRow.dataset.noteId) ||
        (readCache()?.notes?.[id] || []).find((n) => n.id === noteRow.dataset.noteId);
      if (!note || !item) {
        const items = await ensureDayItemsInCache();
        item = items.find((i) => i.place.id === placeId);
        note = note || item?.notes?.find((n) => n.id === noteRow.dataset.noteId);
      }
      if (!note || !item) return;
      openNoteSheet({
        place: item.place,
        vacationId: id,
        vacation,
        day: state.activeDay,
        dayIndex: dayIndexInTrip(vacation, state.activeDay),
        placesForDay: async () => {
          const list = await ensureDayItemsInCache();
          return list.map((i) => i.place).filter((p) => !p.soft);
        },
        note,
        onSaved: () => {},
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
        hydrateFreeNotesInBundleFromCache(state.activeDay);
        patchFreeNotesDom();
        return;
      }
      if (e.target.closest('[data-action="collapse-free-notes"]')) {
        state.freeNotesExpanded = false;
        hydrateFreeNotesInBundleFromCache(state.activeDay);
        patchFreeNotesDom();
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
            const list = await ensureDayItemsInCache();
            return list.map((i) => i.place).filter((p) => !p.soft);
          },
          note: note || undefined,
          onSaved: () => {},
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
      const item = await getDayItemFromCacheOrRemote(placeId);
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
          const list = await ensureDayItemsInCache();
          return list.map((i) => i.place).filter((p) => !p.soft);
        },
        onSaved: () => {},
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
      const item = await getDayItemFromCacheOrRemote(placeId);
      if (!item) return;
      if (editBtn) {
        openEditPlaceSheet(item.place, {
          onSaved: async () => refreshDayList({ reuse: true, placeId: item.place.id, mergeTrip: true }),
          onDeleted: async (pid) => {
            if (state.selectedByDay[state.activeDay] === pid) {
              delete state.selectedByDay[state.activeDay];
            }
            await refreshDayList({ reuse: true, mergeTrip: true });
          },
        });
      } else if (expandBtn) {
        state.notesExpanded.add(placeId);
        repaintSelectionCards(null, placeId);
      } else if (collapseBtn) {
        state.notesExpanded.delete(placeId);
        repaintSelectionCards(null, placeId);
      }
      return;
    }

    const soft = e.target.closest(".soft[data-place-id]");
    if (soft) {
      const placeId = soft.dataset.placeId;
      const item = await getDayItemFromCacheOrRemote(placeId);
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
          await refreshDayList({ reuse: true, placeId: p.id, mergeTrip: true });
        },
        onDiscarded: async () => refreshDayList({ reuse: true, mergeTrip: true }),
      });
      return;
    }

    const card = e.target.closest(".oc[data-place-id]");
    if (card) {
      const prev = state.selectedByDay[state.activeDay];
      const next = card.dataset.placeId;
      if (prev !== next) {
        state.selectedByDay[state.activeDay] = next;
        persistSelection(id, state);
        applySelectionDom();
        repaintSelectionCards(prev, next);
      } else {
        applySelectionDom();
      }
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
  syncDayEdges();
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
      onDone: () => refreshDayList({ reuse: true, mergeTrip: true }),
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
    readOnly: tripReadOnly,
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

  window.__vacrecapTripListPatch = async () => {
    const waits = [];
    if (listRefreshInflight) waits.push(listRefreshInflight);
    if (placePatchInflight) waits.push(placePatchInflight);
    if (waits.length) await Promise.all(waits);
    for (let i = 0; i < 24; i++) {
      flushPendingPaint();
      if (!pendingPaint && !paintBlocked()) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
}

