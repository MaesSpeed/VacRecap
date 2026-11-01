import { bindBackdropDismiss } from "./gesture-guard.js";
import { dismissTopPullLayer } from "./sheet-pull.js";
import { syncToastRootPosition } from "./toast.js";

let activeClose = null;
let activeDismiss = null;
const closeStack = [];
const dismissStack = [];
let closingFromPop = false;
let ignoreNextPop = false;

export const SHEET_INPUT_BLOCK_MS = 450;

let footerBlockedUntil = 0;

export function blockTripFooter(ms = SHEET_INPUT_BLOCK_MS) {
  footerBlockedUntil = performance.now() + ms;
}

export function isTripFooterBlocked() {
  return performance.now() < footerBlockedUntil;
}

function editingField(target) {
  if (!target || typeof target.closest !== "function") return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function onEscapeKey(event) {
  if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
  const confirm = document.querySelector(".overlay-confirm-layer");
  if (confirm) {
    event.stopImmediatePropagation();
    confirm.querySelector("[data-action='cancel']")?.click();
    return;
  }
  if (dismissTopPullLayer()) {
    if (!editingField(event.target)) event.preventDefault();
    return;
  }
  if (!activeClose) return;
  if (!editingField(event.target)) event.preventDefault();
  requestOverlayDismiss();
}

export function initOverlayHistory() {
  window.addEventListener("popstate", () => {
    if (ignoreNextPop) {
      ignoreNextPop = false;
      return;
    }
    if (activeDismiss) {
      void activeDismiss();
      return;
    }
    if (!activeClose) return;
    closingFromPop = true;
    const fn = activeClose;
    activeClose = closeStack.pop() ?? null;
    activeDismiss = dismissStack.pop() ?? null;
    fn();
    closingFromPop = false;
    syncToastRootPosition();
  });
  window.addEventListener("keydown", onEscapeKey, true);
}

export function openOverlayHistory(closeFn, dismissHandler = null) {
  if (activeClose) {
    closeStack.push(activeClose);
    dismissStack.push(activeDismiss);
  }
  activeClose = closeFn;
  activeDismiss = dismissHandler || null;
  history.pushState({ vacrecapOverlay: true }, "");
  syncToastRootPosition();
}

export function closeOverlayHistory(closeFn) {
  if (closingFromPop) {
    closeFn();
    syncToastRootPosition();
    return;
  }
  if (activeClose === closeFn) {
    const parent = closeStack.pop() ?? null;
    const parentDismiss = dismissStack.pop() ?? null;
    activeClose = null;
    activeDismiss = null;
    if (history.state?.vacrecapOverlay) {
      ignoreNextPop = true;
      history.back();
    }
    activeClose = parent;
    activeDismiss = parentDismiss;
  }
  closeFn();
  syncToastRootPosition();
}

export function abandonOverlayHistory() {
  activeClose = null;
  activeDismiss = null;
  closeStack.length = 0;
  dismissStack.length = 0;
  if (history.state?.vacrecapOverlay) {
    ignoreNextPop = true;
    history.back();
  }
  syncToastRootPosition();
}

export function dismissOverlayOnly() {
  while (activeClose) {
    const fn = activeClose;
    activeClose = closeStack.pop() ?? null;
    activeDismiss = dismissStack.pop() ?? null;
    fn();
  }
  closeStack.length = 0;
  dismissStack.length = 0;
  activeClose = null;
  activeDismiss = null;
  syncToastRootPosition();
}

export function releaseOverlayHistory(closeFn) {
  if (activeClose === closeFn) {
    activeClose = closeStack.pop() ?? null;
    activeDismiss = dismissStack.pop() ?? null;
  } else {
    closeStack.length = 0;
    dismissStack.length = 0;
    activeClose = null;
    activeDismiss = null;
  }
  closeFn();
  if (history.state?.vacrecapOverlay) {
    const next = { ...history.state };
    delete next.vacrecapOverlay;
    history.replaceState(Object.keys(next).length ? next : null, "");
  }
  syncToastRootPosition();
}

export function hasActiveOverlay() {
  return Boolean(activeClose);
}

/** Schließt das oberste Sheet wie Abbrechen oder der Zurück-Pfad. */
export function requestOverlayDismiss() {
  if (!activeClose) return false;
  if (activeDismiss) {
    void activeDismiss();
    return true;
  }
  const fn = activeClose;
  closeOverlayHistory(fn);
  return true;
}

/**
 * @param {HTMLElement} overlay
 * @param {() => void} domClose – synchrones Aufräumen (immer activeClose)
 * @param {() => void | Promise<void>} [dismissHandler] – optional Dirty-Check vor closeOverlayHistory(domClose)
 */
export function bindOverlay(overlay, domClose, dismissHandler) {
  let unbindBackdrop = null;
  const activeDomClose = () => {
    unbindBackdrop?.();
    unbindBackdrop = null;
    domClose();
  };
  openOverlayHistory(activeDomClose, dismissHandler ?? null);
  const openedAt = performance.now();
  const sheet = overlay.querySelector(".sheet");
  if (sheet) {
    sheet.classList.add("sheet--input-blocked");
    setTimeout(() => sheet.classList.remove("sheet--input-blocked"), SHEET_INPUT_BLOCK_MS);
  }
  unbindBackdrop = bindBackdropDismiss(overlay, () => {
    if (performance.now() - openedAt < SHEET_INPUT_BLOCK_MS) return;
    if (dismissHandler) void dismissHandler();
    else closeOverlayHistory(activeDomClose);
  });
  requestAnimationFrame(() => syncToastRootPosition());
  return activeDomClose;
}
