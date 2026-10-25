import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { escapeHtml } from "./utils.js";

export function openConfirmDialog({
  title,
  message,
  confirmLabel = "Löschen",
  cancelLabel = "Abbrechen",
  danger = true,
  testId,
}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("overlay-root");
    overlay.hidden = false;
    overlay.innerHTML = `
      <div class="confirm-dialog" role="alertdialog" ${testId ? `data-testid="${testId}"` : ""}>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        <div class="confirm-dialog__actions">
          <button type="button" data-action="cancel">${escapeHtml(cancelLabel)}</button>
          <button type="button" data-action="confirm" class="${danger ? "danger" : ""}">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    const close = () => {
      overlay.hidden = true;
      overlay.innerHTML = "";
    };
    bindOverlay(overlay, () => {
      close();
      resolve(false);
    });
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => {
      closeOverlayHistory(() => {
        close();
        resolve(false);
      });
    });
    overlay.querySelector('[data-action="confirm"]').addEventListener("click", () => {
      closeOverlayHistory(() => {
        close();
        resolve(true);
      });
    });
  });
}
