import { signOut } from "./auth-service.js";
import { APP_BUILD_VERSION } from "./app-version.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { clearReadCache } from "./local-cache.js";

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
        <p class="settings-item__sub">Version ${APP_BUILD_VERSION} · Cloud-Modus</p>
        <button type="button" class="settings-link-row" data-action="clear-cache">Offline-Cache leeren</button>
        <button type="button" class="settings-link-row" data-action="sign-out">Abmelden</button>
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
  overlay.querySelector('[data-action="clear-cache"]')?.addEventListener("click", () => {
    clearReadCache();
    close();
  });
  overlay.querySelector('[data-action="sign-out"]')?.addEventListener("click", async () => {
    await signOut();
    close();
    location.hash = "#/urlaube";
    location.reload();
  });
}
