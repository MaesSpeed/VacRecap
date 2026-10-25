import { deleteMedia } from "./db.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { formatMediaDuration } from "./media-process.js";
import { ICON_BACK_CHEVRON } from "./icons.js";
import { openConfirmDialog } from "./ui-confirm.js";
import { showToast } from "./toast.js";

const PLAY_ICON = `<svg class="tile__play" width="18" height="18" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;

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

export function openMediaViewer(mediaItems, startId, { onChanged }) {
  const sorted = mediaItems.slice().sort((a, b) => a.ts - b.ts);
  let index = sorted.findIndex((m) => m.id === startId);
  if (index < 0) index = 0;

  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;

  const close = () => {
    revokeAll();
    overlay.innerHTML = "";
    overlay.hidden = true;
  };

  bindOverlay(overlay, close);

  const render = () => {
    revokeAll();
    const item = sorted[index];
    if (!item) {
      closeOverlayHistory(close);
      return;
    }
    const url = mediaUrl(item);
    const isVideo = item.type === "video";
    const body = isVideo
      ? `<video class="media-viewer__video" src="${url}" controls playsinline></video>`
      : `<img class="media-viewer__img" src="${url}" alt="" />`;

    overlay.innerHTML = `
      <div class="media-viewer" data-testid="media-viewer">
        <header class="media-viewer__bar">
          <button type="button" class="media-viewer__back" data-action="close" data-testid="media-viewer-close" aria-label="Zurück">${ICON_BACK_CHEVRON}</button>
          <button type="button" class="media-viewer__delete" data-action="delete" aria-label="Löschen">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-7 4v7m4-7v7M6 7l1 12a1 1 0 0 0 1 .9h8a1 1 0 0 0 1-.9L18 7"/>
            </svg>
          </button>
        </header>
        <div class="media-viewer__stage" data-role="stage">
          ${body}
        </div>
      </div>
    `;

    overlay.querySelector('[data-action="close"]').addEventListener("click", () =>
      closeOverlayHistory(close)
    );
    overlay.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      const title = isVideo ? "Video löschen?" : "Foto löschen?";
      const ok = await openConfirmDialog({
        title,
        message: "Dieses Medium wird unwiderruflich gelöscht.",
        testId: "confirm-delete-media",
      });
      if (!ok) return;
      deleteMedia(item.id).then(() => {
        showToast(isVideo ? "Video gelöscht" : "Foto gelöscht");
        sorted.splice(index, 1);
        if (!sorted.length) {
          closeOverlayHistory(close);
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
