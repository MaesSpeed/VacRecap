import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { createNote, moveNoteToPlace, removeNote, updateNoteText } from "./note-service.js";
import { dayRoleLabel, vacationDays } from "./days.js";
import { openConfirmDialog } from "./ui-confirm.js";
import { CloudNetworkError, CloudOfflineError } from "./cloud-errors.js";
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
  resolvePlaceOnSave,
  previewPlaceLabel,
  onSaved,
  onPlaceChange,
}) {
  let activePlace = place;
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
    if (isEdit) return `Notiz · ${dayRoleLine()}`;
    return `Ausgewählte Karte · ${dayRoleLine()}`;
  }

  const initialPlaceName = activePlace?.name ?? "Ort wird beim Speichern gewählt";

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

  if (!isEdit && previewPlaceLabel && !activePlace) {
    void previewPlaceLabel().then((preview) => {
      if (!overlay.isConnected || activePlace) return;
      if (preview?.label) placeNameEl.textContent = preview.label;
    });
  }

  overlay.querySelector('[data-action="change-place"]')?.addEventListener("click", async () => {
    const places = await placesForDay();
    if (!places.length) return;
    const pickLayer = document.createElement("div");
    pickLayer.className = "note-sheet__pick-layer";
    pickLayer.innerHTML = `
      <div class="sheet sheet--note-places">
        <header class="sheet__header"><h2 class="sheet__title">Karte wählen</h2></header>
        <ul class="note-place-pick">
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
    overlay.querySelector(".sheet--note-bottom")?.appendChild(pickLayer);
    pickLayer.querySelector('[data-action="pick-cancel"]').addEventListener("click", () =>
      pickLayer.remove()
    );
    pickLayer.querySelectorAll("[data-place-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const picked = places.find((p) => p.id === btn.dataset.placeId);
        if (!picked) return;
        activePlace = picked;
        onPlaceChange?.(picked.id);
        placeNameEl.textContent = picked.name;
        if (!isEdit) {
          placeSubEl.textContent = `Ausgewählte Karte · ${dayRoleLine()}`;
        }
        pickLayer.remove();
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

      const useGpsResolve = !isEdit && resolvePlaceOnSave && !placeToUse;
      if (useGpsResolve) {
        captureResult = await resolvePlaceOnSave();
        placeToUse = captureResult.place;
      }

      if (!placeToUse && isEdit) {
        placeToUse = activePlace;
      }
      if (!placeToUse) {
        showToast("Kein Ort gewählt");
        return;
      }

      if (isEdit) {
        await updateNoteText(note, text);
        if (placeToUse.id !== note.placeId) {
          await moveNoteToPlace(note, placeToUse, { day, vacationId });
        }
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
        showToast(err?.message || "Notiz konnte nicht gespeichert werden.");
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
