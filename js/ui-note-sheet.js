import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { createNote, moveNoteToPlace, removeNote, updateNoteText } from "./note-service.js";
import { dayRoleLabel, vacationDays } from "./days.js";
import { openConfirmDialog } from "./ui-confirm.js";
import { CloudNetworkError, CloudOfflineError, noteKeptMessage } from "./cloud-errors.js";
import { showToast, showWarnToast } from "./toast.js";
import { escapeHtml } from "./utils.js";

const PIN_ICON = `<svg width="18" height="18" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 2.8c-5.8 0-10 4.3-10 9.7 0 6.9 10 15.7 10 15.7s10-8.8 10-15.7c0-5.4-4.2-9.7-10-9.7z" fill="#d4523e"/><circle cx="16" cy="12.6" r="3.8" fill="#fff"/></svg>`;

const MIC_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z" stroke="#5B6B7A" stroke-width="1.8"/><path d="M19 11v1a7 7 0 0 1-14 0v-1M12 18v3" stroke="#5B6B7A" stroke-width="1.8" stroke-linecap="round"/></svg>`;

let saving = false;

export function openNoteSheet({
  place,
  vacationId,
  vacation,
  day,
  dayIndex,
  placesForDay,
  note,
  initialFree = false,
  resolvePlaceOnSave,
  previewPlaceLabel,
  onSaved,
  onPlaceChange,
}) {
  let freeChosen = Boolean(initialFree) || (Boolean(note) && !note.placeId);
  let activePlace = freeChosen ? null : place;
  const isEdit = Boolean(note);
  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;
  overlay.classList.add("overlay-root--bleed");

  let kbViewportHandler = null;

  const domClose = () => {
    if (kbViewportHandler) {
      window.visualViewport?.removeEventListener("resize", kbViewportHandler);
      window.visualViewport?.removeEventListener("scroll", kbViewportHandler);
      kbViewportHandler = null;
    }
    overlay.classList.remove("overlay-root--bleed");
    overlay.hidden = true;
    overlay.innerHTML = "";
    saving = false;
  };

  function dayRoleLine() {
    if (!vacation || !dayIndex) return `${dayIndex ?? 1}. Tag`;
    const total = vacationDays(vacation).length;
    return dayRoleLabel(dayIndex, total);
  }

  function placeSubtitle() {
    if (freeChosen) return `Freie Notiz · ${dayRoleLine()}`;
    if (isEdit) return `Notiz · ${dayRoleLine()}`;
    return `Ausgewählte Karte · ${dayRoleLine()}`;
  }

  const initialPlaceName = freeChosen
    ? "Kein Ort / freie Notiz"
    : (activePlace?.name ?? "Ort wird beim Speichern gewählt");

  overlay.innerHTML = `
    <div class="sheet sheet--note-bottom" data-testid="note-sheet">
      <div class="sheet-handle" aria-hidden="true"></div>
      <header class="note-sheet__bar">
        <button type="button" class="note-sheet__cancel" data-action="cancel">Abbrechen</button>
        <h2 class="note-sheet__title">${isEdit ? "Notiz bearbeiten" : "Neue Notiz"}</h2>
        ${
          isEdit
            ? `<button type="button" class="note-sheet__delete" data-action="delete">Löschen</button>`
            : `<span class="note-sheet__spacer" aria-hidden="true"></span>`
        }
      </header>
      <div class="note-sheet__place" data-role="place-box">
        <span class="note-sheet__pin">${PIN_ICON}</span>
        <div class="note-sheet__place-text">
          <strong data-role="place-name">${escapeHtml(initialPlaceName)}</strong>
          <span data-role="place-sub">${escapeHtml(placeSubtitle())}</span>
        </div>
        <button type="button" class="note-sheet__change" data-action="change-place">Ändern</button>
      </div>
      <label class="field note-sheet__field">
        <textarea data-role="text" rows="4" placeholder="Notiz schreiben…"></textarea>
      </label>
      <button type="button" class="note-sheet__dictate" data-action="focus-text">
        <span class="note-sheet__mic">${MIC_ICON}</span>
        <span>Diktieren oder tippen</span>
      </button>
      <button type="button" class="btn btn-emaille btn-emaille--block note-sheet__save-bottom" data-action="save" disabled>Speichern</button>
    </div>
  `;

  const sheetEl = overlay.querySelector(".sheet--note-bottom");

  const syncNoteSheetTop = () => {
    const chips = document.querySelector(".day-chips-wrap");
    if (!chips) return;
    const bottom = chips.getBoundingClientRect().bottom;
    document.documentElement.style.setProperty("--note-sheet-top", `${bottom + 20}px`);
  };

  const syncNoteSheetKb = () => {
    const kb =
      parseInt(getComputedStyle(document.documentElement).getPropertyValue("--kb"), 10) || 0;
    sheetEl?.classList.toggle("sheet--note-kb", kb > 80);
    syncNoteSheetTop();
  };

  syncNoteSheetKb();
  requestAnimationFrame(syncNoteSheetKb);
  kbViewportHandler = () => syncNoteSheetKb();
  window.visualViewport?.addEventListener("resize", kbViewportHandler);
  window.visualViewport?.addEventListener("scroll", kbViewportHandler);

  const textarea = overlay.querySelector('[data-role="text"]');
  const saveBtn = overlay.querySelector('[data-action="save"]');
  const placeNameEl = overlay.querySelector('[data-role="place-name"]');
  const placeSubEl = overlay.querySelector('[data-role="place-sub"]');

  if (note) textarea.value = note.text || "";

  const syncSave = () => {
    saveBtn.disabled = !textarea.value.trim();
  };
  textarea.addEventListener("input", syncSave);
  syncSave();

  const isDirty = () => textarea.value.trim() !== (note?.text || "").trim();

  async function dismissNoteSheet() {
    if (isDirty() && textarea.value.trim()) {
      const ok = await openConfirmDialog({
        title: "Verwerfen?",
        message: "Deine Notiz wird nicht gespeichert.",
        confirmLabel: "Verwerfen",
        danger: false,
        testId: "confirm-discard-note",
      });
      if (!ok) return;
    }
    closeOverlayHistory(activeClose);
  }

  const activeClose = bindOverlay(overlay, domClose, () => dismissNoteSheet());

  overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => void dismissNoteSheet());

  overlay.querySelector('[data-action="focus-text"]').addEventListener("click", () => {
    textarea.focus();
  });

  function syncPlaceLabel() {
    if (freeChosen) {
      placeNameEl.textContent = "Kein Ort / freie Notiz";
      placeSubEl.textContent = `Freie Notiz · ${dayRoleLine()}`;
      return;
    }
    placeNameEl.textContent = activePlace?.name || "Ort wird beim Speichern gewählt";
    placeSubEl.textContent = placeSubtitle();
  }

  if (!isEdit && previewPlaceLabel && !activePlace && !freeChosen) {
    void previewPlaceLabel().then((preview) => {
      if (!overlay.isConnected || activePlace || freeChosen) return;
      if (preview?.label) placeNameEl.textContent = preview.label;
    });
  }

  overlay.querySelector('[data-action="change-place"]')?.addEventListener("click", async () => {
    const places = (await placesForDay()) || [];
    const pickLayer = document.createElement("div");
    pickLayer.className = "note-sheet__pick-layer";
    pickLayer.innerHTML = `
      <div class="sheet sheet--note-places" data-testid="note-place-sheet">
        <div class="sheet-handle" data-role="pick-handle" aria-hidden="true"></div>
        <header class="sheet__header"><h2 class="sheet__title">Karte wählen</h2></header>
        <ul class="note-place-pick" data-role="pick-scroll">
          <li><button type="button" data-action="pick-free" data-testid="pick-free">Kein Ort / freie Notiz</button></li>
          ${places
            .map(
              (p) =>
                `<li><button type="button" data-place-id="${p.id}">${escapeHtml(p.name)}</button></li>`
            )
            .join("")}
        </ul>
        <button type="button" class="link-btn" data-action="pick-cancel">Abbrechen</button>
      </div>
    `;
    sheetEl?.appendChild(pickLayer);
    const closePick = () => {
      if (pickLayer.isConnected) pickLayer.remove();
    };
    pickLayer.querySelector('[data-action="pick-cancel"]').addEventListener("click", closePick);
    bindSubSheetPull(pickLayer.querySelector(".sheet--note-places"), {
      onClose: closePick,
      scrollEl: pickLayer.querySelector("[data-role='pick-scroll']"),
    });
    pickLayer.querySelector('[data-action="pick-free"]')?.addEventListener("click", () => {
      freeChosen = true;
      activePlace = null;
      syncPlaceLabel();
      closePick();
    });
    pickLayer.querySelectorAll("[data-place-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const picked = places.find((p) => p.id === btn.dataset.placeId);
        if (!picked) return;
        freeChosen = false;
        activePlace = picked;
        onPlaceChange?.(picked.id);
        syncPlaceLabel();
        closePick();
      });
    });
  });

  saveBtn.addEventListener("click", async () => {
    if (saving || saveBtn.disabled) return;
    saving = true;
    try {
      const text = textarea.value.trim();
      let captureResult = null;
      let placeToUse = activePlace;

      const useGpsResolve = !freeChosen && !isEdit && resolvePlaceOnSave && !placeToUse;
      if (useGpsResolve) {
        captureResult = await resolvePlaceOnSave();
        placeToUse = captureResult.place;
      }

      if (!placeToUse && isEdit && !freeChosen) {
        placeToUse = activePlace;
      }
      if (!freeChosen && !placeToUse) {
        showToast("Kein Ort gewählt");
        return;
      }

      if (isEdit) {
        const updated = await updateNoteText(note, text);
        const nextPlaceId = freeChosen ? null : placeToUse.id;
        if (nextPlaceId !== (note.placeId || null)) {
          await moveNoteToPlace(updated, freeChosen ? null : placeToUse, { day, vacationId });
        }
        showToast("Notiz gespeichert");
      } else if (freeChosen) {
        await createNote({ place: null, vacationId, day, text });
        showToast("Notiz gespeichert");
      } else {
        await createNote({ place: placeToUse, vacationId, day, text });
        showToast("Notiz gespeichert");
      }
      closeOverlayHistory(activeClose);
      await onSaved?.(captureResult);
    } catch (err) {
      if (err instanceof CloudOfflineError || err instanceof CloudNetworkError) {
        showWarnToast(err.message);
      } else {
        showWarnToast(noteKeptMessage(err));
      }
    } finally {
      saving = false;
    }
  });

  const delBtn = overlay.querySelector('[data-action="delete"]');
  if (delBtn) {
    delBtn.addEventListener("click", async () => {
      if (saving) return;
      const ok = await openConfirmDialog({
        title: "Notiz löschen?",
        message: "Diese Notiz wird unwiderruflich gelöscht.",
        testId: "confirm-delete-note",
      });
      if (!ok) return;
      saving = true;
      await removeNote(note.id);
      closeOverlayHistory(activeClose);
      showToast("Notiz gelöscht");
      onSaved?.();
    });
  }

  requestAnimationFrame(() => textarea.focus());
}

