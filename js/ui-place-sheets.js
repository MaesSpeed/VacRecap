import {
  deletePlaceCascade,
  getMediaForPlace,
  getNotesForPlace,
} from "./db.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { promoteSoftPlace, updatePlaceName } from "./place-service.js";
import { openConfirmDialog } from "./ui-confirm.js";
import { showToast } from "./toast.js";
import { StaleWriteError } from "./cloud-errors.js";
import { decideStaleWrite } from "./save-conflict.js";
import { waypointRowToPlace } from "./cloud-mappers.js";
import { watchPresence, presenceBannerHtml } from "./trip-presence.js";
import { normalizePlace } from "./places.js";
import { escapeHtml } from "./utils.js";

function mediaCountLabel(count) {
  if (count === 1) return "1 Medium";
  return `${count} Medien`;
}

function noteCountLabel(count) {
  if (count === 1) return "1 Notiz";
  return `${count} Notizen`;
}

export function openEditPlaceSheet(place, { onSaved, onDeleted }) {
  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="sheet sheet--place-edit">
      <header class="sheet__header">
        <h2 class="sheet__title">Ort bearbeiten</h2>
      </header>
      <div data-role="place-presence"></div>
      <label class="field">
        <span class="field__label">Name</span>
        <input type="text" data-role="name" maxlength="200" value="${escapeHtml(place.name)}" />
      </label>
      <div class="sheet-actions">
        <button type="button" class="btn btn-emaille btn-emaille--block" data-action="save" disabled>Speichern</button>
        <button type="button" class="link-btn" data-action="cancel">Abbrechen</button>
        <button type="button" class="settings-link settings-link--danger" data-action="delete">Ort löschen</button>
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
  const saveBtn = overlay.querySelector('[data-action="save"]');
  const syncSave = () => {
    saveBtn.disabled = !input.value.trim();
  };
  input.addEventListener("input", syncSave);
  syncSave();

  overlay.querySelector('[data-action="cancel"]').addEventListener("click", () =>
    closeOverlayHistory(activeClose)
  );
  overlay.querySelector('[data-action="save"]').addEventListener("click", async () => {
    if (saveBtn.disabled) return;
    try {
      const updated = await updatePlaceName(place, input.value);
      closeOverlayHistory(activeClose);
      showToast("Gespeichert");
      onSaved?.(updated);
    } catch (err) {
      if (!(err instanceof StaleWriteError)) {
        showToast(err?.message || "Speichern fehlgeschlagen.");
        return;
      }
      const decision = await decideStaleWrite(err, { tripId: place.vacationId });
      if (decision === "force") {
        const updated = await updatePlaceName({ ...place, forceSave: true }, input.value);
        closeOverlayHistory(activeClose);
        showToast("Gespeichert");
        onSaved?.(updated);
        return;
      }
      if (decision === "reload" && err.fresh) {
        const fresh = normalizePlace(waypointRowToPlace(err.fresh));
        place.remoteUpdatedAt = fresh.remoteUpdatedAt;
        place.name = fresh.name;
        input.value = fresh.name || "";
      }
    }
  });
  overlay.querySelector('[data-action="delete"]').addEventListener("click", async () => {
    const [media, notes] = await Promise.all([
      getMediaForPlace(place.id),
      getNotesForPlace(place.id),
    ]);
    const mCount = media.length;
    const nCount = notes.length;
    let detail = "";
    if (mCount) detail += ` ${mediaCountLabel(mCount)}`;
    if (nCount) detail += `${detail ? " und" : ""} ${noteCountLabel(nCount)}`;
    const ok = await openConfirmDialog({
      title: "Ort löschen?",
      message: `«${place.name}» wird gelöscht.${detail ? ` Enthält${detail}.` : ""}`,
      testId: "confirm-delete-place",
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
