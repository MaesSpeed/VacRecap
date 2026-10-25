import { deleteMedia } from "./db.js";
import { formatMediaDuration } from "./media-process.js";
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

  const render = () => {
    revokeAll();
    const item = sorted[index];
    if (!item) {
      close();
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
          <button type="button" class="media-viewer__back" data-action="close">‹ Zurück</button>
          <button type="button" class="media-viewer__delete" data-action="delete" aria-label="Löschen">🗑</button>
        </header>
        <div class="media-viewer__stage" data-role="stage">
          ${body}
        </div>
      </div>
    `;

    overlay.querySelector('[data-action="close"]').addEventListener("click", close);
    overlay.querySelector('[data-action="delete"]').addEventListener("click", () => {
      const label = isVideo ? "Video löschen?" : "Foto löschen?";
      if (!window.confirm(label)) return;
      deleteMedia(item.id).then(() => {
        showToast(isVideo ? "Video gelöscht" : "Foto gelöscht");
        sorted.splice(index, 1);
        if (!sorted.length) {
          close();
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

  const close = () => {
    revokeAll();
    overlay.hidden = true;
    overlay.innerHTML = "";
  };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

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
