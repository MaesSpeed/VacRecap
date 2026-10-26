import {
  checkStorageForRestore,
  parseBackupZip,
  restoreVacationFromZip,
  RestoreError,
  vacationIdExists,
} from "./restore-service.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { navigate } from "./router.js";
import { showToast } from "./toast.js";
import { openConfirmDialog } from "./ui-confirm.js";
export function wireRestoreZipInput(hostEl, triggerSelector) {
  let input = hostEl.querySelector('[data-role="restore-input"]');
  if (!input) {
    input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.hidden = true;
    input.dataset.role = "restore-input";
    input.dataset.testid = "restore-zip-input";
    hostEl.appendChild(input);
  }
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (file) void handleRestoreZipFile(file);
  });
  hostEl.querySelectorAll(triggerSelector).forEach((btn) => {
    btn.addEventListener("click", () => input.click());
  });
}

export async function handleRestoreZipFile(file) {
  try {
    const { manifest } = await parseBackupZip(file);
    const storage = await checkStorageForRestore(file);
    if (!storage.ok) {
      showToast(storage.message, { icon: "none" });
      return;
    }
    let duplicateMode = "import";
    if (await vacationIdExists(manifest.vacation.id)) {
      const addCopy = await openConfirmDialog({
        title: "Diese Reise ist schon vorhanden",
        message: "Die Sicherung kann als zweite Reise hinzugefügt werden. Vorhandene Daten werden nicht überschrieben.",
        confirmLabel: "Als zweite Reise hinzufügen",
        cancelLabel: "Abbrechen",
        danger: false,
        testId: "confirm-restore-duplicate",
      });
      if (!addCopy) return;
      duplicateMode = "new-copy";
    }
    openRestoreProgressSheet(file, { duplicateMode });
  } catch (err) {
    const msg = err instanceof RestoreError ? err.userMessage : "Einspielen fehlgeschlagen.";
    showToast(msg, { icon: "none" });
  }
}

function openRestoreProgressSheet(file, { duplicateMode }) {
  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;
  overlay.classList.add("overlay-root--bleed");
  let cancelled = false;

  const close = () => {
    cancelled = true;
    overlay.classList.remove("overlay-root--bleed");
    overlay.hidden = true;
    overlay.innerHTML = "";
  };

  overlay.innerHTML = `
    <div class="sheet sheet--backup" data-testid="restore-sheet">
      <div class="sheet__grab" aria-hidden="true"></div>
      <header class="backup-sheet__head">
        <button type="button" class="backup-sheet__cancel" data-action="cancel">Abbrechen</button>
        <h2 class="backup-sheet__title">Sicherung einspielen</h2>
        <span class="backup-sheet__head-spacer"></span>
      </header>
      <div class="backup-sheet__body">
        <p class="backup-sheet__progress-label" data-role="label">Starte…</p>
        <div class="backup-sheet__progress" aria-hidden="true">
          <div class="backup-sheet__progress-bar" data-role="bar" style="width:0%"></div>
        </div>
        <p class="backup-sheet__progress-pct" data-role="pct">0 %</p>
      </div>
    </div>
  `;

  const activeClose = bindOverlay(overlay, close);
  overlay.querySelector('[data-action="cancel"]').addEventListener("click", () =>
    closeOverlayHistory(activeClose)
  );

  const labelEl = overlay.querySelector('[data-role="label"]');
  const barEl = overlay.querySelector('[data-role="bar"]');
  const pctEl = overlay.querySelector('[data-role="pct"]');

  void restoreVacationFromZip(file, {
    duplicateMode,
    isCancelled: () => cancelled,
    onProgress: ({ percent, label }) => {
      if (cancelled) return;
      labelEl.textContent = label || "…";
      barEl.style.width = `${percent}%`;
      pctEl.textContent = `${percent} %`;
    },
  })
    .then(({ vacationId }) => {
      if (cancelled) return;
      closeOverlayHistory(activeClose);
      showToast("Reise eingespielt");
      navigate({ name: "urlaub-detail", id: vacationId });
      window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
    })
    .catch((err) => {
      if (cancelled || err?.code === "cancelled") return;
      closeOverlayHistory(activeClose);
      const msg = err instanceof RestoreError ? err.userMessage : "Einspielen fehlgeschlagen.";
      showToast(msg, { icon: "none" });
    });
}
