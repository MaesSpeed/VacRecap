import { escapeHtml } from "./utils.js";

/** Bestätigung über dem bestehenden Sheet — ersetzt overlay.innerHTML nicht. */
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
    if (!overlay) {
      resolve(false);
      return;
    }
    overlay.hidden = false;

    let layer = overlay.querySelector("[data-confirm-layer]");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "overlay-confirm-layer";
      layer.dataset.confirmLayer = "1";
      overlay.appendChild(layer);
    }

    layer.innerHTML = `
      <div class="confirm-dialog" role="alertdialog" ${testId ? `data-testid="${testId}"` : ""}>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        <div class="confirm-dialog__actions">
          <button type="button" data-action="cancel">${escapeHtml(cancelLabel)}</button>
          <button type="button" data-action="confirm" class="${danger ? "danger" : ""}">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;

    const finish = (value) => {
      layer.innerHTML = "";
      layer.remove();
      resolve(value);
    };

    layer.addEventListener(
      "click",
      (e) => {
        if (e.target === layer) finish(false);
      },
      { once: true }
    );

    const dialog = layer.querySelector(".confirm-dialog");
    dialog?.addEventListener("click", (e) => e.stopPropagation());

    layer.querySelector('[data-action="cancel"]').addEventListener("click", () => finish(false));
    layer.querySelector('[data-action="confirm"]').addEventListener("click", () => finish(true));
  });
}
