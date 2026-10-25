import {
  backupZipFilename,
  buildVacationZip,
  deliverBackupFile,
  gatherBackupStats,
  MAX_ZIP_BYTES,
} from "./backup-service.js";
import { dayIndexInTrip, dayRoleLabel, vacationDays } from "./days.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { setLastBackupTs } from "./settings-store.js";
import { formatBytesGerman } from "./storage-format.js";
import { showToast } from "./toast.js";
import { escapeHtml } from "./utils.js";

const ICON_DOC = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0066B3" stroke-width="2" aria-hidden="true"><path d="M7 4h7l5 5v11H7z"/><path d="M14 4v5h5"/></svg>`;
const ICON_IMG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0066B3" stroke-width="2" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M4 16l4-4 3 3 2-2 7 7"/></svg>`;
const ICON_NOTE = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0066B3" stroke-width="2" aria-hidden="true"><path d="M6 4h10l4 4v12H6z"/><path d="M14 4v4h4"/></svg>`;
const ICON_PIN = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0066B3" stroke-width="2" aria-hidden="true"><path d="M12 21s7-4.5 7-11a7 7 0 1 0-14 0c0 6.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>`;
const ICON_LOCK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B6B7A" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
const ICON_DL = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" aria-hidden="true"><path d="M12 5v10"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/></svg>`;

function mediaSummary(photos, videos) {
  const parts = [];
  if (photos > 0) parts.push(`${photos} Foto${photos === 1 ? "" : "s"}`);
  if (videos > 0) parts.push(`${videos} Video${videos === 1 ? "" : "s"}`);
  return parts.join(" · ") || "0 Fotos";
}

function noteSummary(n) {
  return `${n} Notiz${n === 1 ? "" : "en"}`;
}

function placeDaySummary(placeCount, dayCount) {
  return `${placeCount} Ort${placeCount === 1 ? "" : "e"} · ${dayCount} Tag${dayCount === 1 ? "" : "e"}`;
}

