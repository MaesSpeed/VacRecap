import { deleteBlob, deleteVacation, deleteVacationData, getVacation } from "./db.js";
import { ICON_BACK_CHEVRON } from "./icons.js";
import { navigate } from "./router.js";
import {
  getRememberCaptureLocation,
  getRememberLocationOnOpen,
  getSamePlaceRadiusM,
  samePlaceRadiusOptions,
  setRememberCaptureLocation,
  setRememberLocationOnOpen,
  setSamePlaceRadiusM,
} from "./settings-store.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { showToast } from "./toast.js";
import { escapeHtml } from "./utils.js";

const ICON_CROSSHAIR = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0066B3" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.5" fill="#0066B3" stroke="none"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>`;
const ICON_RADIUS = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0066B3" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="7" stroke-dasharray="3 3"/><circle cx="12" cy="12" r="1.5" fill="#0066B3" stroke="none"/><path d="M12 8v2l2 1.5"/></svg>`;
const ICON_CAMERA = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0066B3" stroke-width="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;
const ICON_BACKUP = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0066B3" stroke-width="2" aria-hidden="true"><rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 11l3 3 3-3"/></svg>`;
const ICON_LOCK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B6B7A" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
const ICON_CHEVRON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#B8C5D1" stroke-width="1.75" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;

function switchHtml(id, on, label) {
  return `<button type="button" class="ios-switch${on ? " ios-switch--on" : ""}" role="switch" data-testid="${id}" aria-checked="${on ? "true" : "false"}" aria-label="${escapeHtml(label)}"><span class="ios-switch__knob" aria-hidden="true"></span></button>`;
}

export async function renderUrlaubSettings(appEl, id) {
  const vacation = await getVacation(id);
  if (!vacation) {
    navigate({ name: "urlaube" });
    return;
  }

  const [remember, radiusM, captureLoc] = await Promise.all([
    getRememberLocationOnOpen(),
    getSamePlaceRadiusM(),
    getRememberCaptureLocation(),
  ]);
  const radiusOptions = samePlaceRadiusOptions();

  appEl.className = "screen screen--settings";
  appEl.dataset.testid = "settings-screen";
  appEl.innerHTML = `
    <header class="map-header settings-header">
      <button type="button" class="map-header__back" data-action="back">${ICON_BACK_CHEVRON}<span class="map-header__trip">${escapeHtml(vacation.title)}</span></button>
      <h1 class="map-header__title">Einstellungen</h1>
      <span class="map-header__spacer" aria-hidden="true"></span>
    </header>
    <main class="settings-main settings-main--draft">
      <section class="settings-block">
        <h2 class="settings-block__label">Standort · Alle Urlaube</h2>
        <div class="settings-card">
          <div class="settings-item settings-item--switch" data-action="toggle-remember">
            <span class="settings-item__icon">${ICON_CROSSHAIR}</span>
            <div class="settings-item__text">
              <span class="settings-item__title">Standort beim Öffnen merken</span>
              <span class="settings-item__sub">Setzt beim Öffnen einen weichen Punkt</span>
            </div>
            ${switchHtml("remember-location", remember, "Standort beim Öffnen merken")}
          </div>
          <div class="settings-item settings-item--stack">
            <div class="settings-item__row">
              <span class="settings-item__icon">${ICON_RADIUS}</span>
              <div class="settings-item__text">
                <span class="settings-item__title">Gleicher Ort bis</span>
                <span class="settings-item__sub">Darüber entsteht eine neue Karte</span>
              </div>
              <span class="settings-item__value" data-role="radius-value">${radiusM} m</span>
            </div>
            <div class="settings-segments" data-role="radius-segments">
              ${radiusOptions
                .map(
                  (m) =>
                    `<button type="button" class="settings-segment${m === radiusM ? " settings-segment--active" : ""}" data-radius="${m}">${m} m</button>`
                )
                .join("")}
            </div>
          </div>
        </div>
      </section>
      <section class="settings-block">
        <h2 class="settings-block__label">Fotos &amp; Videos</h2>
        <div class="settings-card">
          <div class="settings-item settings-item--switch" data-action="toggle-capture">
            <span class="settings-item__icon">${ICON_CAMERA}</span>
            <div class="settings-item__text">
              <span class="settings-item__title">Aufnahmeort merken</span>
              <span class="settings-item__sub">Foto und Video setzen einen Ort</span>
            </div>
            ${switchHtml("remember-capture", captureLoc, "Aufnahmeort merken")}
          </div>
        </div>
      </section>
      <section class="settings-block">
        <h2 class="settings-block__label">Daten</h2>
        <div class="settings-card settings-card--tight">
          <button type="button" class="settings-item settings-item--link" data-action="backup">
            <span class="settings-item__icon">${ICON_BACKUP}</span>
            <div class="settings-item__text">
              <span class="settings-item__title">Sicherung speichern</span>
              <span class="settings-item__sub">ZIP mit allen Fotos, Videos und Notizen</span>
            </div>
            <span class="settings-item__chevron">${ICON_CHEVRON}</span>
          </button>
        </div>
        <p class="settings-privacy">${ICON_LOCK} Alles wird nur auf deinem Handy gespeichert.</p>
      </section>
      <section class="settings-block">
        <h2 class="settings-block__label">Urlaub</h2>
        <div class="settings-card settings-card--links">
          <button type="button" class="settings-link-row" data-action="edit">Urlaub bearbeiten</button>
          <button type="button" class="settings-link-row settings-link-row--danger" data-action="delete">Urlaub löschen</button>
        </div>
      </section>
    </main>
  `;

  appEl.querySelector('[data-action="back"]').addEventListener("click", () => {
    navigate({ name: "urlaub-detail", id });
  });

  const rememberBtn = appEl.querySelector('[data-testid="remember-location"]');
  const captureBtn = appEl.querySelector('[data-testid="remember-capture"]');
  const radiusValue = appEl.querySelector('[data-role="radius-value"]');

  const setSwitch = (btn, on) => {
    btn.setAttribute("aria-checked", on ? "true" : "false");
    btn.classList.toggle("ios-switch--on", on);
  };

  const wireSwitch = (btn, rowAction, persist) => {
    const toggle = () => {
      const next = btn.getAttribute("aria-checked") !== "true";
      setSwitch(btn, next);
      void persist(next).then(() => {
        window.dispatchEvent(new CustomEvent("vacrecap:setting-saved"));
      });
    };
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggle();
    });
    appEl.querySelector(`[data-action="${rowAction}"]`)?.addEventListener("click", (e) => {
      if (e.target.closest(".ios-switch")) return;
      toggle();
    });
  };

  wireSwitch(rememberBtn, "toggle-remember", setRememberLocationOnOpen);
  wireSwitch(captureBtn, "toggle-capture", setRememberCaptureLocation);

  appEl.querySelectorAll("[data-radius]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const m = Number(btn.dataset.radius);
      void setSamePlaceRadiusM(m).then(() => {
        radiusValue.textContent = `${m} m`;
        appEl.querySelectorAll("[data-radius]").forEach((b) => {
          b.classList.toggle("settings-segment--active", Number(b.dataset.radius) === m);
        });
        window.dispatchEvent(new CustomEvent("vacrecap:setting-saved"));
      });
    });
  });

  appEl.querySelector('[data-action="backup"]').addEventListener("click", () => {
    showToast("Kommt im nächsten Schritt");
  });

  appEl.querySelector('[data-action="edit"]').addEventListener("click", () => {
    sessionStorage.setItem(
      "vacrecap-form-return",
      JSON.stringify({ name: "urlaub-settings", id })
    );
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

  bindOverlay(overlay, close);

  overlay.querySelector('[data-action="cancel"]').addEventListener("click", () =>
    closeOverlayHistory(close)
  );
  overlay.querySelector('[data-action="confirm"]').addEventListener("click", async () => {
    if (vacation.cover?.type === "custom" && vacation.cover.blobId) {
      await deleteBlob(vacation.cover.blobId);
    }
    await deleteVacationData(vacation.id);
    await deleteVacation(vacation.id);
    closeOverlayHistory(close);
    showToast("Urlaub gelöscht");
    window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
    navigate({ name: "urlaube" }, { replace: true });
  });
}
