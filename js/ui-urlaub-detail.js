import {
  adjacentDay,
  dayChipDateLine,
  dayIndexInTrip,
  dayRoleLabel,
  defaultActiveDay,
  vacationDays,
} from "./days.js";
import { getVacation } from "./db.js";
import { ICON_BACK_CHEVRON, ICON_GEAR, ICON_MAP } from "./icons.js";
import { rememberPlaceFromGps, trySoftPointOnOpen } from "./place-service.js";
import { newestHardPlace } from "./places.js";
import { leaveTripToOverview, navigate } from "./router.js";
import { getRememberLocationOnOpen } from "./settings-store.js";
import {
  previewNoteCaptureTarget,
  resolveCaptureTarget,
  resolveFooterCaptureTarget,
  resolvePlaceCardCaptureTarget,
} from "./target-place.js";
import { consumePendingFooter } from "./pending-footer.js";
import { loadTripSelection, saveTripSelection } from "./trip-selection-store.js";
import { prefetchCaptureGps, resetCaptureGpsPrefetch } from "./capture-gps-prefetch.js";
import { blockTripFooter, isTripFooterBlocked, SHEET_INPUT_BLOCK_MS } from "./overlay-stack.js";
import { dismissActiveToast, showToast, showTwoLineToast, showWarnToast } from "./toast.js";
import { openNoteSheet } from "./ui-note-sheet.js";
import {
  loadDayPlacesEnriched,
  renderPlaceListHtml,
  resolveThumbUrlMap,
  revokeThumbUrls,
  visibleThumbMediaIds,
  wrapPlaceList,
} from "./ui-place-list.js";
import { openPhotoUploadSheet } from "./ui-photo-upload-sheet.js";
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
      openGeoDone: new Set(),
      captureBusy: false,
      listRefreshToken: 0,
      thumbUrls: {},
    };
    tripUiState.set(id, state);
  }
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

  appEl.className = "screen screen--trip";
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

  const chipsEl = appEl.querySelector('[data-role="chips"]');
  const contentEl = appEl.querySelector('[data-role="day-content"]');
  const footerMount = appEl.querySelector('[data-role="footer-mount"]');
  const capturePhotoInput = appEl.querySelector('[data-role="capture-photo-input"]');
  const captureVideoInput = appEl.querySelector('[data-role="capture-video-input"]');
  const galleryInput = appEl.querySelector('[data-role="gallery-input"]');
  let captureTargetPlaceId = null;

  const VIDEO_LONGPRESS_HINT_KEY = "vacrecap-video-longpress-hint";
  const VIDEO_HINT_AFTER_PHOTO_MS = 3000;

  function renderChips() {
    const total = days.length;
    chipsEl.classList.toggle("day-chips--fill", total <= 4);
    chipsEl.innerHTML = days
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
    requestAnimationFrame(() => {
      chipsEl
        .querySelector(`[data-day="${state.activeDay}"]`)
        ?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    });
  }

  async function ensureSelectedForDay(items) {
    const day = state.activeDay;
    if (state.selectedByDay[day]) return state.selectedByDay[day];
    const hard = items.map((i) => i.place).filter((p) => !p.soft);
    const newest = newestHardPlace(hard);
    if (newest) state.selectedByDay[day] = newest.id;
    return state.selectedByDay[day] ?? null;
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

  async function refreshDayList() {
    const token = ++state.listRefreshToken;
    await maybeSoftOnOpen();
    if (token !== state.listRefreshToken) return;
    const items = await loadDayPlacesEnriched(id, state.activeDay);
    if (token !== state.listRefreshToken) return;
    const selectedId = await ensureSelectedForDay(items);
    if (token !== state.listRefreshToken) return;

    const allMedia = items.flatMap((i) => i.media);
    const visibleIds = visibleThumbMediaIds(items, selectedId);
    const nextThumbUrls = await resolveThumbUrlMap(allMedia, visibleIds);
    const previousThumbUrls = state.thumbUrls;

    let html;
    if (items.length === 0) {
      html = `
        <div class="trip-empty" data-testid="trip-empty">
          <p class="trip-empty__title">Noch keine Orte heute</p>
          <p class="trip-empty__hint">Ort merken, Foto machen oder Notiz schreiben.</p>
        </div>`;
    } else {
      html = wrapPlaceList(
        renderPlaceListHtml(items, {
          selectedId,
          notesExpanded: state.notesExpanded,
          thumbUrls: nextThumbUrls,
        })
      );
    }
    if (token !== state.listRefreshToken) {
      revokeThumbUrls(nextThumbUrls);
      return;
    }
    if (!contentEl.isConnected) {
      revokeThumbUrls(nextThumbUrls);
      return;
    }
    state.thumbUrls = nextThumbUrls;
    contentEl.innerHTML = html;
    contentEl.dataset.activeDay = state.activeDay;
    revokeThumbUrls(previousThumbUrls);
  }

  async function setActiveDay(dayIso) {
    if (!days.includes(dayIso) || dayIso === state.activeDay) return;
    state.activeDay = dayIso;
    renderChips();
    await refreshDayList();
  }

  function shiftDay(direction) {
    const next = adjacentDay(vacation, state.activeDay, direction);
    if (next !== state.activeDay) setActiveDay(next);
  }

  async function onRememberPlace() {
    const result = await rememberPlaceFromGps({
      vacationId: id,
      day: state.activeDay,
    });
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

  async function resolveTargetPlace(mediaKind = "photo") {
    const selectedPlaceId = state.selectedByDay[state.activeDay];
    const r = captureTargetPlaceId
      ? await resolvePlaceCardCaptureTarget({
          vacationId: id,
          day: state.activeDay,
          placeId: captureTargetPlaceId,
          mediaKind,
        })
      : await resolveFooterCaptureTarget({
          vacationId: id,
          day: state.activeDay,
          selectedPlaceId,
          mediaKind,
        });
    state.selectedByDay[state.activeDay] = r.place.id;
    persistSelection(id, state);
    if (r.needsRefresh) await refreshDayList();
    return r;
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

  async function beginPhotoUpload(files) {
    if (!files?.length || state.captureBusy) return;
    state.captureBusy = true;
    appEl.dataset.captureBusy = "1";
    try {
      const r = await resolveTargetPlace("photo");
      openPhotoUploadSheet({
        files,
        place: r.place,
        vacationId: id,
        day: state.activeDay,
        onDone: () => refreshDayList(),
      });
    } catch (err) {
      showWarnToast(err?.message || "Foto konnte nicht zugeordnet werden.");
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
    if (camBtn) {
      const host = e.target.closest(".oc[data-place-id]");
      if (!host) return;
      const placeId = host.dataset.placeId;
      state.selectedByDay[state.activeDay] = placeId;
      persistSelection(id, state);
      openCapturePhotoInput(placeId);
      return;
    }

    const tile = e.target.closest(".tile[data-media-id]");
    if (tile) {
      const placeId = e.target.closest(".oc[data-place-id]")?.dataset.placeId;
      if (!placeId) return;
      const items = await loadDayPlacesEnriched(id, state.activeDay);
      const item = items.find((i) => i.place.id === placeId);
      if (!item) return;
      openMediaViewer(item.media, tile.dataset.mediaId, {
        onChanged: () => refreshDayList(),
      });
      return;
    }

    const noteRowClick = e.target.closest(".nr[data-note-id]");
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

  function openGalleryPicker() {
    if (state.captureBusy || isTripFooterBlocked()) return;
    blockTripFooter(SHEET_INPUT_BLOCK_MS);
    galleryInput.click();
  }

  galleryInput.addEventListener("change", () => {
    const files = [...(galleryInput.files || [])].filter((f) => f.type.startsWith("image/"));
    galleryInput.value = "";
    if (!files.length) return;
    void beginPhotoUpload(files);
  });

  mountTripFooter(footerMount, {
    onRememberPlace,
    onCamera: openNativeCamera,
    onCameraVideo: openNativeVideoCamera,
    onNote: onNoteFooter,
    onGallery: openGalleryPicker,
  });

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

  chipsEl.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-day]");
    if (chip) setActiveDay(chip.dataset.day);
  });

  bindSwipe(contentEl, shiftDay);

  const pendingFooter = consumePendingFooter();
  if (pendingFooter === "note") {
    requestAnimationFrame(() => void onNoteFooter());
  } else if (pendingFooter === "gallery") {
    requestAnimationFrame(() => openGalleryPicker());
  } else if (pendingFooter === "camera") {
    requestAnimationFrame(() => openNativeCamera());
  }
}

function bindSwipe(element, shiftDay) {
  let startX = 0;
  let startY = 0;
  let tracking = false;

  element.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
    },
    { passive: true }
  );

  element.addEventListener("touchend", (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    shiftDay(dx < 0 ? 1 : -1);
  });

  element.addEventListener("mousedown", (e) => {
    startX = e.clientX;
    startY = e.clientY;
    tracking = true;
  });
  element.addEventListener("mouseup", (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    shiftDay(dx < 0 ? 1 : -1);
  });
}
