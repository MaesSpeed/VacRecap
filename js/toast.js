import { escapeHtml } from "./utils.js";

const TOAST_MS = 2500;

let hideTimer = null;
let activeToast = null;

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

export function showToast(message, { title, duration = TOAST_MS, sticky = false } = {}) {
  const root = document.getElementById("toast-root");
  if (!root) return;

  dismissToast({ immediate: true });

  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("data-testid", "app-toast");
  el.innerHTML = `
    <span class="toast__icon" aria-hidden="true">✓</span>
    <div class="toast__text">
      ${title ? `<strong>${escapeHtml(title)}</strong>` : ""}
      <span>${escapeHtml(message)}</span>
    </div>
  `;
  root.appendChild(el);
  activeToast = el;
  requestAnimationFrame(() => el.classList.add("toast--visible"));

  if (!sticky) {
    hideTimer = setTimeout(() => dismissToast(), duration);
  }
}

export function dismissActiveToast() {
  dismissToast({ immediate: true });
}
