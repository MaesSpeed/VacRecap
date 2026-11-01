import { displayColorMap, personKey, personLetter, personRoleLabel } from "./trip-people.js";
import { escapeHtml } from "./utils.js";

const LOCK = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
const LOCK_DARK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;

export function circleHtml(person, size, { tip = "", sub = "", extraClass = "" } = {}) {
  if (!person) return "";
  const colors = person._colors || displayColorMap([person]);
  const color = colors.get(personKey(person)) || person.avatar_color || "#5D6D7E";
  const letter = personLetter(person);
  const role = personRoleLabel(person);
  const title = tip || (role ? `${person.display_name || letter} · ${role}` : person.display_name || "");
  const attrs = [
    `class="kr-av kr-av--${size}${extraClass ? ` ${extraClass}` : ""}"`,
    `style="--kr:${escapeHtml(color)}"`,
    title ? `data-kr-tip="${escapeHtml(title)}"` : "",
    sub ? `data-kr-sub="${escapeHtml(sub)}"` : "",
    `data-user-id="${escapeHtml(person.user_id || "")}"`,
  ]
    .filter(Boolean)
    .join(" ");
  return `<span ${attrs}>${escapeHtml(letter)}</span>`;
}

export function stackHtml(people, { max = 3 } = {}) {
  const list = people || [];
  const colors = displayColorMap(list);
  const shown = list.slice(0, max);
  const extra = list.length - shown.length;
  const circles = shown
    .map((person) => circleHtml({ ...person, _colors: colors }, "md"))
    .join("");
  const more = extra > 0 ? `<span class="kr-av kr-av--md kr-av--more">+${extra}</span>` : "";
  return `<span class="kr-stack">${circles}${more}</span>`;
}

export function shareContext(role, userId, people) {
  const authors = (people || []).filter(
    (person) => person.person_kind === "member" || person.person_kind === "former"
  );
  const members = (people || []).filter((person) => person.person_kind === "member");
  const colors = displayColorMap(authors);
  const byId = new Map();
  for (const person of authors) {
    if (person.user_id) byId.set(person.user_id, { ...person, _colors: colors });
  }
  return {
    role,
    userId,
    multi: authors.length > 1,
    showBar: members.length > 1,
    members,
    colors,
    byId,
    viewer: role === "viewer",
  };
}

export function noteMarkup(note, action, share) {
  const decorate = share && (share.viewer || share.multi);
  if (!decorate) {
    return `
          <div class="nr" data-note-id="${note.id}"${action === "edit-free-note" ? ' data-free-note="1"' : ""}>
            <span class="nr__icon">${note._icon || ""}</span>
            <button type="button" class="nr__text nr__text--btn" data-action="${action}">${note._text || ""}</button>
          </div>`;
  }
  const person = note.author ? share.byId.get(note.author) : null;
  const mine = Boolean(share.userId && note.author === share.userId);
  const foreign = share.viewer && note.author && !mine;
  const by = share.viewer
    ? `<span class="fg-by">· ${mine || !note.author ? "Von dir" : `Von ${escapeHtml(person?.display_name || "jemand")}`}</span>`
    : "";
  const circle =
    share.multi && person
      ? circleHtml(person, "xs", { extraClass: "kr-note" })
      : "";
  const icon = foreign ? LOCK_DARK : note._icon || "";
  const text = `${note._text || ""}${by}`;
  const body = foreign
    ? `<span class="nr__text">${text}</span>`
    : `<button type="button" class="nr__text nr__text--btn" data-action="${action}">${text}</button>`;
  return `
          <div class="nr${foreign ? " fg-foreign" : ""}" data-note-id="${note.id}"${action === "edit-free-note" ? ' data-free-note="1"' : ""}>
            ${circle}
            <span class="nr__icon">${icon}</span>
            ${body}
          </div>`;
}

export function photoBadges(media, share) {
  if (!share || (!share.viewer && !share.multi)) return { lock: "", mine: "", circle: "", foreign: false };
  const mine = Boolean(share.userId && media.author === share.userId);
  const person = media.author ? share.byId.get(media.author) : null;
  const foreign = share.viewer && media.author && !mine;
  return {
    foreign,
    lock: foreign ? `<span class="fg-lock">${LOCK}</span>` : "",
    mine: share.viewer && mine ? `<span class="fg-mine">Du</span>` : "",
    circle: share.multi && person ? circleHtml(person, "xs") : "",
  };
}

let tipEl = null;

export function showCircleTip(anchor) {
  const title = anchor?.dataset?.krTip;
  if (!title) return;
  hideCircleTip();
  const sub = anchor.dataset.krSub || "";
  tipEl = document.createElement("div");
  tipEl.className = "kr-tip";
  tipEl.dataset.testid = "member-tip";
  tipEl.innerHTML = `<span><b>${escapeHtml(title)}</b>${sub ? `<small>${escapeHtml(sub)}</small>` : ""}</span>`;
  document.body.appendChild(tipEl);
  const rect = anchor.getBoundingClientRect();
  const tipRect = tipEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - tipRect.width / 2, window.innerWidth - tipRect.width - 8));
  const top = Math.min(window.innerHeight - tipRect.height - 8, rect.bottom + 10);
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
  const arrow = Math.max(16, rect.left + rect.width / 2 - left);
  tipEl.style.setProperty("--ax", `${arrow}px`);
}

export function hideCircleTip() {
  tipEl?.remove();
  tipEl = null;
}

export function bindCircleTips(root) {
  if (!root || root.dataset.krTips === "1") return;
  root.dataset.krTips = "1";
  root.addEventListener("click", (event) => {
    const circle = event.target.closest("[data-kr-tip]");
    if (!circle || !root.contains(circle)) return;
    event.preventDefault();
    event.stopPropagation();
    showCircleTip(circle);
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-kr-tip]")) return;
    hideCircleTip();
  });
}
