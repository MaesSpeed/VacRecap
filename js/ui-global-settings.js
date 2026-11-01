import { getUserId, signOut } from "./auth-service.js";
import { getSupabase } from "./supabase-client.js";
import { showToast } from "./toast.js";
import { escapeHtml } from "./utils.js";
import { APP_BUILD_VERSION } from "./app-version.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { bindSheetPull } from "./sheet-pull.js";
import { clearReadCache } from "./local-cache.js";

export function openGlobalSettingsSheet(hostEl) {
  const overlay = document.getElementById("overlay-root");
  if (!overlay) return;

  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="sheet sheet--settings-global" data-testid="global-settings-sheet">
      <div class="sheet-handle" data-role="pick-handle" aria-hidden="true"></div>
      <div class="sheet__header">
        <h2 class="sheet__title">Einstellungen</h2>
        <button type="button" class="sheet__close" data-action="close" aria-label="Schließen">×</button>
      </div>
      <div class="sheet__body">
        <p class="settings-item__sub">Version ${APP_BUILD_VERSION} · Cloud-Modus</p>
        <button type="button" class="settings-link-row" data-action="display-name" data-testid="display-name-row">
          <span class="kr-av kr-av--md" data-testid="display-name-preview" style="--kr:#5D6D7E">?</span>
          <span data-testid="display-name-label">Anzeigename</span>
        </button>
        <button type="button" class="settings-link-row" data-action="clear-cache">Offline-Cache leeren</button>
        <button type="button" class="settings-link-row" data-action="sign-out">Abmelden</button>
      </div>
    </div>
  `;

  const close = () => {
    overlay.hidden = true;
    overlay.innerHTML = "";
  };

  const activeClose = bindOverlay(overlay, close);
  const settingsSheet = overlay.querySelector('[data-testid="global-settings-sheet"]');
  bindSheetPull(settingsSheet, {
    onClose: () => closeOverlayHistory(activeClose),
    scrollEl: settingsSheet?.querySelector(".sheet__body") || settingsSheet,
  });

  overlay.querySelector('[data-action="close"]')?.addEventListener("click", () =>
    closeOverlayHistory(activeClose)
  );
  const preview = overlay.querySelector('[data-testid="display-name-preview"]');
  const label = overlay.querySelector('[data-testid="display-name-label"]');
  let profileName = "";
  void (async () => {
    try {
      const user = await getSupabase().auth.getUser();
      const id = user?.data?.user?.id;
      const email = user?.data?.user?.email || "";
      const fallback = email.split("@")[0] || "Ich";
      if (!id) return;
      const { data } = await getSupabase().from("profiles").select("display_name, avatar_color").eq("id", id).maybeSingle();
      profileName = String(data?.display_name || "").trim() || fallback;
      const color = data?.avatar_color || "#5D6D7E";
      const letter = Array.from(profileName)[0]?.toLocaleUpperCase("de-DE") || "?";
      if (preview) {
        preview.textContent = letter;
        preview.style.setProperty("--kr", color);
      }
      if (label) label.textContent = `Anzeigename · ${profileName}`;
    } catch {
      /* Profil ist optional, bis die Tabelle da ist */
    }
  })();
  overlay.querySelector('[data-action="display-name"]')?.addEventListener("click", () => {
    openDisplayNameEditor(hostEl, profileName);
  });
  overlay.querySelector('[data-action="clear-cache"]')?.addEventListener("click", () => {
    clearReadCache();
    closeOverlayHistory(activeClose);
  });
  overlay.querySelector('[data-action="sign-out"]')?.addEventListener("click", async () => {
    await signOut();
    closeOverlayHistory(activeClose);
    location.hash = "#/urlaube";
    location.reload();
  });
}

function openDisplayNameEditor(hostEl, current) {
  const overlay = document.getElementById("overlay-root");
  if (!overlay) return;
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="sheet sheet--settings-global" data-testid="display-name-sheet">
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet__header">
        <h2 class="sheet__title">Anzeigename</h2>
        <button type="button" class="sheet__close" data-action="close" aria-label="Schließen">×</button>
      </div>
      <div class="sheet__body">
        <label class="field">
          <span class="field__label">Anzeigename</span>
          <input type="text" maxlength="80" data-testid="display-name-input" value="${escapeHtml(current || "")}" />
        </label>
        <button type="button" class="btn btn-emaille btn-emaille--block" data-testid="display-name-save">Speichern</button>
      </div>
    </div>`;
  const close = () => openGlobalSettingsSheet(hostEl);
  const input = overlay.querySelector('[data-testid="display-name-input"]');
  overlay.querySelector('[data-action="close"]')?.addEventListener("click", close);
  overlay.querySelector('[data-testid="display-name-save"]')?.addEventListener("click", async () => {
    const name = input.value.trim();
    if (!name) {
      showToast("Bitte einen Anzeigenamen eingeben");
      return;
    }
    if (Array.from(name).length > 80) {
      showToast("Höchstens 80 Zeichen");
      return;
    }
    try {
      const id = await getUserId();
      const { data, error } = await getSupabase()
        .from("profiles")
        .update({ display_name: name })
        .eq("id", id)
        .select("display_name, avatar_color");
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row) {
        showToast(error?.message || "Anzeigename konnte nicht gespeichert werden.");
        return;
      }
      showToast("Anzeigename gespeichert");
      openGlobalSettingsSheet(hostEl);
    } catch (err) {
      showToast(err?.message || "Anzeigename konnte nicht gespeichert werden.");
    }
  });
}
