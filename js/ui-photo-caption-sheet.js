import { CaptionUnavailableError, CloudNetworkError, CloudOfflineError, StaleWriteError } from "./cloud-errors.js";
import { decideStaleWrite } from "./save-conflict.js";
import { watchPresence, presenceBannerHtml } from "./trip-presence.js";
import { updateMediaCaption } from "./db.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { bindSheetPull } from "./sheet-pull.js";
import { showToast, showWarnToast } from "./toast.js";

const PENCIL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;

export { PENCIL as PHOTO_CAPTION_ICON };

/**
 * Kleines Sheet für genau eine Bildunterschrift.
 * Speichern und Löschen teilen sich ein Flag (try/finally), damit ein Doppeltipp
 * nicht zweimal schreibt. Escape und Zurück schließen ohne zu speichern.
 */
export function openPhotoCaptionSheet({ media, onSaved, readOnly = false }) {
  const overlay = document.getElementById("overlay-root");
  if (!overlay || !media?.id) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    let saving = false;
    let saved = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(saved);
    };

    const hadCaption = Boolean(media.caption);
    overlay.hidden = false;
    const layer = document.createElement("div");
    layer.className = "overlay-confirm-layer overlay-confirm-layer--top";
    layer.dataset.testid = "photo-caption-layer";
    layer.innerHTML = `
      <div class="sheet sheet--note-bottom" data-testid="photo-caption-sheet" role="dialog" aria-modal="true" aria-labelledby="photo-caption-title">
        <div class="sheet-handle" data-role="pick-handle" aria-hidden="true"></div>
        <div data-role="caption-presence"></div>
        <header class="note-sheet__bar">
          <button type="button" class="note-sheet__cancel" data-action="cancel" data-testid="photo-caption-cancel">Abbrechen</button>
          <h2 class="note-sheet__title" id="photo-caption-title">Notiz zum Foto</h2>
          ${
            hadCaption && !readOnly
              ? `<button type="button" class="note-sheet__delete" data-action="delete" data-testid="photo-caption-delete">Löschen</button>`
              : `<span class="note-sheet__spacer" aria-hidden="true"></span>`
          }
        </header>
        <label class="field note-sheet__field">
          <textarea data-role="text" data-testid="photo-caption-text" rows="6" maxlength="500" placeholder="Notiz zum Foto…"></textarea>
        </label>
        <button type="button" class="btn btn-emaille btn-emaille--block note-sheet__save-bottom" data-action="save" data-testid="photo-caption-save" disabled${readOnly ? " hidden" : ""}>Speichern</button>
      </div>`;
    overlay.appendChild(layer);

    const textarea = layer.querySelector('[data-role="text"]');
    const saveBtn = layer.querySelector('[data-action="save"]');
    textarea.value = media.caption || "";
    if (readOnly) textarea.readOnly = true;

    const syncSave = () => {
      const next = textarea.value.trim();
      saveBtn.disabled = !next || next === (media.caption || "");
    };
    textarea.addEventListener("input", syncSave);
    syncSave();

    const stopPresence = media.vacationId
      ? watchPresence(media.vacationId, `caption:${media.id}`, (rows) => {
          const host = layer.querySelector('[data-role="caption-presence"]');
          if (host) host.innerHTML = presenceBannerHtml(rows);
        })
      : () => {};

    const syncCaptionKb = () => {
      const kb =
        parseInt(getComputedStyle(document.documentElement).getPropertyValue("--kb"), 10) || 0;
      captionSheet?.classList.toggle("sheet--note-kb", kb > 80);
    };
    let kbViewportHandler = null;

    const domClose = () => {
      stopPresence();
      if (kbViewportHandler) {
        window.visualViewport?.removeEventListener("resize", kbViewportHandler);
        window.visualViewport?.removeEventListener("scroll", kbViewportHandler);
        kbViewportHandler = null;
      }
      window.removeEventListener("keydown", onKey, true);
      if (layer.isConnected) layer.remove();
      if (!overlay.querySelector(".media-viewer, .sheet")) {
        overlay.hidden = true;
        overlay.innerHTML = "";
      }
      finish();
    };
    const activeClose = bindOverlay(overlay, domClose);
    const captionSheet = layer.querySelector('[data-testid="photo-caption-sheet"]');
    syncCaptionKb();
    kbViewportHandler = () => syncCaptionKb();
    window.visualViewport?.addEventListener("resize", kbViewportHandler);
    window.visualViewport?.addEventListener("scroll", kbViewportHandler);
    bindSheetPull(captionSheet, {
      onClose: () => closeOverlayHistory(activeClose),
      scrollEl: captionSheet,
    });

    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeOverlayHistory(activeClose);
    };
    window.addEventListener("keydown", onKey, true);

    layer.addEventListener("click", (event) => {
      if (event.target === layer) closeOverlayHistory(activeClose);
    });
    layer.querySelector('[data-action="cancel"]').addEventListener("click", () => {
      closeOverlayHistory(activeClose);
    });

    async function commit(next, { cleared = false, force = false } = {}) {
      if (saving) return;
      saving = true;
      try {
        const previous = media.caption || null;
        media.caption = next;
        window.vacrecapPendingCaption = { id: media.id, caption: next };
        window.vacrecapOwnDaySave = true;
        let updated;
        try {
          updated = await updateMediaCaption(media.id, next, {
            remoteUpdatedAt: media.remoteUpdatedAt,
            force,
          });
        } catch (err) {
          media.caption = previous;
          window.vacrecapPendingCaption = null;
          window.vacrecapOwnDaySave = false;
          if (err instanceof StaleWriteError) {
            saving = false;
            const decision = await decideStaleWrite(err, { tripId: media.vacationId });
            if (decision === "force") return commit(next, { cleared, force: true });
            if (decision === "reload" && err.fresh) {
              media.remoteUpdatedAt = err.fresh.updated_at || null;
              media.caption = err.fresh.caption ?? null;
              textarea.value = media.caption || "";
              syncSave();
            }
            return;
          }
          if (err instanceof CaptionUnavailableError) {
            closeOverlayHistory(activeClose);
            showWarnToast(err.message);
            return;
          }
          if (err instanceof CloudOfflineError || err instanceof CloudNetworkError) {
            showWarnToast(err.message);
            return;
          }
          showWarnToast(err?.message || "Notiz konnte nicht gespeichert werden.");
          return;
        }
        media.caption = updated?.caption ?? next;
        if (updated?.remoteUpdatedAt) media.remoteUpdatedAt = updated.remoteUpdatedAt;
        saved = true;
        await window.vacrecapWhenViewSettled?.();
        closeOverlayHistory(activeClose);
        showToast(cleared ? "Notiz gelöscht" : "Notiz gespeichert", {
          undoLabel: "Rückgängig",
          icon: cleared ? "trash" : "check",
          onUndo: () => {
            media.caption = previous;
            window.vacrecapPendingCaption = { id: media.id, caption: previous };
            window.vacrecapOwnDaySave = true;
            void updateMediaCaption(media.id, previous)
              .then(() => {
                onSaved?.(media);
              })
              .catch((err) => {
                if (err instanceof CaptionUnavailableError) showWarnToast(err.message);
                else showWarnToast(err?.message || "Rückgängig ist fehlgeschlagen.");
              });
          },
        });
        onSaved?.(media);
      } finally {
        saving = false;
      }
    }

    saveBtn.addEventListener("click", () => {
      const text = textarea.value.trim();
      if (!text || saveBtn.disabled) return;
      void commit(text);
    });
    layer.querySelector('[data-action="delete"]')?.addEventListener("click", () => {
      void commit(null, { cleared: true });
    });

    if (!readOnly) requestAnimationFrame(() => textarea.focus());
  });
}