function bindSubSheetPull(sheet, { onClose, scrollEl }) {
  if (!sheet) return;
  let tracking = false;
  let dragging = false;
  let decided = false;
  let startY = 0;
  let startX = 0;
  let lastY = 0;
  let lastT = 0;
  let vel = 0;
  let closed = false;

  const closeOnce = () => {
    if (closed) return;
    closed = true;
    onClose();
  };

  const pullFrom = (target) =>
    Boolean(target?.closest?.("[data-role='pick-handle'], .sheet__header"));

  const begin = (y, x) => {
    tracking = true;
    dragging = false;
    decided = false;
    startY = lastY = y;
    startX = x;
    lastT = performance.now();
    vel = 0;
    sheet.style.transition = "none";
  };

  const move = (y, x, event, target) => {
    if (!tracking || closed) return;
    const dy = y - startY;
    const dx = x - startX;
    if (!decided) {
      if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
      decided = true;
      const fromHandle = pullFrom(target);
      const scrolled = scrollEl && scrollEl.scrollTop > 2;
      dragging = dy > 0 && Math.abs(dy) > Math.abs(dx) && (fromHandle || !scrolled);
    }
    if (!dragging) return;
    if (event?.cancelable) event.preventDefault();
    const pull = Math.max(0, y - startY);
    sheet.style.transform = `translate3d(0px, ${pull}px, 0px)`;
    const now = performance.now();
    const dt = now - lastT;
    if (dt >= 16) {
      vel = (y - lastY) / dt;
      lastY = y;
      lastT = now;
    }
  };

  const end = () => {
    if (!tracking || closed) return;
    tracking = false;
    if (!dragging) return;
    dragging = false;
    const match = /translate3d\(\s*[^,]+,\s*(-?[\d.]+)px/.exec(sheet.style.transform || "");
    const pull = match ? Number(match[1]) : 0;
    if (pull > 72 || (vel > 0.55 && pull > 24)) {
      sheet.style.transition = "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)";
      sheet.style.transform = "translate3d(0, 110%, 0)";
      sheet.addEventListener("transitionend", () => closeOnce(), { once: true });
      setTimeout(closeOnce, 280);
      return;
    }
    sheet.style.transition = "transform 320ms cubic-bezier(0.34, 1.25, 0.64, 1)";
    sheet.style.transform = "translate3d(0, 0, 0)";
  };

  sheet.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1 || closed) return;
      begin(e.touches[0].clientY, e.touches[0].clientX);
      sheet._pullTarget = e.target;
    },
    { passive: true }
  );
  sheet.addEventListener(
    "touchmove",
    (e) => {
      if (!tracking || e.touches.length !== 1) return;
      move(e.touches[0].clientY, e.touches[0].clientX, e, sheet._pullTarget || e.target);
    },
    { passive: false }
  );
  sheet.addEventListener("touchend", end);
  sheet.addEventListener("touchcancel", () => {
    tracking = false;
    dragging = false;
    sheet.style.transition = "transform 320ms cubic-bezier(0.34, 1.25, 0.64, 1)";
    sheet.style.transform = "translate3d(0, 0, 0)";
  });

  sheet.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || e.button !== 0 || closed) return;
    sheet._pullTarget = e.target;
    begin(e.clientY, e.clientX);
  });
  sheet.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch" || !tracking) return;
    move(e.clientY, e.clientX, e, sheet._pullTarget);
  });
  sheet.addEventListener("pointerup", (e) => {
    if (e.pointerType === "touch") return;
    end();
  });
  sheet.addEventListener("pointercancel", () => {
    tracking = false;
    dragging = false;
    sheet.style.transition = "transform 320ms cubic-bezier(0.34, 1.25, 0.64, 1)";
    sheet.style.transform = "translate3d(0px, 0px, 0px)";
  });
}
