import { CloudOfflineError } from "./cloud-errors.js";
import { retryCloudPhotoUpload, uploadCloudPhoto } from "./cloud-photo-upload.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { processPhotoForCloud } from "./media-process.js";
import { showWarnToast } from "./toast.js";

/**
 * @typedef {{ file: File, name: string, status: string, error?: string, processed?: { blob: Blob, thumbBlob: Blob, w: number, h: number }, media?: object }} UploadItem
 */

export function openPhotoUploadSheet({ files, place, vacationId, day, onDone }) {
  const overlay = document.getElementById("overlay-root");
  if (!overlay || !files?.length) return;

  /** @type {UploadItem[]} */
  const items = files.map((file) => ({
    file,
    name: file.name || "Foto",
    status: "queued",
  }));

  overlay.hidden = false;

  const render = () => {
    overlay.innerHTML = `
      <div class="sheet sheet--photo-upload" data-testid="photo-upload-sheet">
        <div class="sheet__header">
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
                  it.status === "failed"
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
    overlay.hidden = true;
    overlay.innerHTML = "";
  };
  const activeClose = bindOverlay(overlay, closeDom);

  async function runItem(index, retry = false) {
    const item = items[index];
    if (!item || item.status === "uploaded") return;
    if (!navigator.onLine) {
      item.status = "offline";
      item.error = "offline";
      render();
      bindActions();
      showWarnToast("Du bist offline. Upload erst wieder online möglich.");
      return;
    }
    try {
      item.status = "processing";
      render();
      bindActions();
      const processed = await processPhotoForCloud(item.file);
      item.processed = processed;
      item.status = "uploading";
      render();
      bindActions();
      if (retry && item.media) {
        item.media = await retryCloudPhotoUpload(item.media, {
          originalBlob: processed.blob,
          thumbBlob: processed.thumbBlob,
        });
      } else {
        item.media = await uploadCloudPhoto({
          place,
          vacationId,
          day,
          originalBlob: processed.blob,
          thumbBlob: processed.thumbBlob,
          width: processed.w,
          height: processed.height,
          onStatus: () => {
            item.status = "uploading";
            render();
            bindActions();
          },
        });
      }
      item.status = "uploaded";
    } catch (err) {
      item.status = err instanceof CloudOfflineError ? "offline" : "failed";
      item.error = err?.message || "failed";
      if (item.status === "offline") {
        showWarnToast(err.message || "Offline – Upload nicht möglich.");
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

  render();
  bindActions();
  void runAll();
}
