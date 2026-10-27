import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { markBootStable } from "./boot-stable.js";

export function openGlobalSettingsSheet(hostEl) {
  const overlay = document.getElementById("overlay-root");
  if (!overlay) return;

  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="sheet sheet--settings-global" data-testid="global-settings-sheet">
      <div class="sheet__header">
        <h2 class="sheet__title">Einstellungen</h2>
        <button type="button" class="sheet__close" data-action="close" aria-label="Schließen">×</button>
      </div>
      <div class="sheet__body">
        <button type="button" class="settings-link-row" data-action="safe-mode">Notfallmodus</button>
        <p class="settings-item__sub">Vereinfachte Ansicht zum Sichern und Einspielen ohne Karte und Vorschaubilder.</p>
      </div>
    </div>
  `;

  const close = () => {
    overlay.hidden = true;
    overlay.innerHTML = "";
    closeOverlayHistory(close);
  };

  bindOverlay(overlay, close);

  overlay.querySelector('[data-action="close"]')?.addEventListener("click", close);
  overlay.querySelector('[data-action="safe-mode"]')?.addEventListener("click", () => {
    markBootStable();
    sessionStorage.setItem("vr-force-safe", "1");
    const url = new URL(location.href);
    url.searchParams.set("safe", "1");
    url.hash = "#/notfall";
    location.href = url.toString();
  });
}
