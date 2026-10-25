import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { createNote, removeNote, updateNoteText } from "./note-service.js";
import { dayRoleLabel, vacationDays } from "./days.js";
import { openConfirmDialog } from "./ui-confirm.js";
import { showToast } from "./toast.js";
import { escapeHtml } from "./utils.js";

const PIN_ICON = `<svg width="18" height="18" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 2.8c-5.8 0-10 4.3-10 9.7 0 6.9 10 15.7 10 15.7s10-8.8 10-15.7c0-5.4-4.2-9.7-10-9.7z" fill="#d4523e"/><circle cx="16" cy="12.6" r="3.8" fill="#fff"/></svg>`;

let saving = false;

export function openNoteSheet({
  place,
  vacationId,
  vacation,
  day,
  dayIndex,
  placesForDay,
  note,
  onSaved,
  onPlaceChange,
}) {
  let activePlace = place;
  const isEdit = Boolean(note);
  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;

  const close = () => {
    overlay.hidden = true;
    overlay.innerHTML = "";
    saving = false;
  };

  function dayRoleLine() {
    if (!vacation || !dayIndex) return `${dayIndex ?? 1}. Tag`;
    const total = vacationDays(vacation).length;
    return dayRoleLabel(dayIndex, total);
  }

  function renderShell() {
    overlay.innerHTML = `
    <div class="sheet sheet--note-draft" data-testid="note-sheet">
      <header class="note-sheet__bar">
        <button type="button" class="note-sheet__cancel" data-action="cancel">Abbrechen</button>
        <h2 class="note-sheet__title">${isEdit ? "Notiz" : "Neue Notiz"}</h2>
        ${
          isEdit
            ? `<button type="button" class="note-sheet__delete" data-action="delete">Löschen</button>`
            : `<button type="button" class="note-sheet__save" data-action="save" disabled>Speichern</button>`
        }
      </header>
      <div class="note-sheet__place" data-role="place-box">
        <span class="note-sheet__pin">${PIN_ICON}</span>
        <div class="note-sheet__place-text">
          <strong data-role="place-name">${escapeHtml(activePlace.name)}</strong>
          <span>Ausgewählte Karte · ${escapeHtml(dayRoleLine())}</span>
        </div>
        <button type="button" class="note-sheet__change" data-action="change-place">Ändern</button>
      </div>
      <label class="field note-sheet__field">
        <textarea data-role="text" rows="5" placeholder="Notiz schreiben…"></textarea>
      </label>
      ${
        isEdit
          ? `<div class="note-sheet__footer-save"><button type="button" class="note-sheet__save note-sheet__save--block" data-action="save" disabled>Speichern</button></div>`
          : ""
      }
    </div>
  `;
  }

  renderShell();
  bindOverlay(overlay, close);

  const textarea = overlay.querySelector('[data-role="text"]');
  const saveBtns = overlay.querySelectorAll('[data-action="save"]');
  if (note) textarea.value = note.text || "";
  textarea.focus();

  const syncSave = () => {
    const ok = Boolean(textarea.value.trim());
    saveBtns.forEach((b) => {
      b.disabled = !ok;
    });
  };
  textarea.addEventListener("input", syncSave);
  syncSave();

  async function tryClose() {
    if (textarea.value.trim() && textarea.value.trim() !== (note?.text || "").trim()) {
      const ok = await openConfirmDialog({
        title: "Verwerfen?",
        message: "Deine Notiz wird nicht gespeichert.",
        confirmLabel: "Verwerfen",
        danger: false,
        testId: "confirm-discard-note",
      });
      if (!ok) return;
    }
    closeOverlayHistory(close);
  }

  overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => void tryClose());

  overlay.querySelector('[data-action="change-place"]')?.addEventListener("click", async () => {
    const places = await placesForDay();
    if (!places.length) return;
    const list = document.createElement("div");
    list.className = "sheet sheet--note-places";
    list.innerHTML = `
      <header class="sheet__header"><h2 class="sheet__title">Karte wählen</h2></header>
      <ul class="note-place-pick">
        ${places
          .map(
            (p) =>
              `<li><button type="button" data-place-id="${p.id}">${escapeHtml(p.name)}</button></li>`
          )
          .join("")}
      </ul>
    `;
    overlay.querySelector(".sheet--note-draft")?.appendChild(list);
    list.querySelectorAll("[data-place-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const picked = places.find((p) => p.id === btn.dataset.placeId);
        if (!picked) return;
        activePlace = picked;
        onPlaceChange?.(picked.id);
        overlay.querySelector('[data-role="place-name"]').textContent = picked.name;
        list.remove();
      });
    });
  });

  saveBtns.forEach((saveBtn) => {
    saveBtn.addEventListener("click", async () => {
      if (saving || saveBtn.disabled) return;
      saving = true;
      const text = textarea.value.trim();
      if (isEdit) {
        await updateNoteText(note, text);
        showToast("Notiz gespeichert");
      } else {
        await createNote({ place: activePlace, vacationId, day, text });
        showToast("Notiz gespeichert");
      }
      closeOverlayHistory(close);
      onSaved?.();
    });
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
      closeOverlayHistory(close);
      showToast("Notiz gelöscht");
      onSaved?.();
    });
  }
}
