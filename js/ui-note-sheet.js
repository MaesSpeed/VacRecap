import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { createNote, removeNote, updateNoteText } from "./note-service.js";
import { showToast } from "./toast.js";

let saving = false;

export function openNoteSheet({ place, vacationId, day, note, onSaved }) {
  const isEdit = Boolean(note);
  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="sheet sheet--note" data-testid="note-sheet">
      <header class="sheet__header">
        <h2 class="sheet__title">${isEdit ? "Notiz bearbeiten" : "Notiz"}</h2>
      </header>
      <label class="field">
        <textarea data-role="text" rows="5" placeholder="Notiz schreiben…"></textarea>
      </label>
      <div class="sheet-actions">
        <button type="button" class="btn btn-emaille btn-emaille--block" data-action="save" disabled>Speichern</button>
        <button type="button" class="link-btn" data-action="cancel">Abbrechen</button>
        ${isEdit ? `<button type="button" class="settings-link settings-link--danger" data-action="delete">Notiz löschen</button>` : ""}
      </div>
    </div>
  `;

  const close = () => {
    overlay.hidden = true;
    overlay.innerHTML = "";
    saving = false;
  };

  bindOverlay(overlay, close);

  const textarea = overlay.querySelector('[data-role="text"]');
  const saveBtn = overlay.querySelector('[data-action="save"]');
  if (note) textarea.value = note.text || "";
  textarea.focus();

  const syncSave = () => {
    saveBtn.disabled = !textarea.value.trim();
  };
  textarea.addEventListener("input", syncSave);
  syncSave();

  overlay.querySelector('[data-action="cancel"]').addEventListener("click", () =>
    closeOverlayHistory(close)
  );

  saveBtn.addEventListener("click", async () => {
    if (saving || saveBtn.disabled) return;
    saving = true;
    const text = textarea.value.trim();
    if (isEdit) {
      await updateNoteText(note, text);
      showToast("Notiz gespeichert");
    } else {
      await createNote({ place, vacationId, day, text });
      showToast("Notiz gespeichert");
    }
    closeOverlayHistory(close);
    onSaved?.();
  });

  const delBtn = overlay.querySelector('[data-action="delete"]');
  if (delBtn) {
    delBtn.addEventListener("click", async () => {
      if (saving) return;
      if (!window.confirm("Notiz löschen?")) return;
      saving = true;
      await removeNote(note.id);
      closeOverlayHistory(close);
      showToast("Notiz gelöscht");
      onSaved?.();
    });
  }
}
