import { assetUrl } from "./config.js";
import {
  clearAllMediaThumbs,
  getAllVacations,
  requestPersistentStorage,
} from "./db.js";
import {
  backupZipFilename,
  buildVacationZip,
  deliverBackupFile,
  gatherBackupStats,
} from "./backup-service.js";
import { handleRestoreZipFile } from "./ui-restore-sheet.js";
import { computeVacationStats } from "./vacation-stats.js";
import { markBootStable } from "./boot-stable.js";
import { escapeHtml } from "./utils.js";
import { APP_BUILD_VERSION } from "./app-version.js";

const appEl = document.getElementById("app");

async function listVacations() {
  const vacations = await getAllVacations();
  for (const v of vacations) {
    v.stats = await computeVacationStats(v.id);
  }
  return vacations;
}

function statsLine(stats) {
  if (!stats) return "";
  const p = stats.photos ?? 0;
  const v = stats.videos ?? 0;
  const n = stats.notes ?? 0;
  const o = stats.places ?? 0;
  const media =
    p || v
      ? `${p} Fotos${v ? ` · ${v} Videos` : ""}`
      : "0 Fotos";
  return `${o} Orte · ${media} · ${n} Notizen`;
}

async function render() {
  const vacations = await listVacations();
  appEl.className = "screen screen--safe";
  appEl.dataset.testid = "safe-mode-screen";
  appEl.innerHTML = `
    <header class="top-bar">
      <h1 class="top-bar__title">Notfallmodus</h1>
    </header>
    <main class="safe-main">
      <p class="safe-lead">Vereinfachte Ansicht ohne Karte und Vorschaubilder. Sicherungen und Einspielen funktionieren.</p>
      <ul class="safe-trip-list" data-testid="safe-trip-list">
        ${
          vacations.length
            ? vacations
                .map(
                  (v) => `
          <li class="safe-trip" data-vacation-id="${v.id}">
            <div class="safe-trip__text">
              <strong>${escapeHtml(v.title)}</strong>
              <span>${escapeHtml(statsLine(v.stats))}</span>
            </div>
            <button type="button" class="btn btn-emaille btn-emaille--ghost" data-action="backup" data-id="${v.id}">Sicherung speichern</button>
          </li>`
                )
                .join("")
            : `<li class="safe-trip safe-trip--empty">Keine Reisen gespeichert</li>`
        }
      </ul>
      <div class="safe-actions">
        <button type="button" class="btn btn-emaille" data-action="clear-thumbs">Vorschaubilder zurücksetzen</button>
        <button type="button" class="btn btn-emaille" data-action="restore">Sicherung einspielen</button>
        <button type="button" class="btn btn-emaille btn-emaille--ghost" data-action="normal">Normal starten</button>
      </div>
      <p class="settings-version" data-testid="app-version-line">Version ${APP_BUILD_VERSION}</p>
      <input type="file" accept=".zip,application/zip" hidden data-role="restore-input" />
    </main>
  `;

  appEl.querySelectorAll('[data-action="backup"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      btn.disabled = true;
      try {
        const stats = await gatherBackupStats(id);
        if (stats.isEmpty) return;
        const zip = await buildVacationZip(id);
        const file = new File([zip.blob], zip.filename || backupZipFilename(stats.vacation), {
          type: "application/zip",
        });
        await deliverBackupFile(file);
      } finally {
        btn.disabled = false;
      }
    });
  });

  appEl.querySelector('[data-action="clear-thumbs"]')?.addEventListener("click", async () => {
    const { clearAllThumbDecodeFailures } = await import("./thumb-decode-state.js");
    await clearAllMediaThumbs();
    clearAllThumbDecodeFailures();
    alert("Vorschaubilder gelöscht. Im Normalmodus werden sie nach und nach neu erzeugt.");
  });

  const restoreInput = appEl.querySelector('[data-role="restore-input"]');
  appEl.querySelector('[data-action="restore"]')?.addEventListener("click", () => restoreInput?.click());
  restoreInput?.addEventListener("change", async () => {
    const file = restoreInput.files?.[0];
    restoreInput.value = "";
    if (!file) return;
    await handleRestoreZipFile(file);
    await render();
  });

  appEl.querySelector('[data-action="normal"]')?.addEventListener("click", () => {
    markBootStable();
    sessionStorage.removeItem("vr-force-safe");
    sessionStorage.setItem("vr-normal-boot", "1");
    const base = location.pathname || "/";
    history.replaceState(null, "", base + "#/urlaube");
    location.reload();
  });
}

async function boot() {
  await requestPersistentStorage();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register(assetUrl("sw.js"), { updateViaCache: "none" }).catch(() => {});
  }
  await render();
}

boot();
