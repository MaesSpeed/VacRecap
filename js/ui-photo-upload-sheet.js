import { CloudOfflineError } from "./cloud-errors.js";
import {
  CloudUploadFailedError,
  retryCloudPhotoUpload,
  uploadCloudPhoto,
} from "./cloud-photo-upload.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { processPhotoForCloud } from "./media-process.js";
import { canEditTripMedia, getMyTripRole } from "./trip-role.js";
import { showToast, showWarnToast } from "./toast.js";

/**
 * @typedef {{ file: File, name: string, status: string, error?: string, processed?: { blob: Blob, thumbBlob: Blob, w: number, h: number, takenAt?: number }, media?: object }} UploadItem
 */

export function openPhotoUploadSheet({ files, place, vacationId, day, onDone }) {
  const overlay = document.getElementById("overlay-root");
  if (!overlay || !files?.length) return;

  const imageFiles = files.filter((f) => f.type.startsWith("image/"));
  const videoCount = files.length - imageFiles.length;
  if (videoCount > 0) {
    showToast("Videos kommen in einem späteren Paket.", { icon: "none" });
  }
  if (!imageFiles.length) return;

  /** @type {UploadItem[]} */
  const items = imageFiles.map((file) => ({
    file,
    name: file.name || "Foto",
    status: "queued",
  }));

  overlay.hidden = false;
  let onlineHandler = null;

  function canRetryItem(it) {
    if (it.retryable === false) return false;
    if (it.status === "offline") return true;
    if (it.status !== "failed") return false;
    const msg = (it.error || "").toLowerCase();
    if (msg.includes("lesezugriff")) return false;
    if (msg.includes("heic")) return false;
    if (msg.includes("nicht unterstützt")) return false;
    if (msg.includes("bild konnte nicht gelesen")) return false;
    return true;
  }

  const render = () => {
    overlay.innerHTML = `
      <div class="sheet sheet--photo-upload" data-testid="photo-upload-sheet">
        <div class="sheet__header sheet__header--photo-upload">
          <h2 class="sheet__title">Fotos hochladen</h2>
          <button type="button" class="sheet__close" data-action="close" aria-label="Schließen">×</button>
        </div>
        <div class="sheet__body">
          <ul class="photo-upload-list">
            ${items
              .map(
                (it, i) => `
              <li class="photo-upload-item" data-idx="${i}">
                <span class="photo-upload-item__name">${escapeHtml(it.name)}</span>
                <span class="photo-upload-item__status" data-role="status">${statusLabel(it)}</span>
                ${
                  canRetryItem(it)
                    ? `<button type="button" class="notes-more" data-action="retry" data-idx="${i}">Erneut versuchen</button>`
                    : ""
                }
              </li>`
              )
              .join("")}
          </ul>
        </div>
      </div>`;
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function statusLabel(it) {
    if (it.error && it.status === "failed") {
      return `⚠ ${escapeHtml(it.error.slice(0, 80))}`;
    }
    switch (it.status) {
      case "queued":
        return "Wartet…";
      case "processing":
        return "Verkleinern…";
      case "uploading":
        return "Upload…";
      case "uploaded":
        return "✓";
      case "failed":
        return "⚠";
      case "offline":
        return "⚠ Offline";
      default:
        return it.status;
    }
  }

  const closeDom = () => {
    if (onlineHandler) {
      window.removeEventListener("online", onlineHandler);
      onlineHandler = null;
    }
    overlay.hidden = true;
    overlay.innerHTML = "";
  };
  const activeClose = bindOverlay(overlay, closeDom);

  async function runItem(index, forceRetry = false) {
    void forceRetry;
    const item = items[index];
    if (!item || item.status === "uploaded") return;

    const role = await getMyTripRole(vacationId);
    if (!canEditTripMedia(role)) {
      item.status = "failed";
      item.retryable = false;
      item.error = "Du hast nur Lesezugriff auf diese Reise.";
      render();
      bindActions();
      showWarnToast(item.error);
      return;
    }

    if (!navigator.onLine) {
      item.status = "offline";
      item.error = "Offline";
      render();
      bindActions();
      showWarnToast("Du bist offline. Upload erst wieder online möglich.");
      return;
    }
    try {
      item.status = "processing";
      item.error = undefined;
      render();
      bindActions();
      const processed = await processPhotoForCloud(item.file);
      item.processed = processed;
      item.status = "uploading";
      render();
      bindActions();

      if (item.media?.id) {
        item.media = await retryCloudPhotoUpload(item.media, {
          originalBlob: processed.blob,
          thumbBlob: processed.thumbBlob,
        });
      } else {
        item.media = await uploadCloudPhoto({
          place,
          vacationId,
          day,
          ts: processed.takenAt ?? Date.now(),
          originalBlob: processed.blob,
          thumbBlob: processed.thumbBlob,
          width: processed.w,
          height: processed.h,
          onStatus: () => {
            item.status = "uploading";
            render();
            bindActions();
          },
        });
      }
      item.status = "uploaded";
    } catch (err) {
      if (err instanceof CloudUploadFailedError && err.mediaRecord) {
        item.media = err.mediaRecord;
      } else if (err instanceof CloudOfflineError && err.mediaRecord) {
        item.media = err.mediaRecord;
      }
      const rootCause =
        err instanceof CloudOfflineError
          ? err
          : err instanceof CloudUploadFailedError && err.cause instanceof CloudOfflineError
            ? err.cause
            : err;
      if (rootCause instanceof CloudOfflineError) {
        item.status = "offline";
        item.error = rootCause.message || "Offline";
        showWarnToast(rootCause.message || "Offline – Upload nicht möglich.");
      } else {
        item.status = "failed";
        item.error =
          err?.message ||
          (err instanceof CloudUploadFailedError ? "Upload fehlgeschlagen" : "Verarbeitung fehlgeschlagen");
        item.retryable = canRetryItem(item);
        if (item.status === "failed" && item.error) {
          showWarnToast(item.error.length > 120 ? `${item.error.slice(0, 117)}…` : item.error);
        }
      }
    } finally {
      if (item.processed?.blob) item.processed.blob = null;
      if (item.processed?.thumbBlob) item.processed.thumbBlob = null;
      render();
      bindActions();
    }
  }

  async function runAll() {
    for (let i = 0; i < items.length; i++) {
      await runItem(i);
    }
    onDone?.();
  }

  function bindActions() {
    overlay.querySelector('[data-action="close"]')?.addEventListener("click", () => {
      closeOverlayHistory(activeClose);
    });
    overlay.querySelectorAll('[data-action="retry"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-idx"));
        void runItem(idx, true);
      });
    });
  }

  onlineHandler = () => {
    items.forEach((it, idx) => {
      if (it.status === "offline") void runItem(idx, true);
    });
  };
  window.addEventListener("online", onlineHandler);

  render();
  bindActions();
  void runAll();
}
