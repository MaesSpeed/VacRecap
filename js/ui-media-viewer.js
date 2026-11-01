import { CloudOfflineError } from "./cloud-errors.js";
import {
  forgetPendingMediaPurge,
  markMediaDeleted,
  purgeMediaFiles,
  rememberPendingMediaPurge,
  restoreMedia,
} from "./db.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { formatMediaDuration } from "./media-process.js";
import { createShareFileFromMedia, shareFileNameForMedia } from "./media-file-meta.js";
import { getSignedOriginalUrl } from "./media-signed-url-cache.js";
import { ICON_BACK_CHEVRON_WHITE } from "./icons.js";
import { openConfirmDialog } from "./ui-confirm.js";
import { openPhotoCaptionSheet, PHOTO_CAPTION_ICON } from "./ui-photo-caption-sheet.js";
import { getSupabase } from "./supabase-client.js";
import { showToast, showWarnToast } from "./toast.js";
import { escapeHtml } from "./utils.js";

const PLAY_ICON = `<svg class="tile__play" width="18" height="18" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;

const ICON_SHARE = `<svg class="media-viewer__share-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8 7l4-4 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" stroke-width="2"/></svg>`;

const SHARE_SNACK_MS = 3000;

let objectUrls = [];

function revokeAll() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
}

async function resolveDisplayUrl(item) {
  if (item.storagePath) {
    const supabase = getSupabase();
    const url = await getSignedOriginalUrl(supabase, item.storagePath);
    if (url) return url;
  }
  if (item.blob) {
    const url = URL.createObjectURL(item.blob);
    objectUrls.push(url);
    return url;
  }
  return "";
}

async function resolveShareFile(item) {
  if (item.blob) return createShareFileFromMedia(item);
  if (item.storagePath) {
    const url = await resolveDisplayUrl(item);
    if (!url) throw new Error("no url");
    const res = await fetch(url);
    const blob = await res.blob();
    const name = shareFileNameForMedia(item);
    const mime = item.mime || blob.type || "image/jpeg";
    return new File([blob], name, { type: mime });
  }
  throw new Error("no media");
}

function shareHintMessage(isVideo, mode = "share") {
  if (mode === "download") {
    return isVideo ? "Video wird heruntergeladen" : "Datei wird heruntergeladen";
  }
  return isVideo
    ? "Zum Sichern „Video sichern“ wählen"
    : 'Zum Sichern „Bild sichern“ wählen';
}

function downloadShareFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(url);
}

function beginShareOriginal(file) {
  if (navigator.canShare?.({ files: [file] })) {
    return navigator.share({ files: [file] }).catch((err) => {
      if (err?.name === "AbortError") throw err;
      downloadShareFile(file);
      return { fallback: "download" };
    });
  }
  downloadShareFile(file);
  return Promise.resolve({ fallback: "download" });
}

function showViewerShareSnack(overlay, isVideo, mode = "share") {
  const snack = overlay.querySelector('[data-role="share-snack"]');
  if (!snack) return;
  snack.textContent = shareHintMessage(isVideo, mode);
  snack.hidden = false;
  requestAnimationFrame(() => snack.classList.add("toast--visible"));
}

function scheduleShareSnackDismiss(overlay, timerRef, tapAt) {
  if (timerRef.timer) {
    clearTimeout(timerRef.timer);
    timerRef.timer = null;
  }
  const dismissAt = Math.max(tapAt + SHARE_SNACK_MS, Date.now() + SHARE_SNACK_MS);
  const delay = Math.max(0, dismissAt - Date.now());
  timerRef.timer = setTimeout(() => {
    timerRef.timer = null;
    hideViewerShareSnack(overlay);
  }, delay);
}

function hideViewerShareSnack(overlay) {
  const snack = overlay.querySelector('[data-role="share-snack"]');
  if (!snack) return;
  snack.classList.remove("toast--visible");
  snack.hidden = true;
}

export function openMediaViewer(mediaItems, startId, options = {}) {
  const { onChanged } = options;
  const canDeleteOption = options.canDelete;
  const allowDelete = (item) => {
    if (typeof canDeleteOption === "function") return Boolean(canDeleteOption(item));
    return canDeleteOption !== false;
  };
  const canEditCaption =
    typeof options.canEditCaption === "function" ? options.canEditCaption : () => false;
  const sorted = mediaItems.slice().sort((a, b) => a.ts - b.ts);
  let index = sorted.findIndex((m) => m.id === startId);
  if (index < 0) index = 0;
  const shareSnackTimerRef = { timer: null };

  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;

  const close = () => {
    if (shareSnackTimerRef.timer) {
      clearTimeout(shareSnackTimerRef.timer);
      shareSnackTimerRef.timer = null;
    }
    revokeAll();
    overlay.innerHTML = "";
    overlay.hidden = true;
  };

  const activeClose = bindOverlay(overlay, close);

  const render = async () => {
    revokeAll();
    if (shareSnackTimerRef.timer) {
      clearTimeout(shareSnackTimerRef.timer);
      shareSnackTimerRef.timer = null;
    }
    hideViewerShareSnack(overlay);
    const item = sorted[index];
    if (!item) {
      closeOverlayHistory(activeClose);
      return;
    }
    const url = !navigator.onLine && item.storagePath && !item.blob ? "" : await resolveDisplayUrl(item);
    const isVideo = item.type === "video";
    const caption = !isVideo && item.caption ? String(item.caption) : "";
    const allowCaption = !isVideo && canEditCaption(item);
    const offlineCloud = !navigator.onLine && item.storagePath && !item.blob;
    const missing = offlineCloud
      ? `<p class="media-viewer__missing" data-testid="media-viewer-offline">Du bist offline.</p>`
      : `<p class="media-viewer__missing" data-testid="media-viewer-missing">Datei nicht gefunden.</p>`;
    const body = !url
      ? missing
      : isVideo
        ? `<video class="media-viewer__video" src="${url}" controls playsinline></video>`
        : `<img class="media-viewer__img" src="${url}" alt="" data-testid="media-viewer-img" />`;

    overlay.innerHTML = `
      <div class="media-viewer" data-testid="media-viewer">
        <header class="media-viewer__bar">
          <button type="button" class="media-viewer__back" data-action="close" data-testid="media-viewer-close" aria-label="Zurück">${ICON_BACK_CHEVRON_WHITE}</button>
          ${
            allowDelete(item)
              ? `<button type="button" class="media-viewer__delete" data-action="delete" data-testid="media-viewer-delete" aria-label="Löschen">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-7 4v7m4-7v7M6 7l1 12a1 1 0 0 0 1 .9h8a1 1 0 0 0 1-.9L18 7"/>
            </svg>
          </button>`
              : `<span class="media-viewer__delete" aria-hidden="true"></span>`
          }
        </header>
        <div class="media-viewer__stage" data-role="stage">
          ${body}
        </div>
        <footer class="media-viewer__save-wrap">
          <div class="media-viewer__share-snack toast toast--pill toast--no-icon" data-role="share-snack" data-testid="media-viewer-share-snack" hidden aria-live="polite"></div>
          ${
            caption
              ? `<p class="media-viewer__caption" data-testid="media-viewer-caption">${escapeHtml(caption)}</p>`
              : ""
          }
          ${
            allowCaption
              ? `<button type="button" class="media-viewer__save-pill" data-action="edit-caption" data-testid="photo-caption-edit" data-media-id="${escapeHtml(item.id)}">
            ${PHOTO_CAPTION_ICON}
            <span>Notiz zum Foto</span>
          </button>`
              : ""
          }
          <button type="button" class="media-viewer__save-pill" data-action="save-photos" data-testid="media-viewer-save" aria-label="In Fotos sichern">
            ${ICON_SHARE}
            <span>In Fotos sichern</span>
          </button>
        </footer>
      </div>
    `;

    overlay.querySelector('[data-action="close"]').addEventListener("click", () =>
      closeOverlayHistory(activeClose)
    );
    overlay.querySelector(".media-viewer__img")?.addEventListener("error", () => {
      const stage = overlay.querySelector('[data-role="stage"]');
      if (stage) stage.innerHTML = missing;
    });
    let captionBusy = false;
    overlay.querySelector('[data-action="edit-caption"]')?.addEventListener("click", () => {
      if (captionBusy) return;
      captionBusy = true;
      void openPhotoCaptionSheet({
        media: item,
        onSaved: () => {
          onChanged?.();
          if (!overlay.hidden && overlay.querySelector('[data-testid="media-viewer"]')) void render();
        },
      }).finally(() => {
        captionBusy = false;
      });
    });
    overlay.querySelector('[data-action="save-photos"]').addEventListener("click", () => {
      const tapAt = Date.now();
      if (shareSnackTimerRef.timer) {
        clearTimeout(shareSnackTimerRef.timer);
        shareSnackTimerRef.timer = null;
      }
      void resolveShareFile(item)
        .then((shareFile) => {
          const useShare = Boolean(navigator.canShare?.({ files: [shareFile] }));
          showViewerShareSnack(overlay, isVideo, useShare ? "share" : "download");
          return beginShareOriginal(shareFile).then((result) => {
            if (result?.fallback === "download") {
              showViewerShareSnack(overlay, isVideo, "download");
            }
          });
        })
        .catch((err) => {
          if (err?.name === "AbortError") return;
        })
        .finally(() => {
          scheduleShareSnackDismiss(overlay, shareSnackTimerRef, tapAt);
        });
    });
    if (allowDelete(item)) overlay.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      const title = isVideo ? "Video löschen?" : "Foto löschen?";
      const ok = await openConfirmDialog({
        title,
        message: "Dieses Medium wird unwiderruflich gelöscht.",
        testId: "confirm-delete-media",
      });
      if (!ok) return;
      const removedIndex = index;
      const snapshot = { ...item };
      let existing = null;
      try {
        existing = await markMediaDeleted(item.id);
      } catch (err) {
        const offline = !navigator.onLine || err instanceof CloudOfflineError;
        showWarnToast(
          offline
            ? "Offline, bitte später erneut versuchen."
            : err?.message || "Foto konnte nicht gelöscht werden."
        );
        return;
      }
      if (!existing) {
        showWarnToast("Foto konnte nicht gelöscht werden.");
        return;
      }
      rememberPendingMediaPurge(existing);
      sorted.splice(index, 1);
      const msg = isVideo ? "Video gelöscht" : "Foto gelöscht";
      const viewerOpen = () =>
        !overlay.hidden && overlay.querySelector('[data-testid="media-viewer"]');
      let restored = false;
      showToast(msg, {
        icon: "trash",
        undoLabel: "Rückgängig",
        onUndo: () => {
          restored = true;
          forgetPendingMediaPurge(snapshot.id);
          void restoreMedia(snapshot.id)
            .then(() => {
              sorted.splice(removedIndex, 0, snapshot);
              onChanged?.();
              if (viewerOpen()) {
                index = removedIndex;
                void render();
              } else {
                openMediaViewer(sorted, snapshot.id, { onChanged, canDelete: canDeleteOption, canEditCaption });
              }
            })
            .catch((err) => {
              showWarnToast(err?.message || "Löschen konnte nicht rückgängig gemacht werden.");
            });
        },
        onDismiss: () => {
          if (restored) return;
          forgetPendingMediaPurge(existing.id);
          void purgeMediaFiles(existing).catch(() => {
            showWarnToast("Datei konnte nicht aus dem Speicher gelöscht werden.");
          });
        },
      });
      if (!sorted.length) {
        closeOverlayHistory(activeClose);
        onChanged?.();
        return;
      }
      if (index >= sorted.length) index = sorted.length - 1;
      onChanged?.();
      void render();
    });

    const stage = overlay.querySelector('[data-role="stage"]');
    bindSwipe(
      stage,
      () => {
        if (index < sorted.length - 1) {
          index += 1;
          void render();
        }
      },
      () => {
        if (index > 0) {
          index -= 1;
          void render();
        }
      }
    );
  };

  void render();
}

function bindSwipe(el, onLeft, onRight) {
  let startX = 0;
  let startY = 0;
  el.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    },
    { passive: true }
  );
  el.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0) onLeft();
    else onRight();
  });
}

export { PLAY_ICON, formatMediaDuration };
