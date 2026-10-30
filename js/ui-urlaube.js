import { bindCoverImage, resolveVacationCoverMap } from "./cover-sources.js";
import { armPointerSuppression } from "./gesture-guard.js";
import { bindOverlay, closeOverlayHistory, releaseOverlayHistory } from "./overlay-stack.js";
import { computeVacationStats, formatVacationStatsLine } from "./vacation-stats.js";
import { navigate } from "./router.js";
import { clearTripUiState } from "./ui-urlaub-detail.js";
import { avatarListForVacation } from "./vacation.js";
import {
  currentDayIndex,
  dayCountInclusive,
  daysUntilStart,
  escapeHtml,
  formatCountdown,
  formatDateRangeCard,
  formatDateRangeOverlay,
  initialsFromNames,
  tripStatus,
} from "./utils.js";

const LONG_PRESS_MS = 550;
const CHEVRON_SVG = `<svg width="8" height="14" viewBox="0 0 8 14" fill="none" aria-hidden="true"><path d="M1 1l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export async function renderUrlaubeScreen(appEl, vacations) {
  const mountGen = appEl?.dataset?.appRenderGen ?? "";
  for (const v of vacations) {
    v.stats = await computeVacationStats(v.id);
  }
  const grouped = { current: [], upcoming: [], past: [] };
  vacations
    .slice()
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .forEach((v) => {
      grouped[tripStatus(v.startDate, v.endDate)].push(v);
    });
  grouped.upcoming.sort((a, b) => a.startDate.localeCompare(b.startDate));
  grouped.past.sort((a, b) => b.endDate.localeCompare(a.endDate));

  appEl.className = "screen screen--urlaube";
  delete appEl.dataset.vacationId;
  appEl.innerHTML = `
    <header class="top-bar">
      <h1 class="top-bar__title">Reisen</h1>
      <div class="top-bar__actions">
        <button type="button" class="icon-btn" data-action="settings" aria-label="Einstellungen">
          <svg class="icon-gear" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button type="button" class="icon-btn icon-btn--emaille" data-action="new" aria-label="Neue Reise anlegen">
          <span aria-hidden="true">+</span>
        </button>
      </div>
    </header>
    <main class="urlaube-main">
      ${
        vacations.length === 0
          ? `<div class="empty-state" data-testid="urlaube-empty">
        <p>Noch keine Reisen – lege deine erste an.</p>
        <button type="button" class="btn btn-emaille" data-action="new">Neue Reise anlegen</button>
      </div>`
          : ""
      }
      ${grouped.current.length ? sectionCurrent(grouped.current) : ""}
      ${grouped.upcoming.length ? sectionList("Bevorstehend", grouped.upcoming, "upcoming") : ""}
      ${grouped.past.length ? sectionList("Vergangen", grouped.past, "past") : ""}
      ${
        vacations.length
          ? `<button type="button" class="card card--dashed" data-action="new">
        <span class="card--dashed__icon">+</span>
        <span>Neue Reise anlegen</span>
      </button>`
          : ""
      }
    </main>
  `;

  const coverMap = await resolveVacationCoverMap(vacations, { variant: "thumb" });
  if (appEl?.dataset?.appRenderGen !== mountGen) return;

  appEl.querySelectorAll("[data-vacation-id]").forEach((card) => {
    const id = card.dataset.vacationId;
    const img = card.querySelector("[data-cover-img]");
    const info = coverMap.get(id);
    const vacation = vacations.find((entry) => entry.id === id);
    if (img && info && vacation) bindCoverImage(img, info, vacation, { variant: "thumb" });
  });

  appEl.querySelectorAll('[data-action="new"]').forEach((btn) => {
    btn.addEventListener("click", () => navigate({ name: "urlaub-form", mode: "create" }));
  });

  appEl.querySelector('[data-action="settings"]')?.addEventListener("click", () => {
    import("./ui-global-settings.js").then(({ openGlobalSettingsSheet }) =>
      openGlobalSettingsSheet(appEl)
    );
  });

  appEl.querySelectorAll("[data-vacation-id]").forEach((card) => {
    bindCardInteractions(card, vacations);
  });
}

function sectionCurrent(items) {
  return `
    <section class="urlaube-section">
      <h2 class="section-label">Läuft jetzt</h2>
      ${items.map((v) => cardCurrent(v)).join("")}
    </section>
  `;
}

function sectionList(label, items, kind) {
  return `
    <section class="urlaube-section">
      <h2 class="section-label">${label}</h2>
      ${items.map((v) => cardCompact(v, kind)).join("")}
    </section>
  `;
}

function cardCurrent(v) {
  const total = dayCountInclusive(v.startDate, v.endDate);
  const day = currentDayIndex(v.startDate, v.endDate);
  const avatars = renderAvatars(v);
  const dayLabel = total === 1 ? "1 Tag" : `Tag ${day} von ${total}`;
  return `
    <article class="card card--hero" data-vacation-id="${v.id}" tabindex="0">
      <div class="card--hero__media">
        <img data-cover-img alt="" />
        <span class="badge badge--day">${dayLabel}</span>
        <div class="card--hero__overlay">
          <h3 class="card--hero__title">${escapeHtml(v.title)}</h3>
          <p class="card--hero__dates">${formatDateRangeOverlay(v.startDate, v.endDate)}</p>
        </div>
      </div>
      <div class="card--hero__footer">
        <span>${formatVacationStatsLine(v.stats)}</span>
        <div class="avatars">${avatars}</div>
      </div>
    </article>
  `;
}

function cardCompact(v, kind) {
  const avatars = renderAvatars(v);
  const meta =
    kind === "upcoming"
      ? `<span class="card-compact__countdown">${formatCountdown(daysUntilStart(v.startDate))}</span>`
      : `<span class="card-compact__stats">${formatVacationStatsLine(v.stats)}</span>`;
  return `
    <article class="card card--compact" data-vacation-id="${v.id}" tabindex="0">
      <div class="card-compact__thumb">
        <img data-cover-img alt="" />
      </div>
      <div class="card-compact__body">
        <h3 class="card-compact__title">${escapeHtml(v.title)}</h3>
        <p class="card-compact__dates">${formatDateRangeCard(v.startDate, v.endDate)}</p>
        <div class="card-compact__meta">
          ${meta}
          <div class="avatars">${avatars}</div>
        </div>
      </div>
      <span class="card-compact__chevron" aria-hidden="true">${CHEVRON_SVG}</span>
    </article>
  `;
}

function renderAvatars(v) {
  const names = avatarListForVacation(v);
  const items = initialsFromNames(names);
  const extra =
    names.length > 3 ? `<span class="avatar avatar--more">+${names.length - 3}</span>` : "";
  return (
    items
      .map(
        (a) =>
          `<span class="avatar" style="--avatar-bg:${a.color}">${escapeHtml(a.label)}</span>`
      )
      .join("") + extra
  );
}

function bindCardInteractions(card, vacations) {
  const id = card.dataset.vacationId;
  let pressTimer = null;
  let longPressed = false;
  let blockClickUntil = 0;

  const clearPress = () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
  };

  card.addEventListener("contextmenu", (e) => e.preventDefault());

  card.addEventListener("pointerdown", () => {
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      blockClickUntil = Date.now() + 450;
      armPointerSuppression(400, card);
      showCardMenu(id, vacations);
    }, LONG_PRESS_MS);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) =>
    card.addEventListener(ev, clearPress)
  );

  card.addEventListener("click", (e) => {
    if (Date.now() < blockClickUntil) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    longPressed = false;
    clearTripUiState(id);
    navigate({ name: "urlaub-detail", id });
  });
}

function showCardMenu(id, vacations) {
  const vacation = vacations.find((v) => v.id === id);
  if (!vacation) return;

  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="action-sheet" role="dialog" aria-label="Reise-Aktionen" data-testid="vacation-action-sheet">
      <p class="action-sheet__title">${escapeHtml(vacation.title)}</p>
      <button type="button" data-action="edit">Bearbeiten</button>
      <button type="button" data-action="delete" class="danger">Löschen</button>
      <button type="button" data-action="cancel">Abbrechen</button>
    </div>
  `;

  const close = () => {
    overlay.hidden = true;
    overlay.innerHTML = "";
  };

  const activeClose = bindOverlay(overlay, close);

  overlay.querySelector('[data-action="cancel"]').addEventListener("click", () =>
    closeOverlayHistory(activeClose)
  );
  overlay.querySelector('[data-action="edit"]').addEventListener("click", () => {
    releaseOverlayHistory(activeClose);
    navigate({ name: "urlaub-form", mode: "edit", id });
  });
  overlay.querySelector('[data-action="delete"]').addEventListener("click", () => {
    closeOverlayHistory(activeClose);
    confirmDelete(id, vacation.title);
  });
}

function confirmDelete(id, title) {
  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="confirm-dialog" role="alertdialog" aria-labelledby="confirm-title">
      <h2 id="confirm-title">Reise löschen?</h2>
      <p>Alle Orte, Fotos und Notizen dieser Reise werden entfernt.</p>
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

  const activeClose = bindOverlay(overlay, close);

  overlay.querySelector('[data-action="cancel"]').addEventListener("click", () =>
    closeOverlayHistory(activeClose)
  );
  overlay.querySelector('[data-action="confirm"]').addEventListener("click", async () => {
    const { deleteVacation, getVacation, deleteBlob, deleteVacationData } =
      await import("./db.js");
    const v = await getVacation(id);
    if (v?.cover?.type === "custom" && v.cover.blobId) {
      await deleteBlob(v.cover.blobId);
    }
    await deleteVacationData(id);
    await deleteVacation(id);
    closeOverlayHistory(activeClose);
    const { showToast } = await import("./toast.js");
    showToast("Reise gelöscht");
    window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
    navigate({ name: "urlaube" }, { replace: true });
  });
}