export function openBackupSheet({ vacationId, onSaved }) {
  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;
  overlay.classList.add("overlay-root--bleed");

  let preparedFile = null;
  let preparing = true;
  let prepareError = null;
  let stats = null;
  let cancelled = false;

  const close = () => {
    cancelled = true;
    overlay.classList.remove("overlay-root--bleed");
    overlay.hidden = true;
    overlay.innerHTML = "";
  };

  overlay.innerHTML = `
    <div class="sheet sheet--backup" data-testid="backup-sheet">
      <div class="sheet__grab" aria-hidden="true"></div>
      <header class="backup-sheet__head">
        <button type="button" class="backup-sheet__cancel" data-action="cancel">Abbrechen</button>
        <h2 class="backup-sheet__title">Sicherung</h2>
        <span class="backup-sheet__head-spacer"></span>
      </header>
      <div class="backup-sheet__body" data-role="body">Laden…</div>
    </div>
  `;

  const activeClose = bindOverlay(overlay, close);

  const bodyEl = overlay.querySelector('[data-role="body"]');
  const saveBtn = () => overlay.querySelector('[data-action="save"]');

  function renderBody() {
    if (!stats) return;
    const filename = backupZipFilename(stats.vacation);
    const sizeLabel = `ca. ${formatBytesGerman(stats.totalBytes)}`;
    const dayCount = stats.days.length;

    if (stats.isEmpty) {
      bodyEl.innerHTML = `
        <p class="backup-sheet__empty">Noch nichts zu sichern.</p>
        <button type="button" class="btn btn-emaille btn-emaille--block backup-sheet__save" disabled>Sicherung speichern</button>
      `;
      return;
    }

    const tooLarge = stats.tooLarge;
    const dayButtons = tooLarge
      ? stats.days
          .map((day) => {
            const idx = dayIndexInTrip(stats.vacation, day);
            const label = dayRoleLabel(idx, vacationDays(stats.vacation).length);
            return `<button type="button" class="backup-sheet__day-btn" data-day="${day}">${escapeHtml(label)} sichern</button>`;
          })
          .join("")
      : "";

    bodyEl.innerHTML = `
      <div class="backup-file-card">
        <span class="backup-file-card__icon">${ICON_DOC}</span>
        <div class="backup-file-card__text">
          <span class="backup-file-card__name">${escapeHtml(filename)}</span>
          <span class="backup-file-card__size">${sizeLabel}</span>
        </div>
      </div>
      <div class="backup-stat-rows">
        <div class="backup-stat-row">
          <span class="backup-stat-row__icon">${ICON_IMG}</span>
          <div class="backup-stat-row__text">
            <span class="backup-stat-row__title">${escapeHtml(mediaSummary(stats.photos, stats.videos))}</span>
            <span class="backup-stat-row__sub">in Originalqualität</span>
          </div>
        </div>
        <div class="backup-stat-row">
          <span class="backup-stat-row__icon">${ICON_NOTE}</span>
          <div class="backup-stat-row__text">
            <span class="backup-stat-row__title">${escapeHtml(noteSummary(stats.notes))}</span>
            <span class="backup-stat-row__sub">als Text</span>
          </div>
        </div>
        <div class="backup-stat-row">
          <span class="backup-stat-row__icon">${ICON_PIN}</span>
          <div class="backup-stat-row__text">
            <span class="backup-stat-row__title">${escapeHtml(placeDaySummary(stats.placeCount, dayCount))}</span>
            <span class="backup-stat-row__sub">mit Zeit und Position</span>
          </div>
        </div>
      </div>
      <p class="backup-sheet__lock">${ICON_LOCK} Alles bleibt nur auf deinem Handy gespeichert.</p>
      ${
        tooLarge
          ? `<p class="backup-sheet__warn">Zu groß für eine Datei – bitte nach Tagen sichern</p><div class="backup-sheet__days">${dayButtons}</div>`
          : `<button type="button" class="btn btn-emaille btn-emaille--block backup-sheet__save" data-action="save" disabled>
        <span class="backup-sheet__save-icon">${ICON_DL}</span>
        <span data-role="save-label">Wird vorbereitet …</span>
      </button>`
      }
    `;

    if (!tooLarge) {
      overlay.querySelector('[data-action="save"]')?.addEventListener("click", () => void onSave());
    }
    overlay.querySelectorAll("[data-day]").forEach((btn) => {
      btn.addEventListener("click", () => void onSaveDay(btn.dataset.day));
    });
  }

  function setSaveLabel(text, disabled = true) {
    const btn = saveBtn();
    const label = overlay.querySelector('[data-role="save-label"]');
    if (label) label.textContent = text;
    if (btn) btn.disabled = disabled;
  }

  async function prepareZip(daysFilter = null) {
    preparing = true;
    preparedFile = null;
    prepareError = null;
    try {
      const result = await buildVacationZip(vacationId, {
        daysFilter,
        onProgress: (pct) => {
          if (cancelled) return;
          setSaveLabel(`Wird vorbereitet … ${pct} %`, true);
        },
      });
      if (cancelled) return;
      const file = new File([result.blob], result.filename, { type: "application/zip" });
      preparedFile = file;
      preparing = false;
      setSaveLabel("Sicherung speichern", false);
    } catch (err) {
      console.error(err);
      prepareError = err;
      preparing = false;
      setSaveLabel("Sicherung fehlgeschlagen", true);
    }
  }

  async function onSave() {
    if (!preparedFile || preparing) return;
    try {
      const outcome = await deliverBackupFile(preparedFile);
      if (outcome.aborted) return;
      await setLastBackupTs(vacationId, Date.now());
      closeOverlayHistory(activeClose);
      const extra =
        outcome.method === "download"
          ? "Die Datei liegt in »Dateien« bzw. Downloads"
          : null;
      showToast(preparedFile.name, {
        title: "Sicherung gespeichert",
        duration: 2500,
      });
      if (extra) {
        setTimeout(() => showToast(extra, { duration: 2500 }), 2600);
      }
      onSaved?.();
    } catch (err) {
      console.error(err);
      showToast("Sicherung fehlgeschlagen");
    }
  }

  async function onSaveDay(day) {
    preparing = true;
    setSaveLabel("Wird vorbereitet … 0 %", true);
    await prepareZip([day]);
    if (preparedFile) await onSave();
  }

  overlay.querySelector('[data-action="cancel"]').addEventListener("click", () =>
    closeOverlayHistory(activeClose)
  );

  void (async () => {
    stats = await gatherBackupStats(vacationId);
    if (cancelled || !stats) return;
    renderBody();
    if (!stats.isEmpty && !stats.tooLarge) {
      await prepareZip();
    }
  })();
}
