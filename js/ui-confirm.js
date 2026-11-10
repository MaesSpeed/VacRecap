import { escapeHtml } from "./utils.js";

/** Bestätigung über allen Overlays (auch Media-Viewer). */
export function openConfirmDialog({
  title,
  message,
  confirmLabel = "Löschen",
  cancelLabel = "Abbrechen",
  danger = true,
  testId,
  variant = "",
}) {
  return new Promise((resolve) => {
    const centered = variant === "center";
    const layer = document.createElement("div");
    layer.className = `overlay-confirm-layer overlay-confirm-layer--top${centered ? " overlay-confirm-layer--center" : ""}`;
    layer.dataset.confirmLayer = "1";
    const confirmClass = centered ? "confirm-dialog__go" : danger ? "danger" : "";
    layer.innerHTML = `
      <div class="confirm-dialog${centered ? " confirm-dialog--center" : ""}" role="alertdialog" ${testId ? `data-testid="${testId}"` : ""}>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        <div class="confirm-dialog__actions">
          <button type="button" data-action="cancel">${escapeHtml(cancelLabel)}</button>
          <button type="button" data-action="confirm" class="${confirmClass}">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(layer);

    const finish = (value) => {
      layer.remove();
      resolve(value);
    };

    layer.addEventListener("click", (e) => {
      if (e.target === layer) finish(false);
    });

    const dialog = layer.querySelector(".confirm-dialog");
    dialog?.addEventListener("click", (e) => e.stopPropagation());

    layer.querySelector('[data-action="cancel"]').addEventListener("click", () => finish(false));
    layer.querySelector('[data-action="confirm"]').addEventListener("click", () => finish(true));
  });
}
