import { escapeHtml } from "./utils.js";

const TOAST_MS = 2500;
const UNDO_MS = 5000;

const ICON_CHECK = `<svg class="toast__svg" width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="12" fill="rgba(255,255,255,.18)"/><path d="M8 13.2l3.2 3.2L18 9.6" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const ICON_TRASH = `<svg class="toast__svg" width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><path d="M10 5h6M7 7h12l-1 14H8L7 7z" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 10v7M15 10v7" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>`;

const ICON_WARN = `<svg class="toast__svg toast__svg--lava" width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><path d="M13 4L22 21H4L13 4z" fill="#E3B07C"/><path d="M13 10v5M13 17.5h.01" stroke="#5a3a12" stroke-width="1.8" stroke-linecap="round"/></svg>`;

let hideTimer = null;
let activeToast = null;

function syncToastRootPosition() {
  const root = document.getElementById("toast-root");
  const overlay = document.getElementById("overlay-root");
  if (!root) return;
  const sheetOpen =
    overlay && !overlay.hidden && overlay.querySelector(".sheet, .sheet--calendar");
  root.classList.toggle("toast-root--above-sheet", Boolean(sheetOpen));
}

function dismissToast({ immediate = false } = {}) {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (!activeToast) return;
  const el = activeToast;
  activeToast = null;
  if (immediate) {
    el.remove();
    return;
  }
  el.classList.remove("toast--visible");
  const remove = () => el.remove();
  el.addEventListener("transitionend", remove, { once: true });
  setTimeout(remove, 400);
}

function iconFor({ variant, icon }) {
  if (icon === "none") return "";
  if (icon === "trash") return ICON_TRASH;
  if (icon === "warn" || variant === "warn") return ICON_WARN;
  if (icon === "check" || variant === "success") return ICON_CHECK;
  return ICON_CHECK;
}

export function showToast(
  message,
  {
    title,
    duration = TOAST_MS,
    sticky = false,
    variant = "success",
    icon,
    undoLabel,
    onUndo,
  } = {}
) {
  const root = document.getElementById("toast-root");
  if (!root) return;

  dismissToast({ immediate: true });
  syncToastRootPosition();

  const el = document.createElement("div");
  const isWarn = variant === "warn";
  el.className = `toast toast--pill${isWarn ? " toast--warn" : ""}`;
  el.setAttribute("data-testid", "app-toast");

  const line = message ?? "";
  const lines = [];
  if (title) lines.push(`<span class="toast__line toast__line--title">${escapeHtml(title)}</span>`);
  if (line) lines.push(`<span class="toast__line">${escapeHtml(line)}</span>`);

  const iconHtml = icon === "none" ? "" : iconFor({ variant, icon });
  if (!iconHtml) el.classList.add("toast--no-icon");
  const undoHtml =
    undoLabel && onUndo
      ? `<button type="button" class="toast__undo" data-action="undo">${escapeHtml(undoLabel)}</button>`
      : "";

  el.innerHTML = `
    ${iconHtml ? `<span class="toast__icon">${iconHtml}</span>` : ""}
    <div class="toast__body">${lines.join("")}</div>
    ${undoHtml}
  `;

  root.appendChild(el);
  activeToast = el;
  requestAnimationFrame(() => el.classList.add("toast--visible"));

  if (undoHtml) {
    el.querySelector('[data-action="undo"]')?.addEventListener("click", () => {
      dismissToast({ immediate: true });
      onUndo();
    });
  }

  if (!sticky) {
    hideTimer = setTimeout(() => dismissToast(), undoHtml ? UNDO_MS : duration);
  }
}

export function dismissActiveToast() {
  dismissToast({ immediate: true });
}

export function showWarnToast(message, options = {}) {
  showToast(message, { ...options, variant: "warn", icon: options.icon ?? "warn" });
}

export function showTwoLineToast(title, line, options = {}) {
  showToast(line, { ...options, title });
}
