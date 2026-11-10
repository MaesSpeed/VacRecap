import {
  deletePlaceCascade,
  getMediaForPlace,
  getNotesForPlace,
  getVacation,
  updateMediaPlacement,
} from "./db.js";
import { bindOverlay, closeOverlayHistory, releaseOverlayHistory } from "./overlay-stack.js";
import { promoteSoftPlace, updatePlaceDetails } from "./place-service.js";
import { timestampForDayTime } from "./day-parts.js";
import { dayIndexInTrip, vacationDays } from "./days.js";
import { formatTimeFromTs } from "./geo.js";
import { moveNoteToPlace } from "./note-service.js";
import { openConfirmDialog } from "./ui-confirm.js";
import { openNoteSheet } from "./ui-note-sheet.js";
import { showToast } from "./toast.js";
import { StaleWriteError } from "./cloud-errors.js";
import { decideStaleWrite } from "./save-conflict.js";
import { waypointRowToPlace } from "./cloud-mappers.js";
import { watchPresence, presenceBannerHtml } from "./trip-presence.js";
import { normalizePlace } from "./places.js";
import { PHOTO_CAPTION_ICON } from "./ui-photo-caption-sheet.js";
import { escapeHtml, formatDatePart } from "./utils.js";

const CHEVRON = `<svg class="place-edit-day__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const WHEEL_ROW = 40;

function fotoLabel(count) {
  return count === 1 ? "1 Foto" : `${count} Fotos`;
}

function sameClockOnDay(day, sourceTs) {
  const src = new Date(Number(sourceTs));
  if (!day || Number.isNaN(src.getTime())) return null;
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(src.getHours(), src.getMinutes(), src.getSeconds(), src.getMilliseconds());
  return date.getTime();
}

function dayOptionLabel(days, day) {
  const index = days.indexOf(day);
  const n = index >= 0 ? index + 1 : 1;
  const date = day ? formatDatePart(day, false) : "";
  return date ? `${date} · ${n}. Tag` : `${n}. Tag`;
}

function noteCountLabel(count) {
  if (count === 1) return "1 Notiz";
  return `${count} Notizen`;
}

export function openEditPlaceSheet(place, { onSaved, onDeleted }) {
  const overlay = document.getElementById("overlay-root");
  let initialName = String(place.name || "").trim();
  let initialTime = formatTimeFromTs(place.ts);
  let initialDay = place.day || place.dayDate || "";
  let selectedDay = initialDay;
  let tripDays = initialDay ? [initialDay] : [];
  let vacation = null;
  let wheelOpen = false;
  let wheelLock = false;
  let saving = false;
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="sheet sheet--place-edit" data-testid="place-edit-sheet">
      <header class="sheet__header">
        <h2 class="sheet__title">Ort bearbeiten</h2>
      </header>
      <div data-role="place-presence"></div>
      <label class="field">
        <span class="field__label">Name</span>
        <input type="text" data-role="name" maxlength="200" value="${escapeHtml(place.name)}" />
      </label>
      <div class="place-edit-when">
        <label class="field place-edit-when__time">
          <span class="field__label" for="edit-place-time">Uhrzeit</span>
          <input id="edit-place-time" type="time" step="60" data-testid="edit-place-time" value="${escapeHtml(initialTime)}" />
        </label>
        <div class="field place-edit-when__day">
          <span class="field__label" id="edit-place-day-label">Tag</span>
          <button type="button" class="place-edit-day" data-testid="edit-place-day" data-action="toggle-day" aria-labelledby="edit-place-day-label" aria-expanded="false" aria-controls="place-day-wheel">
            <span class="place-edit-day__label" data-role="day-label"></span>
            ${CHEVRON}
          </button>
        </div>
      </div>
      <div class="place-day-wheel" id="place-day-wheel" data-testid="place-day-wheel" hidden>
        <div class="place-day-wheel__pill" aria-hidden="true"></div>
        <div class="place-day-wheel__scroller" data-role="day-wheel" role="listbox" aria-label="Tag"></div>
      </div>
      <button type="button" class="place-edit-note" data-action="place-note" data-testid="place-note-row">
        <span class="place-edit-note__icon" aria-hidden="true">${PHOTO_CAPTION_ICON}</span>
        <span>Notiz zum Ort</span>
      </button>
      <div class="sheet-actions place-edit-actions">
        <button type="button" class="btn btn-emaille btn-emaille--block" data-action="save" disabled>Speichern</button>
        <div class="place-edit-actions__row">
          <button type="button" class="btn place-edit-actions__cancel" data-action="cancel">Abbrechen</button>
          <button type="button" class="btn place-edit-actions__delete" data-action="delete">Löschen</button>
        </div>
      </div>
    </div>
  `;

  const stopPresence = place?.vacationId
    ? watchPresence(place.vacationId, place.id ? `place:${place.id}` : "place:new", (rows) => {
        const host = overlay.querySelector('[data-role="place-presence"]');
        if (host) host.innerHTML = presenceBannerHtml(rows);
      })
    : () => {};

  const close = () => {
    stopPresence();
    overlay.hidden = true;
    overlay.innerHTML = "";
  };

  const activeClose = bindOverlay(overlay, close);

  const input = overlay.querySelector('[data-role="name"]');
  const timeInput = overlay.querySelector('[data-testid="edit-place-time"]');
  const saveBtn = overlay.querySelector('[data-action="save"]');
  const dayBtn = overlay.querySelector('[data-testid="edit-place-day"]');
  const dayLabelEl = overlay.querySelector('[data-role="day-label"]');
  const wheel = overlay.querySelector('[data-testid="place-day-wheel"]');
  const scroller = overlay.querySelector('[data-role="day-wheel"]');

  const chosenTs = () => {
    if (timeInput.value === initialTime && selectedDay === initialDay) return place.ts;
    if (timeInput.value === initialTime) return sameClockOnDay(selectedDay, place.ts);
    return timestampForDayTime(selectedDay, timeInput.value);
  };
  const syncSave = () => {
    if (saving) return;
    const name = input.value.trim();
    const ts = chosenTs();
    const changed = name !== initialName || timeInput.value !== initialTime || selectedDay !== initialDay;
    saveBtn.disabled = !name || ts == null || !changed;
  };
  const syncDayLabel = () => {
    dayLabelEl.textContent = dayOptionLabel(tripDays, selectedDay);
  };
  const highlightWheel = () => {
    const index = Math.max(0, tripDays.indexOf(selectedDay));
    scroller.querySelectorAll("[data-day]").forEach((item, i) => {
      const on = i === index;
      item.classList.toggle("place-day-wheel__item--active", on);
      item.setAttribute("aria-selected", on ? "true" : "false");
    });
  };
  const scrollWheelTo = (day, { smooth = false } = {}) => {
    const index = Math.max(0, tripDays.indexOf(day));
    wheelLock = true;
    scroller.scrollTo({ top: index * WHEEL_ROW, behavior: smooth ? "smooth" : "auto" });
    requestAnimationFrame(() => {
      wheelLock = false;
    });
  };
  const paintWheel = () => {
    const pad = `<div class="place-day-wheel__pad" aria-hidden="true"></div>`;
    scroller.innerHTML =
      pad +
      tripDays
        .map(
          (day) =>
            `<button type="button" class="place-day-wheel__item" role="option" data-day="${escapeHtml(day)}">${escapeHtml(dayOptionLabel(tripDays, day))}</button>`
        )
        .join("") +
      pad;
    highlightWheel();
    scrollWheelTo(selectedDay);
  };
  const setWheelOpen = (open) => {
    wheelOpen = open;
    wheel.hidden = !open;
    dayBtn.classList.toggle("place-edit-day--open", open);
    dayBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      paintWheel();
      requestAnimationFrame(() => scrollWheelTo(selectedDay));
    }
  };
  const selectDay = (day, { scroll = false } = {}) => {
    if (!day || !tripDays.includes(day)) return;
    selectedDay = day;
    syncDayLabel();
    highlightWheel();
    syncSave();
    if (scroll) scrollWheelTo(day, { smooth: true });
  };

  syncDayLabel();
  paintWheel();
  input.addEventListener("input", syncSave);
  timeInput.addEventListener("input", syncSave);
  syncSave();

  dayBtn.addEventListener("click", () => setWheelOpen(!wheelOpen));
  scroller.addEventListener("click", (event) => {
    const item = event.target.closest("[data-day]");
    if (!item) return;
    selectDay(item.dataset.day, { scroll: true });
  });
  let wheelTimer = 0;
  const applyWheelScroll = () => {
    if (wheelLock || !wheelOpen) return;
    const index = Math.max(0, Math.min(tripDays.length - 1, Math.round(scroller.scrollTop / WHEEL_ROW)));
    const day = tripDays[index];
    if (day && day !== selectedDay) selectDay(day);
    else highlightWheel();
  };
  scroller.addEventListener(
    "scroll",
    () => {
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(applyWheelScroll, 80);
    },
    { passive: true }
  );
  scroller.addEventListener("scrollend", applyWheelScroll);

  void getVacation(place.vacationId)
    .then((loaded) => {
      if (!overlay.isConnected) return;
      vacation = loaded;
      const days = loaded ? vacationDays(loaded) : [];
      if (!days.length) return;
      tripDays = days.includes(initialDay) || !initialDay ? days : [initialDay, ...days];
      if (!tripDays.includes(selectedDay)) selectedDay = tripDays[0];
      syncDayLabel();
      if (wheelOpen || scroller.childElementCount) paintWheel();
    })
    .catch(() => {});

  overlay.querySelector('[data-action="cancel"]').addEventListener("click", () =>
    closeOverlayHistory(activeClose)
  );

  async function moveAttachments(day) {
    const [media, notes] = await Promise.all([
      getMediaForPlace(place.id),
      getNotesForPlace(place.id),
    ]);
    await Promise.all([
      ...media
        .filter((item) => item?.id && String(item.day || "").slice(0, 10) !== day)
        .map((item) =>
          updateMediaPlacement(item.id, {
            waypointId: place.id,
            day,
            remoteUpdatedAt: item.remoteUpdatedAt || null,
          })
        ),
      ...notes
        .filter((note) => note?.id && String(note.day || "").slice(0, 10) !== day)
        .map((note) => moveNoteToPlace(note, { id: place.id }, { day, vacationId: place.vacationId })),
    ]);
  }

  // mergePlaceInMemory lässt den Ort im alten Tag liegen. Ein unbekannter
  // Lösch-Marker trifft den vorhandenen Voll-Refresh von publishSaved genau einmal,
  // ohne ein zweites data-changed.
  async function publish(updated, dayMoved) {
    if (!dayMoved) {
      await onSaved?.(updated);
      return;
    }
    await onSaved?.({ deleted: true, id: `day-move:${updated.id}` });
  }

  async function commitSave(force = false) {
    if (saving || saveBtn.disabled) return;
    saving = true;
    saveBtn.disabled = true;
    const dayMoved = selectedDay !== initialDay;
    try {
      const updated = await updatePlaceDetails(force ? { ...place, forceSave: true } : place, {
        name: input.value,
        ts: chosenTs(),
        day: selectedDay,
      });
      if (dayMoved) await moveAttachments(selectedDay);
      await publish(updated, dayMoved);
      closeOverlayHistory(activeClose);
      showToast("Gespeichert");
    } catch (err) {
      saving = false;
      if (!(err instanceof StaleWriteError)) {
        syncSave();
        showToast(err?.message || "Speichern fehlgeschlagen.");
        return;
      }
      const decision = await decideStaleWrite(err, { tripId: place.vacationId });
      if (decision === "force" && !force) {
        syncSave();
        await commitSave(true);
        return;
      }
      syncSave();
      if (decision === "force") {
        showToast("Speichern fehlgeschlagen.");
        return;
      }
      if (decision === "reload" && err.fresh) {
        const fresh = normalizePlace(waypointRowToPlace(err.fresh));
        place.remoteUpdatedAt = fresh.remoteUpdatedAt;
        place.name = fresh.name;
        place.ts = fresh.ts;
        place.day = fresh.day;
        place.dayDate = fresh.dayDate;
        initialName = String(fresh.name || "").trim();
        initialTime = formatTimeFromTs(fresh.ts);
        initialDay = fresh.day || fresh.dayDate || initialDay;
        selectedDay = initialDay;
        input.value = fresh.name || "";
        timeInput.value = initialTime;
        syncDayLabel();
        if (wheelOpen) paintWheel();
        syncSave();
      }
    }
  }

  overlay.querySelector('[data-action="save"]').addEventListener("click", () => {
    void commitSave(false);
  });
  overlay.querySelector('[data-action="place-note"]').addEventListener("click", async () => {
    const draft = { ...place, name: input.value.trim() || place.name, day: place.day || place.dayDate };
    const vac = vacation || (await getVacation(place.vacationId).catch(() => null));
    const day = draft.day || draft.dayDate || selectedDay;
    releaseOverlayHistory(activeClose);
    openNoteSheet({
      place: draft,
      vacationId: place.vacationId,
      vacation: vac,
      day,
      dayIndex: vac ? dayIndexInTrip(vac, day) : 1,
      placesForDay: async () => {
        const { getPlacesForDay } = await import("./db.js");
        const list = await getPlacesForDay(place.vacationId, day);
        return list.filter((item) => !item.soft);
      },
      onSaved: async (saved) => {
        await onSaved?.(saved);
      },
    });
  });
  overlay.querySelector('[data-action="delete"]').addEventListener("click", async () => {
    const [media, notes] = await Promise.all([
      getMediaForPlace(place.id),
      getNotesForPlace(place.id),
    ]);
    const bits = [];
    if (media.length) bits.push(fotoLabel(media.length));
    if (notes.length) bits.push(noteCountLabel(notes.length));
    const name = input.value.trim() || place.name || "diesen Ort";
    const ok = await openConfirmDialog({
      title: "Ort löschen?",
      message: `Willst du «${name}» wirklich löschen?${bits.length ? ` Enthält ${bits.join(" und ")}.` : ""}`,
      testId: "confirm-delete-place",
      variant: "center",
    });
    if (!ok) return;
    try {
      await deletePlaceCascade(place.id);
    } catch (err) {
      showToast(err?.message || "Der Ort konnte nicht gelöscht werden.");
      return;
    }
    closeOverlayHistory(activeClose);
    showToast("Ort gelöscht");
    onDeleted?.(place.id);
  });
}

