import { COVER_CREDITS, presetThumbUrl } from "./covers.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { escapeHtml } from "./utils.js";

export function openCoverCreditsSheet() {
  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="sheet sheet--credits" data-testid="cover-credits-sheet">
      <header class="sheet__header">
        <h2 class="sheet__title">Bildnachweise</h2>
      </header>
      <ul class="credits-list">
        ${COVER_CREDITS.map(
          (c) => `
          <li class="credits-list__item">
            <img class="credits-list__thumb" src="${presetThumbUrl(c.presetId)}" alt="" />
            <div class="credits-list__text">
              <strong>${escapeHtml(c.title)}</strong>
              <span>${escapeHtml(c.author)}</span>
              <a href="${escapeHtml(c.licenseUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.license)}</a>
            </div>
          </li>`
        ).join("")}
      </ul>
      <button type="button" class="link-btn link-btn--block" data-action="close">Schließen</button>
    </div>
  `;

  const close = () => {
    overlay.hidden = true;
    overlay.innerHTML = "";
  };

  bindOverlay(overlay, close);
  overlay.querySelector('[data-action="close"]').addEventListener("click", () =>
    closeOverlayHistory(close)
  );
}
