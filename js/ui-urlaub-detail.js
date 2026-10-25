import {
  adjacentDay,
  dayChipDateLine,
  dayRoleLabel,
  defaultActiveDay,
  vacationDays,
} from "./days.js";
import { getVacation } from "./db.js";
import { ICON_CALENDAR, ICON_GEAR, ICON_MAP } from "./icons.js";
import { rememberPlaceFromGps, trySoftPointOnOpen } from "./place-service.js";
import { newestHardPlace } from "./places.js";
import { navigate } from "./router.js";
import { getRememberLocationOnOpen } from "./settings-store.js";
import { showToast } from "./toast.js";
import {
  loadDayPlacesEnriched,
  renderPlaceListHtml,
  wrapPlaceList,
} from "./ui-place-list.js";
import { openEditPlaceSheet, openSoftPointSheet } from "./ui-place-sheets.js";
import { openTripDayCalendar } from "./ui-trip-day-calendar.js";
import { mountTripFooter } from "./ui-trip-footer.js";
import { escapeHtml, todayIso } from "./utils.js";

const tripUiState = new Map();

export function clearTripUiState(vacationId) {
  tripUiState.delete(vacationId);
}

function getState(id, vacation) {
  let state = tripUiState.get(id);
  if (!state) {
    state = {
      activeDay: defaultActiveDay(vacation),
      selectedByDay: {},
      notesExpanded: new Set(),
      openGeoDone: new Set(),
    };
    tripUiState.set(id, state);
  }
  return state;
}

export async function renderUrlaubDetail(appEl, id) {
  const vacation = await getVacation(id);
  if (!vacation) {
    navigate({ name: "urlaube" });
    return;
  }

  const days = vacationDays(vacation);
  const state = getState(id, vacation);

  appEl.className = "screen screen--trip";
  appEl.dataset.vacationId = id;

  appEl.innerHTML = `
    <header class="trip-header">
      <button type="button" class="link-btn link-btn--back" data-action="back">‹ Urlaube</button>
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
      <button type="button" class="day-calendar-btn" data-action="calendar" aria-label="Kalender">${ICON_CALENDAR}</button>
    </div>
    <main class="trip-content trip-content--places" data-role="day-content" data-testid="trip-content"></main>
    <div data-role="footer-mount"></div>
  `;

  const chipsEl = appEl.querySelector('[data-role="chips"]');
  const contentEl = appEl.querySelector('[data-role="day-content"]');
  const footerMount = appEl.querySelector('[data-role="footer-mount"]');

  function renderChips() {
    const total = days.length;
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
    await maybeSoftOnOpen();
    const items = await loadDayPlacesEnriched(id, state.activeDay);
    const selectedId = await ensureSelectedForDay(items);

    if (items.length === 0) {
      contentEl.innerHTML = `
        <div class="trip-empty" data-testid="trip-empty">
          <p class="trip-empty__title">Noch keine Orte heute</p>
          <p class="trip-empty__hint">Ort merken, Foto machen oder Notiz schreiben.</p>
        </div>`;
    } else {
      contentEl.innerHTML = wrapPlaceList(
        renderPlaceListHtml(items, {
          selectedId,
          notesExpanded: state.notesExpanded,
        })
      );
    }
    contentEl.dataset.activeDay = state.activeDay;
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
    if (result.duplicate) {
      state.selectedByDay[state.activeDay] = result.place.id;
      showToast(`Schon gemerkt: ${result.place.name}`);
    } else {
      state.selectedByDay[state.activeDay] = result.place.id;
      showToast("Ort gemerkt");
    }
    await refreshDayList();
  }

  contentEl.addEventListener("click", async (e) => {
    const editBtn = e.target.closest('[data-action="edit-place"]');
    const camBtn = e.target.closest('[data-action="camera-place"]');
    const expandBtn = e.target.closest('[data-action="expand-notes"]');
    if (editBtn || camBtn || expandBtn) {
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
      } else if (camBtn) {
        showToast("Kommt im nächsten Schritt");
      } else if (expandBtn) {
        state.notesExpanded.add(placeId);
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
        onPromoted: async (p) => {
          state.selectedByDay[state.activeDay] = p.id;
          await refreshDayList();
        },
        onDiscarded: async () => refreshDayList(),
      });
      return;
    }

    const card = e.target.closest(".oc[data-place-id]");
    if (card && !card.classList.contains("oc--selected")) {
      state.selectedByDay[state.activeDay] = card.dataset.placeId;
      await refreshDayList();
    }
  });

  renderChips();
  await refreshDayList();
  mountTripFooter(footerMount, { onRememberPlace });

  appEl.querySelector('[data-action="back"]').addEventListener("click", () => {
    clearTripUiState(id);
    navigate({ name: "urlaube" });
  });

  appEl.querySelector('[data-action="map"]').addEventListener("click", () => {
    showToast("Kartenansicht kommt in Paket 3b.");
  });

  appEl.querySelector('[data-action="settings"]').addEventListener("click", () => {
    navigate({ name: "urlaub-settings", id });
  });

  appEl.querySelector('[data-action="calendar"]').addEventListener("click", () => {
    openTripDayCalendar({
      vacation,
      activeDay: state.activeDay,
      onSelect: (iso) => setActiveDay(iso),
    });
  });

  chipsEl.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-day]");
    if (chip) setActiveDay(chip.dataset.day);
  });

  bindSwipe(contentEl, shiftDay);
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
