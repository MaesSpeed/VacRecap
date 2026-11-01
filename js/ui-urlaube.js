import { bindCoverImage, resolveVacationCoverMap } from "./cover-sources.js";
import { armPointerSuppression } from "./gesture-guard.js";
import { bindOverlay, closeOverlayHistory, releaseOverlayHistory } from "./overlay-stack.js";
import { paintCardSymbols } from "./ui-card-symbols.js";
import { computeVacationStats, formatVacationStatsLine } from "./vacation-stats.js";
import { navigate } from "./router.js";
import { clearTripUiState } from "./ui-urlaub-detail.js";
import { avatarListForVacation, companionTagsMarkup } from "./vacation.js";
import { acceptTripInvite, declineTripInvite, listMyTripInvites } from "./trip-access.js";
import { loadTripPeople } from "./trip-people.js";
import { canDeleteTrip, canEditAny, getConfirmedTripRole, ROLE_LABEL, clearTripRoleCache } from "./trip-role.js";
import { leaveTrip } from "./trip-access.js";
import { clearTripPeople } from "./trip-people.js";
import { stackHtml } from "./member-marks.js";
import { presetUrl } from "./covers.js";
import { openConfirmDialog } from "./ui-confirm.js";
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
let peopleByTrip = new Map();
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
  const invites = await listMyTripInvites();
  peopleByTrip = new Map(
    await Promise.all(vacations.map(async (vacation) => [vacation.id, await loadTripPeople(vacation.id, { refresh: true })]))
  );

  appEl.className = "screen screen--urlaube";
  delete appEl.dataset.vacationId;
  delete appEl.dataset.cardSymbols;
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
      ${inviteSection(invites)}
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

  fitCompanionLines(appEl);
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      if (appEl?.dataset?.appRenderGen !== mountGen) return;
      fitCompanionLines(appEl);
    });
  }
  paintCardSymbols(appEl, vacations, mountGen);

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

  appEl.querySelectorAll('[data-action="accept-invite"]').forEach((btn) => {
    btn.addEventListener("click", () => acceptInvite(btn.dataset.inviteId));
  });
  appEl.querySelectorAll('[data-action="decline-invite"]').forEach((btn) => {
    btn.addEventListener("click", () => declineInvite(btn.dataset.inviteId));
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
          <div class="card-compact__titlerow">
            <h3 class="card--hero__title">${escapeHtml(v.title)}</h3>
            <div class="card-syms" data-card-syms></div>
          </div>
          <p class="card--hero__dates">${formatDateRangeOverlay(v.startDate, v.endDate)}</p>
        </div>
      </div>
      <div class="card--hero__footer">
        <span>${formatVacationStatsLine(v.stats)}</span>
        <div class="avatars">${avatars}</div>
        ${companionTagsMarkup(v)}
        <p class="card-symbol-hint" data-testid="card-symbol-hint" hidden></p>
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
        <div class="card-compact__titlerow">
          <h3 class="card-compact__title">${escapeHtml(v.title)}</h3>
          <div class="card-syms" data-card-syms></div>
        </div>
        <p class="card-compact__dates">${formatDateRangeCard(v.startDate, v.endDate)}</p>
        ${companionTagsMarkup(v)}
        <div class="card-compact__meta">
          ${meta}
          <div class="avatars">${avatars}</div>
        </div>
      </div>
      <span class="card-compact__chevron" aria-hidden="true">${CHEVRON_SVG}</span>
      ${
        kind === "past"
          ? `<div class="card-recap-actions" data-card-actions hidden></div>`
          : ""
      }
      <p class="card-symbol-hint" data-testid="card-symbol-hint" hidden></p>
    </article>
  `;
}

function fitCompanionLines(root) {
  root?.querySelectorAll(".card--compact .companion-line").forEach((line) => {
    if (!line.isConnected || line.clientWidth === 0) return;
    const pills = [...line.querySelectorAll(".companion-pill:not(.companion-pill--more)")];
    pills.forEach((pill) => {
      pill.hidden = false;
    });
    line.querySelector(".companion-pill--more")?.remove();
    if (pills.length < 2) return;
    if (line.scrollWidth <= line.clientWidth + 1) return;
    const more = document.createElement("span");
    more.className = "companion-pill companion-pill--more";
    more.dataset.testid = "companion-more";
    line.append(more);
    const hidden = [];
    for (let i = pills.length - 1; i >= 1; i -= 1) {
      pills[i].hidden = true;
      hidden.unshift(pills[i].textContent || "");
      more.textContent = `+${hidden.length}`;
      more.setAttribute("aria-label", hidden.filter(Boolean).join(", "));
      if (line.scrollWidth <= line.clientWidth + 1) break;
    }
  });
}

function renderAvatars(v) {
  const members = (peopleByTrip.get(v.id) || []).filter((person) => person.person_kind === "member");
  if (members.length > 1) return stackHtml(members);
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

  card.addEventListener("pointerdown", (event) => {
    if (event.target.closest("[data-testid='card-symbol'], [data-testid='card-recap-btn']")) return;
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
    if (e.target.closest("[data-testid='card-symbol'], [data-testid='card-recap-btn']")) return;
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
  void (async () => {
    const roleInfo = await getConfirmedTripRole(id);
    const showEdit = canEditAny(roleInfo.role);
    const showDelete = canDeleteTrip(roleInfo.role, roleInfo.confirmed);
    const showLeave = roleInfo.confirmed && roleInfo.role !== "owner";
    const overlay = document.getElementById("overlay-root");
    overlay.hidden = false;
    overlay.innerHTML = `
    <div class="action-sheet" role="dialog" aria-label="Reise-Aktionen" data-testid="vacation-action-sheet">
      <p class="action-sheet__title">${escapeHtml(vacation.title)}</p>
      ${showEdit ? `<button type="button" data-action="edit">Bearbeiten</button>` : ""}
      ${showDelete ? `<button type="button" data-action="delete" class="danger">Löschen</button>` : ""}
      ${showLeave ? `<button type="button" data-action="leave" class="danger" data-testid="card-leave-trip">Reise verlassen</button>` : ""}
      <button type="button" data-action="cancel">Abbrechen</button>
    </div>
  `;
    bindCardMenu(overlay, id, vacation);
  })();
}

function bindCardMenu(overlay, id, vacation) {

  const close = () => {
    overlay.hidden = true;
    overlay.innerHTML = "";
  };

  const activeClose = bindOverlay(overlay, close);

  overlay.querySelector('[data-action="cancel"]').addEventListener("click", () =>
    closeOverlayHistory(activeClose)
  );
  overlay.querySelector('[data-action="edit"]')?.addEventListener("click", () => {
    releaseOverlayHistory(activeClose);
    navigate({ name: "urlaub-form", mode: "edit", id });
  });
  overlay.querySelector('[data-action="delete"]')?.addEventListener("click", () => {
    closeOverlayHistory(activeClose);
    confirmDelete(id, vacation.title);
  });
  overlay.querySelector('[data-action="leave"]')?.addEventListener("click", () => {
    closeOverlayHistory(activeClose);
    confirmLeave(id);
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
    const { showToast } = await import("./toast.js");
    try {
      await deleteVacation(id);
    } catch (err) {
      closeOverlayHistory(activeClose);
      showToast(err?.message || "Die Reise konnte nicht gelöscht werden.");
      return;
    }
    closeOverlayHistory(activeClose);
    showToast("Reise gelöscht");
    window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
    navigate({ name: "urlaube" }, { replace: true });
  });
}

async function acceptInvite(inviteId) {
  const { showToast } = await import("./toast.js");
  try {
    await acceptTripInvite(inviteId);
    clearTripRoleCache();
    clearTripPeople();
    showToast("Du bist jetzt dabei");
    window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
  } catch (err) {
    const code = String(err?.code || "");
    if (code === "P0001" || /ungueltig|ungültig|abgelaufen/i.test(err?.message || "")) {
      showToast("Einladung ist nicht mehr gültig");
    } else {
      showToast(err?.message || "Beitreten hat nicht geklappt.");
    }
    window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
  }
}

async function declineInvite(inviteId) {
  const ok = await openConfirmDialog({
    title: "Einladung ablehnen?",
    message: "Die Einladung verschwindet aus deiner Übersicht.",
    confirmLabel: "Ablehnen",
    testId: "confirm-decline-invite",
  });
  if (!ok) return;
  try {
    await declineTripInvite(inviteId);
    window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
  } catch (err) {
    const { showToast } = await import("./toast.js");
    showToast(err?.message || "Ablehnen hat nicht geklappt.");
  }
}

function confirmLeave(id) {
  void (async () => {
    const ok = await openConfirmDialog({
      title: "Reise verlassen?",
      message: "Deine Fotos und Notizen bleiben in der Reise.",
      confirmLabel: "Verlassen",
      testId: "confirm-leave-trip",
    });
    if (!ok) return;
    const { showToast } = await import("./toast.js");
    try {
      await leaveTrip(id);
      clearTripRoleCache(id);
      clearTripPeople(id);
      showToast("Reise verlassen");
      navigate({ name: "urlaube" }, { replace: true });
    } catch (err) {
      showToast(err?.message || "Die Reise konnte nicht verlassen werden.");
    }
  })();
}

function inviteSection(invites) {
  if (!invites?.length) return "";
  return `
    <section class="urlaube-section" data-testid="invite-section">
      <h2 class="section-label inv-label">Einladung <span class="inv-new">NEU</span></h2>
      ${invites.map(inviteCard).join("")}
    </section>`;
}

function inviteCard(invite) {
  const title = invite.trip_title || "Reise";
  const role = ROLE_LABEL[invite.role] || "Beitragender";
  const dates =
    invite.start_date && invite.end_date ? formatDateRangeCard(invite.start_date, invite.end_date) : "";
  const members = Array.isArray(invite.members) ? invite.members : [];
  const hint =
    invite.role === "editor"
      ? "Als Mitbearbeiter bearbeitest du alles mit, wie der Besitzer."
      : "Als Beitragender fügst du eigene Fotos und Notizen hinzu. Fremdes kannst du ansehen.";
  const cover = presetUrl(invite.cover_preset || "stadt");
  const inviter = invite.inviter_name || "Jemand";
  const color = invite.inviter_color || "#0066b3";
  const letter = Array.from(inviter)[0]?.toLocaleUpperCase("de-DE") || "?";
  const dabei = members.length
    ? `<div class="kr-dabei"><span class="kr-dabei__l">Schon dabei</span>${stackHtml(members.map((member) => ({ ...member, person_kind: "member", display_name: member.display_name, avatar_color: member.avatar_color, user_id: member.user_id, role: member.role })))}<span class="kr-dabei__t">${escapeHtml(members.map((member) => member.display_name).filter(Boolean).join(" · "))}</span></div>`
    : "";
  return `
    <article class="inv-card" data-testid="invite-card" data-invite-id="${escapeHtml(invite.invite_id)}">
      <div class="inv-top">
        <img src="${escapeHtml(cover)}" alt="" />
        <div>
          <h3 class="inv-title">Du wurdest zur Reise „${escapeHtml(title)}“ eingeladen</h3>
          <p class="inv-from kr-from"><span>Von</span><span class="kr-av kr-av--sm" style="--kr:${escapeHtml(color)}">${escapeHtml(letter)}</span><span>${escapeHtml(inviter)} · ${escapeHtml(ROLE_LABEL[invite.inviter_role] || "Besitzer")}</span></p>
          ${dates ? `<p class="card-compact__dates inv-dates">${escapeHtml(dates)}</p>` : ""}
          <span class="inv-role">Rolle: ${escapeHtml(role)}</span>
        </div>
      </div>
      ${dabei}
      <p class="inv-hint">${escapeHtml(hint)}</p>
      <div class="inv-acts">
        <button type="button" class="btn btn-emaille--ghost" data-action="decline-invite" data-invite-id="${escapeHtml(invite.invite_id)}">Ablehnen</button>
        <button type="button" class="btn btn-emaille" data-action="accept-invite" data-testid="invite-accept" data-invite-id="${escapeHtml(invite.invite_id)}">Beitreten</button>
      </div>
    </article>`;
}
