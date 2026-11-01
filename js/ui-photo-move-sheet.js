import { dayChipDateLine, dayRoleLabel, vacationDays } from "./days.js";
import { formatTimeFromTs } from "./geo.js";
import { closeOverlayHistory, openOverlayHistory } from "./overlay-stack.js";
import { bindSheetPull } from "./sheet-pull.js";
import { sortPlacesChronologicalDesc } from "./places.js";
import { escapeHtml } from "./utils.js";

/**
 * Zielauswahl: Tage der Reise, darunter die Orte des gewählten Tages.
 * Abbrechen und Tippen daneben lösen null aus und ändern nichts.
 */
export function openPhotoMoveSheet({ vacation, places, initialDay, blockedPlaceId = null }) {
  const overlay = document.getElementById("overlay-root");
  if (!overlay) return Promise.resolve(null);
  const days = vacationDays(vacation);
  if (!days.length) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const hard = sortPlacesChronologicalDesc((places || []).filter((place) => place && !place.soft));
    let day = days.includes(initialDay) ? initialDay : days[0];

    overlay.hidden = false;
    overlay.classList.add("overlay-root--bleed");
    const layer = document.createElement("div");
    layer.className = "move-layer";
    layer.dataset.testid = "photo-move-layer";
    overlay.appendChild(layer);

    let result = null;
    const closeDom = () => {
      layer.remove();
      overlay.classList.remove("overlay-root--bleed");
      if (!overlay.childElementCount) overlay.hidden = true;
      finish(result);
    };
    openOverlayHistory(closeDom);

    const choose = (place) => {
      result = place || null;
      closeOverlayHistory(closeDom);
    };

    const render = () => {
      const dayPlaces = hard.filter((place) => (place.day || place.dayDate) === day);
      const placeHtml = dayPlaces.length
        ? dayPlaces
            .map((place) => {
              const blocked = place.id === blockedPlaceId;
              const sub = blocked ? "Aktueller Ort" : formatTimeFromTs(place.ts);
              return `
            <li>
              <button type="button" class="move-place${blocked ? " move-place--blocked" : ""}" data-move-place="${escapeHtml(place.id)}" data-testid="photo-move-place"${blocked ? " disabled" : ""}>
                <span class="move-place__name">${escapeHtml(place.name || "Ort")}</span>
                <span class="move-place__sub">${escapeHtml(sub)}</span>
              </button>
            </li>`;
            })
            .join("")
        : `<li class="move-place-empty" data-testid="photo-move-empty">An diesem Tag gibt es noch keinen Ort.</li>`;

      layer.innerHTML = `
        <div class="sheet sheet--move" data-testid="photo-move-sheet" role="dialog" aria-modal="true" aria-labelledby="photo-move-title">
          <div class="sheet-handle" data-role="pick-handle" aria-hidden="true"></div>
          <h2 class="sheet__title" id="photo-move-title">Verschieben nach …</h2>
          <p class="move-sheet__lead">Tag wählen, dann den Ort.</p>
          <div class="move-days" data-testid="photo-move-days" role="tablist">
            ${days
              .map((iso, index) => {
                const on = iso === day;
                return `<button type="button" class="move-day${on ? " move-day--on" : ""}" role="tab" aria-selected="${on ? "true" : "false"}" data-move-day="${iso}" data-testid="photo-move-day">
                  <span class="move-day__date">${escapeHtml(dayChipDateLine(iso))}</span>
                  <span class="move-day__role">${escapeHtml(dayRoleLabel(index + 1, days.length))}</span>
                </button>`;
              })
              .join("")}
          </div>
          <ul class="move-places" data-testid="photo-move-places">${placeHtml}</ul>
          <button type="button" class="move-cancel" data-action="cancel" data-testid="photo-move-cancel">Abbrechen</button>
        </div>`;

      layer.querySelectorAll("[data-move-day]").forEach((btn) => {
        btn.addEventListener("click", () => {
          day = btn.dataset.moveDay;
          render();
        });
      });
      layer.querySelectorAll("[data-move-place]").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (btn.disabled) return;
          const place = hard.find((item) => item.id === btn.dataset.movePlace);
          if (place) choose(place);
        });
      });
      layer.querySelector("[data-action='cancel']")?.addEventListener("click", () => choose(null));
      const moveSheet = layer.querySelector('[data-testid="photo-move-sheet"]');
      bindSheetPull(moveSheet, {
        onClose: () => choose(null),
        scrollEl: moveSheet?.querySelector('[data-testid="photo-move-places"]') || moveSheet,
      });
    };

    layer.addEventListener("click", (event) => {
      if (event.target === layer) choose(null);
    });
    render();
  });
}