export function openSoftPointSheet(place, { vacationId, day, onPromoted, onDiscarded }) {
  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;
  overlay.classList.add("overlay-root--bleed");
  overlay.innerHTML = `
    <div class="sheet sheet--soft-point">
      <header class="sheet__header">
        <h2 class="sheet__title">Weicher Punkt</h2>
      </header>
      <p class="soft-sheet__text">${escapeHtml(place.name || "Unbekannt")}</p>
      <div class="sheet-actions">
        <button type="button" class="btn btn-emaille btn-emaille--block" data-action="promote">Als Ort merken</button>
        <button type="button" class="soft-sheet__discard" data-action="discard">Verwerfen</button>
        <button type="button" class="link-btn" data-action="cancel">Abbrechen</button>
      </div>
    </div>
  `;

  const close = () => {
    overlay.classList.remove("overlay-root--bleed");
    overlay.hidden = true;
    overlay.innerHTML = "";
  };

  const activeClose = bindOverlay(overlay, close);

  overlay.querySelector('[data-action="cancel"]').addEventListener("click", () =>
    closeOverlayHistory(activeClose)
  );
  overlay.querySelector('[data-action="promote"]').addEventListener("click", async () => {
    const result = await promoteSoftPlace(place, { vacationId, day });
    closeOverlayHistory(activeClose);
    onPromoted?.(result.place, result.duplicate);
  });
  overlay.querySelector('[data-action="discard"]').addEventListener("click", async () => {
    const { discardSoftPlace } = await import("./place-service.js");
    await discardSoftPlace(place.id);
    closeOverlayHistory(activeClose);
    onDiscarded?.(place.id);
  });
}
