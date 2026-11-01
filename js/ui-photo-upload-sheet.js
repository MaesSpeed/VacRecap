import { CloudOfflineError } from "./cloud-errors.js";
import {
  CloudUploadFailedError,
  retryCloudPhotoUpload,
  uploadCloudPhoto,
} from "./cloud-photo-upload.js";
import { updateMediaRow } from "./db.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { processPhotoForCloud } from "./media-process.js";
import { deletePlaceIfEmpty } from "./target-place.js";
import { canAddOwn, getMyTripRole } from "./trip-role.js";
import { showToast, showWarnToast } from "./toast.js";
import { formatDatePart } from "./utils.js";

/**
 * @typedef {{ file: File, name: string, status: string, error?: string, place?: object|null, day?: string, processed?: { blob: Blob, thumbBlob: Blob, w: number, h: number, takenAt?: number }, media?: object }} UploadItem
 */

export function openPhotoUploadSheet({
  files,
  place,
  vacationId,
  day,
  onDone,
  ensurePlace,
  heldMessage,
  redirect = null,
  fileTargets = null,
}) {
  const overlay = document.getElementById("overlay-root");
  const source = fileTargets?.length
    ? fileTargets
    : (files || []).filter((f) => f.type?.startsWith("image/")).map((file) => ({ file, place, day }));
  if (!overlay || !source.length) return;
  let currentPlace = place || source.find((row) => row.place)?.place || null;

  const imageRows = source.filter((row) => row.file?.type?.startsWith("image/"));
  const names = [...new Set(imageRows.map((row) => row.place?.name).filter(Boolean))];
  const days = [...new Set(imageRows.map((row) => row.day || day).filter(Boolean))];
  const targetLabel =
    names.length > 1
      ? names.join(" · ")
      : [days[0] ? formatDatePart(days[0], false) : "", names[0] || place?.name || ""]
          .filter(Boolean)
          .join(" · ");
  const videoCount = (files || []).length - imageRows.length;
  if (videoCount > 0) {
    showToast("Videos kommen in einem späteren Paket.", { icon: "none" });
  }
  if (!imageRows.length) return;

  const waitingForPlace = !currentPlace && typeof ensurePlace === "function";
  /** @type {UploadItem[]} */
  const items = imageRows.map((row) => ({
    file: row.file,
    name: row.file.name || "Foto",
    place: row.place || currentPlace || null,
    day: row.day || day,
    status: waitingForPlace ? "failed" : "queued",
    error: waitingForPlace ? heldMessage : undefined,
    retryable: waitingForPlace ? true : undefined,
  }));

  overlay.hidden = false;
  let onlineHandler = null;
  let placeFlight = null;
  let draining = null;

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
          ${
            targetLabel
              ? `<p class="photo-upload-target" data-testid="photo-upload-target">${escapeHtml(targetLabel)}</p>`
              : ""
          }
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
    if (it.status === "offline") return "⚠ Offline";
    if (it.error && it.status === "failed") {
      return `⚠ ${escapeHtml(it.error)}`;
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

  async function ensurePlaceOnce() {
    if (currentPlace) return currentPlace;
    if (!placeFlight) {
      placeFlight = Promise.resolve()
        .then(() => ensurePlace())
        .then((next) => {
          currentPlace = next || null;
          if (currentPlace) {
            for (const it of items) {
              if (!it.place) it.place = currentPlace;
            }
          }
          return currentPlace;
        })
        .finally(() => {
          placeFlight = null;
        });
    }
    return placeFlight;
  }

  async function alignUploaded(item, usedPlace) {
    if (!redirect || !item.media?.id) return;
    await redirect.run(async () => {
      redirect.noteMedia(item.media.id);
      redirect.release();
      const live = redirect.place;
      if (live && usedPlace && (live.id !== usedPlace.id || (live.day || live.dayDate) !== (item.day || day))) {
        const nextDay = live.day || live.dayDate || item.day;
        item.media = await updateMediaRow(item.media.id, { waypoint_id: live.id, day: nextDay });
        item.place = live;
        item.day = nextDay;
      }
      if (redirect.pending === 0 && redirect.retirePlaceId) {
        await deletePlaceIfEmpty(redirect.retirePlaceId);
      }
    });
  }

  async function runItem(index, forceRetry = false) {
    void forceRetry;
    const item = items[index];
    if (!item || item.status === "uploaded") return;

    const role = await getMyTripRole(vacationId);
    if (!canAddOwn(role)) {
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
    let usedPlace = null;
    let held = false;
    try {
      if (redirect) {
        usedPlace = await redirect.run(() => {
          redirect.hold();
          held = true;
          return redirect.place || item.place || currentPlace;
        });
      } else {
        usedPlace = item.place || currentPlace;
      }
      if (!usedPlace && typeof ensurePlace === "function") {
        usedPlace = await ensurePlaceOnce();
        item.place = usedPlace || item.place;
      }
      if (!usedPlace) {
        if (held && redirect) {
          await redirect.run(() => redirect.release());
          held = false;
        }
        item.status = "failed";
        item.retryable = true;
        item.error = heldMessage || "Der Ort konnte nicht angelegt werden. Das Foto bleibt erhalten – bitte erneut versuchen.";
        showWarnToast(item.error);
        return;
      }
      item.place = usedPlace;
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
          place: usedPlace,
          vacationId,
          day: item.day || day,
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
      item.error = undefined;
      await alignUploaded(item, usedPlace);
      held = false;
    } catch (err) {
      if (err instanceof CloudUploadFailedError && err.mediaRecord) {
        item.media = err.mediaRecord;
      } else if (err instanceof CloudOfflineError && err.mediaRecord) {
        item.media = err.mediaRecord;
      }
      if (redirect && item.media?.id) {
        await alignUploaded(item, usedPlace);
        held = false;
      } else if (held && redirect) {
        await redirect.run(() => redirect.release());
        held = false;
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
          (err?.message?.startsWith("Der Ort konnte nicht") ? heldMessage || err.message : err?.message) ||
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
    if (waitingForPlace) return;
    for (let i = 0; i < items.length; i++) {
      await runItem(i);
    }
    onDone?.();
  }

  function drainFrom(startIdx) {
    if (draining) return draining;
    draining = (async () => {
      const order = [startIdx, ...items.map((_, i) => i).filter((i) => i !== startIdx)];
      for (const i of order) {
        const it = items[i];
        if (!it || it.status === "uploaded") continue;
        if (i !== startIdx && it.status !== "failed" && it.status !== "queued" && it.status !== "offline") continue;
        await runItem(i, true);
      }
      if (items.length && items.every((it) => it.status === "uploaded")) onDone?.();
    })().finally(() => {
      draining = null;
    });
    return draining;
  }

  function bindActions() {
    overlay.querySelector('[data-action="close"]')?.addEventListener("click", () => {
      closeOverlayHistory(activeClose);
    });
    overlay.querySelectorAll('[data-action="retry"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-idx"));
        void drainFrom(idx);
      });
    });
  }

  onlineHandler = () => {
    items.forEach((it, idx) => {
      if (it.status === "offline") void drainFrom(idx);
    });
  };
  window.addEventListener("online", onlineHandler);

  render();
  bindActions();
  void runAll();
}
