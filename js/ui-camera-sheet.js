import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";

let busy = false;

export function openCameraChoiceSheet({ onPhoto, onVideo }) {
  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;
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
    overlay.hidden = true;
    overlay.innerHTML = "";
    busy = false;
  };

  bindOverlay(overlay, close);

  overlay.querySelector('[data-action="cancel"]').addEventListener("click", () =>
    closeOverlayHistory(close)
  );
  overlay.querySelector('[data-action="photo"]').addEventListener("click", () => {
    if (busy) return;
    busy = true;
    closeOverlayHistory(close);
    onPhoto?.();
  });
  overlay.querySelector('[data-action="video"]').addEventListener("click", () => {
    if (busy) return;
    busy = true;
    closeOverlayHistory(close);
    onVideo?.();
  });
}
