import { deleteBlob, deletePlacesForVacation, deleteVacation, getVacation } from "./db.js";
import { navigate } from "./router.js";
import {
  getRememberLocationOnOpen,
  setRememberLocationOnOpen,
} from "./settings-store.js";
import { showToast } from "./toast.js";
import { escapeHtml } from "./utils.js";

export async function renderUrlaubSettings(appEl, id) {
  const vacation = await getVacation(id);
  if (!vacation) {
    navigate({ name: "urlaube" });
    return;
  }

  const remember = await getRememberLocationOnOpen();

  appEl.className = "screen screen--settings";
  appEl.innerHTML = `
    <header class="trip-header">
      <button type="button" class="link-btn link-btn--back" data-action="back">‹ ${escapeHtml(vacation.title)}</button>
      <h1 class="trip-header__title">Einstellungen</h1>
      <span class="trip-header__actions"></span>
    </header>
    <main class="settings-main">
      <section class="settings-section">
        <h2 class="settings-section__label">Standort</h2>
        <div class="settings-row settings-row--switch" data-action="toggle-row">
          <span>Standort beim Öffnen merken</span>
          <button
            type="button"
            class="ios-switch"
            role="switch"
            data-testid="remember-location"
            aria-checked="${remember ? "true" : "false"}"
            aria-label="Standort beim Öffnen merken"
          >
            <span class="ios-switch__knob" aria-hidden="true"></span>
          </button>
        </div>
      </section>
      <section class="settings-section">
        <h2 class="settings-section__label">Daten</h2>
        <button type="button" class="settings-link" data-action="backup">Sicherung speichern</button>
      </section>
      <section class="settings-section">
        <h2 class="settings-section__label">Urlaub</h2>
        <button type="button" class="settings-link" data-action="edit">Urlaub bearbeiten</button>
        <button type="button" class="settings-link settings-link--danger" data-action="delete">Urlaub löschen</button>
      </section>
    </main>
  `;

  appEl.querySelector('[data-action="back"]').addEventListener("click", () => {
    navigate({ name: "urlaub-detail", id });
  });

  const switchBtn = appEl.querySelector('[data-testid="remember-location"]');

  const setSwitch = (on) => {
    switchBtn.setAttribute("aria-checked", on ? "true" : "false");
    switchBtn.classList.toggle("ios-switch--on", on);
  };
  setSwitch(remember);

  const persistSwitch = (on) => {
    void setRememberLocationOnOpen(on).then(() => {
      window.dispatchEvent(new CustomEvent("vacrecap:setting-saved"));
    });
  };

  const toggleRow = () => {
    const next = switchBtn.getAttribute("aria-checked") !== "true";
    setSwitch(next);
    persistSwitch(next);
  };

  switchBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleRow();
  });

  appEl.querySelector('[data-action="toggle-row"]').addEventListener("click", (e) => {
    if (e.target.closest(".ios-switch")) return;
    toggleRow();
  });

  appEl.querySelector('[data-action="backup"]').addEventListener("click", () => {
    showToast("Kommt im nächsten Schritt");
  });

  appEl.querySelector('[data-action="edit"]').addEventListener("click", () => {
    navigate({ name: "urlaub-form", mode: "edit", id });
  });

  appEl.querySelector('[data-action="delete"]').addEventListener("click", () => {
    confirmDeleteVacation(vacation);
  });
}

function confirmDeleteVacation(vacation) {
  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="confirm-dialog" role="alertdialog">
      <h2>Urlaub löschen?</h2>
      <p>«${escapeHtml(vacation.title)}» wird unwiderruflich gelöscht.</p>
      <div class="confirm-dialog__actions">
        <button type="button" data-action="cancel">Abbrechen</button>
        <button type="button" data-action="confirm" class="danger">Löschen</button>
      </div>
    </div>
  `;

  const close = () => {
    overlay.hidden = true;
    overlay.innerHTML = "";
  };

  overlay.querySelector('[data-action="cancel"]').addEventListener("click", close);
  overlay.querySelector('[data-action="confirm"]').addEventListener("click", async () => {
    if (vacation.cover?.type === "custom" && vacation.cover.blobId) {
      await deleteBlob(vacation.cover.blobId);
    }
    await deletePlacesForVacation(vacation.id);
    await deleteVacation(vacation.id);
    close();
    showToast("Urlaub gelöscht");
    window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
    navigate({ name: "urlaube" });
  });
}
