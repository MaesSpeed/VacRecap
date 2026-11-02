import { inviteToTrip, revokeTripAccess, setTripAccessRole } from "./trip-access.js";
import { CloudOfflineError } from "./cloud-errors.js";
import { clearTripPeople, loadTripPeople, personLetter } from "./trip-people.js";
import { displayColorMap } from "./trip-people.js";
import { ROLE_LABEL } from "./trip-role.js";
import { openConfirmDialog } from "./ui-confirm.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { showToast } from "./toast.js";
import { escapeHtml } from "./utils.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const draftStore = new Map();

function cloneDrafts(list) {
  return (list || []).map((draft) => ({ ...draft }));
}
const DOTS = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/></svg>`;

const HELP = {
  viewer: "<b>Beitragender</b>: fügt eigene Fotos, Notizen und Orte hinzu. Fremdes nur ansehen.",
  editor:
    "<b>Mitbearbeiter</b>: bearbeitet alles wie du, auch Entwürfe für Recap und Tagebuch anstoßen und umsetzen.",
};

export function shareFieldHtml() {
  return `
    <div class="field" id="share" data-testid="share-section">
      <span class="field__label">Freigeben <span class="fg-owner">nur für dich als Besitzer</span></span>
      <p class="cover-save-hint">Personen per E-Mail einladen. Mehrere Adressen mit Komma oder Enter trennen.</p>
      <input type="text" class="fg-in" data-testid="share-email-input" placeholder="+ E-Mail-Adresse" autocomplete="off" enterkeyhint="done" inputmode="email" />
      <input type="text" class="fg-in" data-testid="share-name-input" placeholder="Name" maxlength="60" autocomplete="name" />
      <div class="chip-row chip-row--names" data-role="share-chips"></div>
      <div data-role="share-errors"></div>
      <div class="fg-mail" data-role="share-roles"></div>
      <span class="field__label" data-role="share-access-label" hidden>Zugriff</span>
      <div class="settings-card fg-acc" data-testid="share-access" data-role="share-access" hidden></div>
    </div>`;
}

function parseEmails(raw) {
  return String(raw || "")
    .split(/[,;\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function resultCopy(results) {
  const parts = [];
  const saved = results.filter((row) => row.result === "invited" || row.result === "updated");
  if (saved.length === 1) parts.push("Einladung gespeichert");
  else if (saved.length > 1) parts.push(`${saved.length} Einladungen gespeichert`);
  if (results.some((row) => row.result === "already_member")) parts.push("Ist schon dabei");
  if (results.some((row) => row.result === "self")) parts.push("Das bist du");
  if (results.some((row) => row.result === "invalid")) parts.push("Keine gültige E-Mail-Adresse");
  if (results.some((row) => row.result === "rate_limited")) parts.push("Zu viele Einladungen heute, bitte morgen wieder");
  if (results.some((row) => row.result === "not_registered")) parts.push("Noch kein Konto mit dieser Adresse");
  return parts.join(" · ");
}

export function bindShareField(root, { tripId, myUserId }) {
  const input = root.querySelector('[data-testid="share-email-input"]');
  const nameInput = root.querySelector('[data-testid="share-name-input"]');
  const chipsEl = root.querySelector('[data-role="share-chips"]');
  const errorsEl = root.querySelector('[data-role="share-errors"]');
  const rolesEl = root.querySelector('[data-role="share-roles"]');
  const accessEl = root.querySelector('[data-role="share-access"]');
  const accessLabel = root.querySelector('[data-role="share-access-label"]');
  let drafts = cloneDrafts(draftStore.get(tripId));
  let people = [];

  function remember() {
    if (!tripId) return;
    if (drafts.length) draftStore.set(tripId, cloneDrafts(drafts));
    else draftStore.delete(tripId);
  }

  function clearDrafts() {
    drafts = [];
    if (tripId) draftStore.delete(tripId);
    if (chipsEl?.isConnected) paint();
  }

  function paint() {
    remember();
    chipsEl.innerHTML = drafts
      .map((draft, index) => {
        const bad = draft.invalid || draft.error;
        const label = draft.name || draft.email;
        const tip = draft.name ? ` title="${escapeHtml(draft.email)}"` : "";
        return `<button type="button" class="chip chip--filled${bad ? " chip--bad" : ""}" data-remove-mail="${index}" data-testid="share-chip"${tip}><span data-chip-label>${escapeHtml(label)}</span> <span aria-hidden="true">×</span></button>`;
      })
      .join("");
    root.querySelector('[data-testid="share-section"]')?.setAttribute("data-drafts", String(drafts.length));
    errorsEl.innerHTML = drafts
      .filter((draft) => draft.error)
      .map((draft) => `<p class="fg-chip-note" data-testid="share-chip-error">${escapeHtml(draft.error)}</p>`)
      .join("");
    const cards = drafts.filter((draft) => !draft.invalid);
    rolesEl.innerHTML = cards
      .map((draft) => {
        const letter = personLetter({ display_name: draft.name, email: draft.email });
        const title = draft.name || draft.email;
        const sub = draft.name ? draft.email : "Rolle wählen";
        return `<div class="settings-card"><div class="settings-item settings-item--stack">
          <div class="settings-item__row"><span class="fg-av fg-av--mail">${escapeHtml(letter)}</span><div class="settings-item__text"><span class="settings-item__title">${escapeHtml(title)}</span><span class="settings-item__sub">${escapeHtml(sub)}</span></div></div>
          <label class="field">
            <span class="field__label">Name</span>
            <input type="text" class="fg-in" maxlength="60" data-share-name data-testid="share-draft-name" data-mail="${escapeHtml(draft.email)}" value="${escapeHtml(draft.name || "")}" placeholder="Name, optional" />
          </label>
          <div class="settings-segments" data-mail="${escapeHtml(draft.email)}">
            <button type="button" class="settings-segment fg-seg${draft.role === "viewer" ? " settings-segment--active" : ""}" data-share-role="viewer">Beitragender</button>
            <button type="button" class="settings-segment fg-seg${draft.role === "editor" ? " settings-segment--active" : ""}" data-share-role="editor">Mitbearbeiter</button>
          </div>
          <p class="fg-help">${HELP[draft.role] || HELP.viewer}</p>
        </div></div>`;
      })
      .join("");
    paintAccess();
  }

  function paintAccess() {
    const rows = people
      .filter((person) => person.person_kind !== "former" && person.status !== "ehemalig")
      .slice()
      .sort((a, b) => {
        if (a.role === "owner" && b.role !== "owner") return -1;
        if (b.role === "owner" && a.role !== "owner") return 1;
        const rank = { aktiv: 0, eingeladen: 1, abgelaufen: 2 };
        const diff = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
        if (diff) return diff;
        return String(a.display_name || a.email || "").localeCompare(String(b.display_name || b.email || ""), "de");
      });
    const show = rows.length > 0;
    accessLabel.hidden = !show;
    accessEl.hidden = !show;
    if (!show) {
      accessEl.innerHTML = "";
      return;
    }
    const colors = displayColorMap(rows);
    accessEl.innerHTML = rows
      .map((person) => {
        const invite = person.person_kind === "invite";
        const letter = personLetter(person);
        const color = colors.get(person.user_id || person.invite_id) || person.avatar_color || "#5D6D7E";
        const avatar = invite
          ? `<span class="fg-av fg-av--mail">${escapeHtml(letter)}</span>`
          : `<span class="fg-av" style="--avatar-bg:${escapeHtml(color)}">${escapeHtml(letter)}</span>`;
        const named = String(person.display_name || "").trim();
        const title = named || person.email || "";
        const mailTip =
          invite && named && person.email && named.toLowerCase() !== String(person.email).toLowerCase()
            ? person.email
            : "";
        const role = ROLE_LABEL[person.role] || "";
        const you = person.role === "owner" && person.user_id && person.user_id === myUserId ? " · Du" : "";
        const status =
          person.status === "aktiv"
            ? `<span class="fg-st fg-st--act">Aktiv</span>`
            : person.status === "abgelaufen"
              ? `<span class="fg-st fg-st--inv fg-st--exp">abgelaufen</span>`
              : `<span class="fg-st fg-st--inv">Eingeladen</span>`;
        const menu =
          person.role === "owner"
            ? ""
            : `<button type="button" class="fg-more" data-testid="share-more" data-user-id="${escapeHtml(person.user_id || "")}" data-invite-id="${escapeHtml(person.invite_id || "")}" data-email="${escapeHtml(person.email || "")}" data-name="${escapeHtml(title)}" data-role-now="${escapeHtml(person.role || "")}" data-status="${escapeHtml(person.status || "")}" aria-label="Mehr">${DOTS}</button>`;
        return `<div class="settings-item" data-testid="share-access-row"${mailTip ? ` title="${escapeHtml(mailTip)}"` : ""}><span>${avatar}</span><div class="settings-item__text"><span class="settings-item__title">${escapeHtml(title)}</span><span class="settings-item__sub fg-sub">${escapeHtml(mailTip ? `${mailTip} · ` : "")}${escapeHtml(role)}${you}${status}</span></div>${menu}</div>`;
      })
      .join("");
  }

  function clipName(value) {
    return Array.from(String(value || "").trim()).slice(0, 60).join("");
  }

  function takeName() {
    const name = clipName(nameInput?.value);
    if (nameInput) nameInput.value = "";
    return name;
  }

  function addEmails(raw) {
    const fresh = parseEmails(raw).filter((email) => !drafts.some((draft) => draft.email === email));
    if (!fresh.length) return;
    const shared = fresh.length === 1 ? takeName() : "";
    for (const email of fresh) {
      drafts.push({
        email,
        name: shared,
        role: "viewer",
        invalid: !EMAIL_RE.test(email),
        error: EMAIL_RE.test(email) ? "" : "Keine gültige E-Mail-Adresse",
      });
    }
    paint();
  }

  function commitInput() {
    const value = input.value;
    if (!value.trim()) return;
    addEmails(value);
    input.value = "";
  }

  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== "," && event.key !== " ") return;
    if (event.key === " " && !input.value.includes("@")) return;
    event.preventDefault();
    commitInput();
  });
  input.addEventListener("blur", () => commitInput());
  input.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text") || "";
    if (!/[,;\s]/.test(text)) return;
    event.preventDefault();
    addEmails(text);
    input.value = "";
  });

  chipsEl.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-remove-mail]");
    if (!btn) return;
    drafts.splice(Number(btn.dataset.removeMail), 1);
    paint();
  });

  rolesEl.addEventListener("input", (event) => {
    const field = event.target.closest("[data-share-name]");
    if (!field) return;
    const draft = drafts.find((item) => item.email === field.dataset.mail);
    if (!draft) return;
    draft.name = clipName(field.value);
    const index = drafts.indexOf(draft);
    const chip = chipsEl.querySelector(`[data-remove-mail="${index}"]`);
    const label = chip?.querySelector("[data-chip-label]");
    if (label) label.textContent = draft.name || draft.email;
    if (chip) chip.title = draft.name ? draft.email : "";
    const card = field.closest(".settings-item");
    const title = card?.querySelector(".settings-item__title");
    const sub = card?.querySelector(".settings-item__sub");
    const avatar = card?.querySelector(".fg-av");
    if (title) title.textContent = draft.name || draft.email;
    if (sub) sub.textContent = draft.name ? draft.email : "Rolle wählen";
    if (avatar) avatar.textContent = personLetter({ display_name: draft.name, email: draft.email });
  });

  rolesEl.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-share-role]");
    if (!btn) return;
    const email = btn.parentElement?.dataset?.mail;
    const draft = drafts.find((item) => item.email === email);
    if (!draft) return;
    draft.role = btn.dataset.shareRole === "editor" ? "editor" : "viewer";
    paint();
  });

  async function refresh() {
    clearTripPeople(tripId);
    people = await loadTripPeople(tripId, { refresh: true });
    paintAccess();
  }

  accessEl.addEventListener("click", (event) => {
    const more = event.target.closest("[data-testid='share-more']");
    if (!more) return;
    event.preventDefault();
    openAccessMenu(more);
  });

  function openAccessMenu(more) {
    const overlay = document.getElementById("overlay-root");
    const name = more.dataset.name || "Person";
    const status = more.dataset.status;
    const role = more.dataset.roleNow;
        const expired = status === "abgelaufen";
        const isInvite = status === "eingeladen" || expired;
        const check = (value) => (role === value ? "fg-cur" : "");
        const mark = (value) => (role === value ? " ✓" : "");
        overlay.hidden = false;
        overlay.innerHTML = `
      <div class="action-sheet" role="dialog" data-testid="share-action-sheet" aria-label="${escapeHtml(name)}">
        <p class="action-sheet__title">${escapeHtml(name)}</p>
        ${
          expired
            ? `<button type="button" data-action="reinvite">Erneut einladen</button>
               <button type="button" data-action="revoke" class="danger">Einladung zurückziehen</button>`
            : `<button type="button" data-action="editor" class="${check("editor")}">Mitbearbeiter${mark("editor")}</button>
               <button type="button" data-action="viewer" class="${check("viewer")}">Beitragender${mark("viewer")}</button>
               <button type="button" data-action="revoke" class="danger">Zugriff entziehen</button>`
        }
        <button type="button" data-action="cancel">Abbrechen</button>
      </div>`;
    const close = () => {
      overlay.hidden = true;
      overlay.innerHTML = "";
    };
    const activeClose = bindOverlay(overlay, close);
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => closeOverlayHistory(activeClose));
    overlay.querySelector('[data-action="editor"]')?.addEventListener("click", () => changeRole("editor"));
    overlay.querySelector('[data-action="viewer"]')?.addEventListener("click", () => changeRole("viewer"));
    overlay.querySelector('[data-action="reinvite"]')?.addEventListener("click", () => reinvite());
    overlay.querySelector('[data-action="revoke"]')?.addEventListener("click", () => revoke());

    const target = () =>
      status === "aktiv"
        ? { userId: more.dataset.userId || null, inviteId: null }
        : { userId: null, inviteId: more.dataset.inviteId || null };

    async function changeRole(next) {
      closeOverlayHistory(activeClose);
      if (next === role) return;
      try {
        await setTripAccessRole({ tripId, role: next, ...target() });
        await refresh();
        showToast("Rolle geändert");
      } catch (err) {
        showToast(err?.message || "Rolle konnte nicht geändert werden.");
      }
    }

    async function reinvite() {
      closeOverlayHistory(activeClose);
      if (!navigator.onLine) {
        showToast("Einladen geht nur mit Verbindung");
        return;
      }
      try {
        await inviteToTrip(tripId, [
          {
            email: more.dataset.email,
            role: role === "editor" ? "editor" : "viewer",
            name: clipName(more.dataset.name && more.dataset.name !== more.dataset.email ? more.dataset.name : ""),
          },
        ]);
        await refresh();
        showToast("Einladung gespeichert");
      } catch (err) {
        showToast(err?.message || "Einladung konnte nicht gespeichert werden.");
      }
    }

    async function revoke() {
      closeOverlayHistory(activeClose);
      const ok = await openConfirmDialog({
        title: isInvite ? "Einladung zurückziehen?" : "Zugriff entziehen?",
        message: isInvite
          ? `Die Einladung an ${more.dataset.email || name} verfällt.`
          : `${name} sieht die Reise dann nicht mehr. Fotos und Notizen von ${name} bleiben in der Reise.`,
        confirmLabel: isInvite ? "Zurückziehen" : "Entziehen",
        testId: "confirm-revoke",
      });
      if (!ok) return;
      try {
        await revokeTripAccess({ tripId, ...target() });
        await refresh();
        showToast(isInvite ? "Einladung zurückgezogen" : "Zugriff entzogen");
      } catch (err) {
        showToast(err?.message || "Das hat nicht geklappt.");
      }
    }
  }

  paint();
  void refresh();

  return {
    clearDrafts,
    commitInput,
    pendingInvites() {
      commitInput();
      return drafts
        .filter((draft) => !draft.invalid && !draft.error)
        .map((draft) => ({ email: draft.email, role: draft.role, name: clipName(draft.name) }));
    },
    hasDrafts() {
      return drafts.length > 0;
    },
    async submitInvites() {
      commitInput();
      const sendable = drafts.filter((draft) => !draft.invalid);
      if (!sendable.length) return { stayed: drafts.length > 0, invited: false };
      if (!navigator.onLine) {
        showToast("Einladen geht nur mit Verbindung");
        return { stayed: true, invited: false };
      }
      try {
        const results = await inviteToTrip(
          tripId,
          sendable.map((draft) => ({ email: draft.email, role: draft.role, name: clipName(draft.name) }))
        );
        const byEmail = new Map(results.map((row) => [String(row.email || "").toLowerCase(), row]));
        const next = [];
        for (const draft of drafts) {
          if (draft.invalid) {
            next.push(draft);
            continue;
          }
          const row = byEmail.get(draft.email);
          const code = row?.result;
          if (!row || code === "invited" || code === "updated" || code === "already_member" || code === "self") {
            continue;
          }
          if (code === "not_registered") next.push({ ...draft, error: "Noch kein Konto mit dieser Adresse" });
          else if (code === "invalid") next.push({ ...draft, invalid: true, error: "Keine gültige E-Mail-Adresse" });
          else if (code === "rate_limited") next.push({ ...draft, error: "Zu viele Einladungen heute, bitte morgen wieder" });
          else next.push({ ...draft, error: "Einladung nicht gespeichert" });
        }
        drafts = next;
        const copy = resultCopy(results);
        if (copy) showToast(copy);
        await refresh();
        paint();
        return { stayed: true, invited: true };
      } catch (err) {
        if (err instanceof CloudOfflineError || /offline|netzwerk|failed to fetch/i.test(err?.message || "")) {
          showToast("Einladen geht nur mit Verbindung");
        } else {
          showToast(err?.message || "Einladung konnte nicht gespeichert werden.");
        }
        return { stayed: true, invited: false };
      }
    },
  };
}
