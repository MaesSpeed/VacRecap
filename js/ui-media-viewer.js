import { deleteMedia, putMedia } from "./db.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { formatMediaDuration } from "./media-process.js";
import { createShareFileFromMedia } from "./media-file-meta.js";
import { ICON_BACK_CHEVRON_WHITE } from "./icons.js";
import { openConfirmDialog } from "./ui-confirm.js";
import { showToast } from "./toast.js";

const PLAY_ICON = `<svg class="tile__play" width="18" height="18" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;

const ICON_SHARE = `<svg class="media-viewer__share-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8 7l4-4 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" stroke-width="2"/></svg>`;

const SHARE_SNACK_MS = 3000;

let objectUrls = [];

function revokeAll() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
}

function mediaUrl(item) {
  const blob = item.type === "video" ? item.blob : item.blob;
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}

function shareHintMessage(isVideo) {
  return isVideo
    ? "Zum Sichern „Video sichern“ wählen"
    : 'Zum Sichern „Bild sichern“ wählen';
}

function beginShareOriginal(file) {
  if (navigator.canShare?.({ files: [file] })) {
    return navigator.share({ files: [file] });
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(url);
  return Promise.resolve();
}

function showViewerShareSnack(overlay, isVideo) {
  const snack = overlay.querySelector('[data-role="share-snack"]');
  if (!snack) return;
  snack.textContent = shareHintMessage(isVideo);
  snack.hidden = false;
  requestAnimationFrame(() => snack.classList.add("toast--visible"));
}

function hideViewerShareSnack(overlay) {
  const snack = overlay.querySelector('[data-role="share-snack"]');
  if (!snack) return;
  snack.classList.remove("toast--visible");
  snack.hidden = true;
}

export function openMediaViewer(mediaItems, startId, { onChanged }) {
  const sorted = mediaItems.slice().sort((a, b) => a.ts - b.ts);
  let index = sorted.findIndex((m) => m.id === startId);
  if (index < 0) index = 0;
  let shareSnackTimer = null;

  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;

  const close = () => {
    if (shareSnackTimer) {
      clearTimeout(shareSnackTimer);
      shareSnackTimer = null;
    }
    revokeAll();
    overlay.innerHTML = "";
    overlay.hidden = true;
  };

  const activeClose = bindOverlay(overlay, close);

  const render = () => {
    revokeAll();
    if (shareSnackTimer) {
      clearTimeout(shareSnackTimer);
      shareSnackTimer = null;
    }
    hideViewerShareSnack(overlay);
    const item = sorted[index];
    if (!item) {
      closeOverlayHistory(activeClose);
      return;
    }
    const url = mediaUrl(item);
    const isVideo = item.type === "video";
    const shareFile = createShareFileFromMedia(item);
    const body = isVideo
      ? `<video class="media-viewer__video" src="${url}" controls playsinline></video>`
      : `<img class="media-viewer__img" src="${url}" alt="" />`;

    overlay.innerHTML = `
      <div class="media-viewer" data-testid="media-viewer">
        <header class="media-viewer__bar">
          <button type="button" class="media-viewer__back" data-action="close" data-testid="media-viewer-close" aria-label="Zurück">${ICON_BACK_CHEVRON_WHITE}</button>
          <button type="button" class="media-viewer__delete" data-action="delete" aria-label="Löschen">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-7 4v7m4-7v7M6 7l1 12a1 1 0 0 0 1 .9h8a1 1 0 0 0 1-.9L18 7"/>
            </svg>
          </button>
        </header>
        <div class="media-viewer__stage" data-role="stage">
          ${body}
        </div>
        <footer class="media-viewer__save-wrap">
          <div class="media-viewer__share-snack toast toast--pill toast--no-icon" data-role="share-snack" data-testid="media-viewer-share-snack" hidden aria-live="polite"></div>
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
    overlay.querySelector('[data-action="save-photos"]').addEventListener("click", () => {
      const tapAt = Date.now();
      showViewerShareSnack(overlay, isVideo);
      beginShareOriginal(shareFile)
        .catch((err) => {
          if (err?.name === "AbortError") return;
        })
        .finally(() => {
          const dismissAt = Math.max(tapAt + SHARE_SNACK_MS, Date.now() + SHARE_SNACK_MS);
          const delay = Math.max(0, dismissAt - Date.now());
          shareSnackTimer = setTimeout(() => {
            shareSnackTimer = null;
            hideViewerShareSnack(overlay);
          }, delay);
        });
    });
    overlay.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      const title = isVideo ? "Video löschen?" : "Foto löschen?";
      const ok = await openConfirmDialog({
        title,
        message: "Dieses Medium wird unwiderruflich gelöscht.",
        testId: "confirm-delete-media",
      });
      if (!ok) return;
      const removedIndex = index;
      const snapshot = { ...item };
      deleteMedia(item.id).then(() => {
        sorted.splice(index, 1);
        const msg = isVideo ? "Video gelöscht" : "Foto gelöscht";
        const viewerOpen = () =>
          !overlay.hidden && overlay.querySelector('[data-testid="media-viewer"]');
        showToast(msg, {
          icon: "trash",
          undoLabel: "Rückgängig",
          onUndo: async () => {
            await putMedia(snapshot);
            sorted.splice(removedIndex, 0, snapshot);
            onChanged?.();
            if (viewerOpen()) {
              index = removedIndex;
              render();
            } else {
              openMediaViewer(sorted, snapshot.id, { onChanged });
            }
          },
        });
        if (!sorted.length) {
          closeOverlayHistory(activeClose);
          onChanged?.();
          return;
        }
        if (index >= sorted.length) index = sorted.length - 1;
        onChanged?.();
        render();
      });
    });

    const stage = overlay.querySelector('[data-role="stage"]');
    bindSwipe(stage, () => {
      if (index < sorted.length - 1) {
        index += 1;
        render();
      }
    }, () => {
      if (index > 0) {
        index -= 1;
        render();
      }
    });
  };

  render();
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
