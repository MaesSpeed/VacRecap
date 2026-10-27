const RELOAD_KEY = "vr-thumb-mig-reload";

export function showMigrationRecovery(message) {
  const app = document.getElementById("app");
  if (!app) return;
  app.className = "screen screen--migration-fail";
  app.innerHTML = `
    <main class="safe-main">
      <p class="safe-lead">${message}</p>
      <button type="button" class="btn btn-emaille" data-action="reload">Neu laden</button>
    </main>
  `;
  app.querySelector('[data-action="reload"]')?.addEventListener("click", () => {
    sessionStorage.removeItem(RELOAD_KEY);
    location.reload();
  });
}

export async function runWithMigrationRecovery(run) {
  try {
    await run();
  } catch (err) {
    console.error("[vacrecap] thumb migration failed", err);
    if (!sessionStorage.getItem(RELOAD_KEY)) {
      sessionStorage.setItem(RELOAD_KEY, "1");
      location.reload();
      return;
    }
    sessionStorage.removeItem(RELOAD_KEY);
    showMigrationRecovery(
      "Die Vorschaubild-Migration konnte nicht abgeschlossen werden. Bitte einmal neu laden."
    );
    throw err;
  }
}
