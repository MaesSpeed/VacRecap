import { deletePlace } from "./db.js";
import { promoteSoftPlace, updatePlaceName } from "./place-service.js";
import { showToast } from "./toast.js";
import { escapeHtml } from "./utils.js";

export function openEditPlaceSheet(place, { onSaved, onDeleted }) {
  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="sheet sheet--place-edit">
      <header class="sheet__header">
        <h2 class="sheet__title">Ort bearbeiten</h2>
      </header>
      <label class="field">
        <span class="field__label">Name</span>
        <input type="text" data-role="name" value="${escapeHtml(place.name)}" />
      </label>
      <div class="sheet-actions">
        <button type="button" class="btn btn-emaille btn-emaille--block" data-action="save">Speichern</button>
        <button type="button" class="link-btn" data-action="cancel">Abbrechen</button>
        <button type="button" class="settings-link settings-link--danger" data-action="delete">Ort löschen</button>
      </div>
    </div>
  `;

  const close = () => {
    overlay.hidden = true;
    overlay.innerHTML = "";
  };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  const input = overlay.querySelector('[data-role="name"]');
  overlay.querySelector('[data-action="cancel"]').addEventListener("click", close);
  overlay.querySelector('[data-action="save"]').addEventListener("click", async () => {
    const updated = await updatePlaceName(place, input.value);
    close();
    showToast("Gespeichert");
    onSaved?.(updated);
  });
  overlay.querySelector('[data-action="delete"]').addEventListener("click", async () => {
    await deletePlace(place.id);
    close();
    showToast("Ort gelöscht");
    onDeleted?.(place.id);
  });
}

export function openSoftPointSheet(place, { onPromoted, onDiscarded }) {
  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="sheet sheet--soft-point">
      <header class="sheet__header">
        <h2 class="sheet__title">Weicher Punkt</h2>
      </header>
      <p class="soft-sheet__text">${escapeHtml(place.name || "Unbekannt")}</p>
      <div class="sheet-actions">
        <button type="button" class="btn btn-emaille btn-emaille--block" data-action="promote">Als Ort merken</button>
        <button type="button" class="settings-link settings-link--danger" data-action="discard">Verwerfen</button>
        <button type="button" class="link-btn" data-action="cancel">Abbrechen</button>
      </div>
    </div>
  `;

  const close = () => {
    overlay.hidden = true;
    overlay.innerHTML = "";
  };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  overlay.querySelector('[data-action="cancel"]').addEventListener("click", close);
  overlay.querySelector('[data-action="promote"]').addEventListener("click", async () => {
    const updated = await promoteSoftPlace(place);
    close();
    showToast("Ort gemerkt");
    onPromoted?.(updated);
  });
  overlay.querySelector('[data-action="discard"]').addEventListener("click", async () => {
    const { discardSoftPlace } = await import("./place-service.js");
    await discardSoftPlace(place.id);
    close();
    onDiscarded?.(place.id);
  });
}
