import { closeOverlayHistory, openOverlayHistory } from "./overlay-stack.js";
import { escapeHtml } from "./utils.js";

const PIN_SVG = `<svg width="16" height="16" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 2.8c-5.8 0-10 4.3-10 9.7 0 6.9 10 15.7 10 15.7s10-8.8 10-15.7c0-5.4-4.2-9.7-10-9.7z" fill="#d4523e"/><circle cx="16" cy="12.6" r="3.8" fill="#fff"/></svg>`;
const PLUS_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="#e7f1fb"/><path d="M12 8v8M8 12h8" stroke="#0066b3" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const OFF_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="#8aa0b4" stroke-width="1.6"/><path d="M8 12h8" stroke="#8aa0b4" stroke-width="1.6" stroke-linecap="round"/></svg>`;

function marker(kind) {
  if (kind === "new") return PLUS_SVG;
  if (kind === "ohne") return OFF_SVG;
  return PIN_SVG;
}

/**
 * Zielauswahl wie im Zuordnungs-Sheet. Löst mit der Option oder null (Abbrechen).
 */
export function openPhotoTargetSheet({ title, thumbs = [], options }) {
  const overlay = document.getElementById("overlay-root");
  if (!overlay) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const layer = document.createElement("div");
    layer.className = "target-layer";
    layer.dataset.testid = "photo-target-layer";
    const thumbHtml = thumbs.length
      ? `<div class="target-sheet__thumbs">${thumbs
          .slice(0, 4)
          .map((src) => `<img src="${escapeHtml(src)}" alt="" />`)
          .join("")}</div>`
      : "";
    layer.innerHTML = `
      <div class="sheet sheet--target" data-testid="photo-target-sheet" role="dialog" aria-modal="true">
        <div class="sheet-handle" aria-hidden="true"></div>
        <h2 class="sheet__title">${escapeHtml(title)}</h2>
        ${thumbHtml}
        <ul class="target-sheet__list">
          ${options
            .map(
              (opt) => `
            <li>
              <button type="button" class="target-row${opt.selected ? " target-row--on" : ""}" data-key="${escapeHtml(opt.key)}" data-testid="photo-target-option">
                <span class="target-row__mark">${marker(opt.kind)}</span>
                <span class="target-row__text">
                  <span class="target-row__title">${escapeHtml(opt.title)}</span>
                  ${opt.sub ? `<span class="target-row__sub">${escapeHtml(opt.sub)}</span>` : ""}
                </span>
                <span class="target-row__radio${opt.selected ? " target-row__radio--on" : ""}" aria-hidden="true"></span>
              </button>
            </li>`
            )
            .join("")}
        </ul>
        <button type="button" class="link-btn" data-action="cancel">Abbrechen</button>
      </div>`;
    overlay.appendChild(layer);

    const closeDom = () => {
      layer.remove();
    };
    openOverlayHistory(closeDom);

    const choose = (opt) => {
      closeOverlayHistory(closeDom);
      finish(opt || null);
    };
    layer.querySelectorAll("[data-key]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const opt = options.find((item) => item.key === btn.dataset.key);
        choose(opt || null);
      });
    });
    layer.querySelector('[data-action="cancel"]').addEventListener("click", () => choose(null));
    layer.addEventListener("click", (e) => {
      if (e.target === layer) {
        e.stopPropagation();
        choose(null);
      }
    });
  });
}
