import {
  bindOverlay,
  blockTripFooter,
  closeOverlayHistory,
  SHEET_INPUT_BLOCK_MS,
} from "./overlay-stack.js";

let busy = false;
let openBlockedUntil = 0;

export function openCameraChoiceSheet({ onPhoto, onVideo }) {
  if (Date.now() < openBlockedUntil) return;
  openBlockedUntil = Date.now() + SHEET_INPUT_BLOCK_MS;
  blockTripFooter(SHEET_INPUT_BLOCK_MS);
  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;
  overlay.classList.add("overlay-root--bleed");
  overlay.innerHTML = `
    <div class="sheet sheet--camera" data-testid="camera-sheet">
      <header class="sheet__header">
        <h2 class="sheet__title">Aufnahme</h2>
      </header>
      <div class="sheet-actions sheet-actions--stack">
        <button type="button" class="btn btn-emaille btn-emaille--block" data-action="photo">Foto</button>
        <button type="button" class="btn btn-emaille btn-emaille--block" data-action="video">Video</button>
        <button type="button" class="link-btn" data-action="cancel">Abbrechen</button>
      </div>
    </div>
  `;

  const close = () => {
    overlay.classList.remove("overlay-root--bleed");
    overlay.hidden = true;
    overlay.innerHTML = "";
    busy = false;
  };

  const activeClose = bindOverlay(overlay, close);

  overlay.querySelector('[data-action="cancel"]').addEventListener("click", () =>
    closeOverlayHistory(activeClose)
  );
  overlay.querySelector('[data-action="photo"]').addEventListener("click", () => {
    if (busy) return;
    busy = true;
    closeOverlayHistory(activeClose);
    onPhoto?.();
  });
  overlay.querySelector('[data-action="video"]').addEventListener("click", () => {
    if (busy) return;
    busy = true;
    closeOverlayHistory(activeClose);
    onVideo?.();
  });
}
