import { getPlacesForDay } from "./db.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { sortPlacesChronologicalDesc } from "./places.js";
import { formatTimeFromTs } from "./geo.js";
import { escapeHtml } from "./utils.js";

const PIN_SVG = `<svg width="14" height="14" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 2.8c-5.8 0-10 4.3-10 9.7 0 6.9 10 15.7 10 15.7s10-8.8 10-15.7c0-5.4-4.2-9.7-10-9.7z" fill="#d4523e"/><circle cx="16" cy="12.6" r="3.8" fill="#fff"/></svg>`;

export function openMediathekPlaceSheet({ vacationId, day, onSelect }) {
  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;

  const close = () => {
    overlay.hidden = true;
    overlay.innerHTML = "";
  };

  overlay.innerHTML = `
    <div class="sheet sheet--mediathek-place" data-testid="mediathek-place-sheet">
      <header class="sheet__header">
        <h2 class="sheet__title">Zu welchem Ort?</h2>
      </header>
      <ul class="mediathek-place-list" data-role="list"></ul>
      <button type="button" class="link-btn" data-action="cancel">Abbrechen</button>
    </div>
  `;

  bindOverlay(overlay, close);

  const listEl = overlay.querySelector('[data-role="list"]');

  getPlacesForDay(vacationId, day).then((places) => {
    const hard = sortPlacesChronologicalDesc(places.filter((p) => !p.soft));
    listEl.innerHTML = `
      ${hard
        .map(
          (p) => `
        <li>
          <button type="button" class="mediathek-place-row" data-place-id="${p.id}">
            <span class="mediathek-place-row__pin">${PIN_SVG}</span>
            <span class="mediathek-place-row__name">${escapeHtml(p.name)}</span>
            <span class="mediathek-place-row__time">${formatTimeFromTs(p.ts)}</span>
          </button>
        </li>`
        )
        .join("")}
      <li>
        <button type="button" class="mediathek-place-row mediathek-place-row--new" data-action="ohne-ort">
          <span class="mediathek-place-row__pin">${PIN_SVG}</span>
          <span class="mediathek-place-row__name">Neuer Ort ohne Position</span>
        </button>
      </li>
    `;

    listEl.querySelectorAll("[data-place-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const place = hard.find((p) => p.id === btn.dataset.placeId);
        closeOverlayHistory(close);
        onSelect({ place, ohneOrtPending: false });
      });
    });
    listEl.querySelector('[data-action="ohne-ort"]').addEventListener("click", () => {
      closeOverlayHistory(close);
      onSelect({ place: null, ohneOrtPending: true });
    });
  });

  overlay.querySelector('[data-action="cancel"]').addEventListener("click", () =>
    closeOverlayHistory(close)
  );
}
