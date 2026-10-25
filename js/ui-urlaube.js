import { resolveCoverSrc } from "./covers.js";
import { getBlob } from "./db.js";
import { navigate } from "./router.js";
import { avatarListForVacation } from "./vacation.js";
import {
  currentDayIndex,
  dayCountInclusive,
  daysUntilStart,
  escapeHtml,
  formatCountdown,
  formatDateRange,
  initialsFromNames,
  tripStatus,
} from "./utils.js";

const LONG_PRESS_MS = 550;

export async function renderUrlaubeScreen(appEl, vacations) {
  const today = new Date();
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
  appEl.innerHTML = `
    <header class="top-bar">
      <h1 class="top-bar__title">Urlaube</h1>
      <div class="top-bar__actions">
        <button type="button" class="icon-btn" data-action="settings" aria-label="Einstellungen">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.9.9-.7a.8.8 0 0 0 .2-1l-.9-1.5a.8.8 0 0 0-.9-.4l-1 .2a7.2 7.2 0 0 0-1.6-1l-.2-1.1a.8.8 0 0 0-.8-.7h-1.8a.8.8 0 0 0-.8.7l-.2 1.1a7.2 7.2 0 0 0-1.6 1l-1-.2a.8.8 0 0 0-.9.4l-.9 1.5a.8.8 0 0 0 .2 1l.9.7a6.5 6.5 0 0 0 0 2l-.9.7a.8.8 0 0 0-.2 1l.9 1.5c.2.3.6.4.9.3l1-.2c.5.5 1 .9 1.6 1.2l.2 1.1c.1.4.4.7.8.7h1.8c.4 0 .7-.3.8-.7l.2-1.1c.6-.3 1.1-.7 1.6-1.2l1 .2c.3.1.7 0 .9-.3l.9-1.5a.8.8 0 0 0-.2-1l-.9-.7a6.5 6.5 0 0 0 0-2Z" fill="currentColor"/></svg>
        </button>
        <button type="button" class="icon-btn icon-btn--emaille" data-action="new" aria-label="Neuen Urlaub anlegen">
          <span aria-hidden="true">+</span>
        </button>
      </div>
    </header>
    <main class="urlaube-main">
      ${
        vacations.length === 0
          ? `<div class="empty-state">
        <p>Noch keine Urlaube – lege deinen ersten an.</p>
        <button type="button" class="btn btn-emaille" data-action="new">Neuen Urlaub anlegen</button>
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
        <span>Neuen Urlaub anlegen</span>
      </button>`
          : ""
      }
    </main>
  `;

  const coverUrls = new Map();
  for (const v of vacations) {
    coverUrls.set(v.id, await resolveCoverSrc(v, getBlob));
  }

  appEl.querySelectorAll("[data-vacation-id]").forEach((card) => {
    const id = card.dataset.vacationId;
    const img = card.querySelector("[data-cover-img]");
    if (img && coverUrls.has(id)) {
      img.src = coverUrls.get(id);
    }
  });

  appEl.querySelectorAll('[data-action="new"]').forEach((btn) => {
    btn.addEventListener("click", () => navigate({ name: "urlaub-form", mode: "create" }));
  });

  appEl.querySelector('[data-action="settings"]')?.addEventListener("click", () => {
    import("./toast.js").then(({ showToast }) =>
      showToast("Einstellungen kommen in Paket 1b.")
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
  return `
    <article class="card card--hero" data-vacation-id="${v.id}" tabindex="0">
      <div class="card--hero__media">
        <img data-cover-img alt="" />
        <span class="badge badge--day">Tag ${day} von ${total}</span>
        <div class="card--hero__overlay">
          <h3 class="card--hero__title">${escapeHtml(v.title)}</h3>
          <p class="card--hero__dates">${formatDateRange(v.startDate, v.endDate)}</p>
        </div>
      </div>
      <div class="card--hero__footer">
        <span>${v.stats.places} Orte · ${v.stats.photos} Fotos · ${v.stats.notes} Notizen</span>
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
      : `<span class="card-compact__stats">${v.stats.places} Orte · ${v.stats.photos} Fotos</span>`;
  const days = dayCountInclusive(v.startDate, v.endDate);
  return `
    <article class="card card--compact" data-vacation-id="${v.id}" tabindex="0">
      <div class="card-compact__thumb">
        <img data-cover-img alt="" />
      </div>
      <div class="card-compact__body">
        <h3 class="card-compact__title">${escapeHtml(v.title)}</h3>
        <p class="card-compact__dates">${formatDateRange(v.startDate, v.endDate)} · ${days} Tage</p>
        <div class="card-compact__meta">
          ${meta}
          <div class="avatars">${avatars}</div>
        </div>
      </div>
      <span class="card-compact__chevron" aria-hidden="true">›</span>
    </article>
  `;
}

function renderAvatars(v) {
  const names = avatarListForVacation(v);
  const items = initialsFromNames(names);
  const extra = names.length > 4 ? `<span class="avatar avatar--more">+${names.length - 4}</span>` : "";
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

  const clearPress = () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
  };

  card.addEventListener("pointerdown", () => {
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      showCardMenu(card, id, vacations);
    }, LONG_PRESS_MS);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) =>
    card.addEventListener(ev, clearPress)
  );

  card.addEventListener("click", (e) => {
    if (longPressed) {
      e.preventDefault();
      return;
    }
    navigate({ name: "urlaub-detail", id });
  });
}

function showCardMenu(anchor, id, vacations) {
  const vacation = vacations.find((v) => v.id === id);
  if (!vacation) return;

  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="action-sheet" role="dialog" aria-label="Urlaub-Aktionen">
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

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  overlay.querySelector('[data-action="cancel"]').addEventListener("click", close);
  overlay.querySelector('[data-action="edit"]').addEventListener("click", () => {
    close();
    navigate({ name: "urlaub-form", mode: "edit", id });
  });
  overlay.querySelector('[data-action="delete"]').addEventListener("click", () => {
    close();
    confirmDelete(id, vacation.title);
  });
}

function confirmDelete(id, title) {
  const overlay = document.getElementById("overlay-root");
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="confirm-dialog" role="alertdialog" aria-labelledby="confirm-title">
      <h2 id="confirm-title">Urlaub löschen?</h2>
      <p>«${escapeHtml(title)}» wird unwiderruflich gelöscht.</p>
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
    const { deleteVacation, getVacation, deleteBlob } = await import("./db.js");
    const v = await getVacation(id);
    if (v?.cover?.type === "custom" && v.cover.blobId) {
      await deleteBlob(v.cover.blobId);
    }
    await deleteVacation(id);
    close();
    const { showToast } = await import("./toast.js");
    showToast("Urlaub gelöscht");
    window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
  });
}
