import { bindBackdropDismiss } from "./gesture-guard.js";

let activeClose = null;
const closeStack = [];
let closingFromPop = false;
let ignoreNextPop = false;
let overlayDismissHandler = null;

export const SHEET_INPUT_BLOCK_MS = 450;

let footerBlockedUntil = 0;

export function blockTripFooter(ms = SHEET_INPUT_BLOCK_MS) {
  footerBlockedUntil = Date.now() + ms;
}

export function isTripFooterBlocked() {
  return Date.now() < footerBlockedUntil;
}

export function initOverlayHistory() {
  window.addEventListener("popstate", () => {
    if (ignoreNextPop) {
      ignoreNextPop = false;
      return;
    }
    if (overlayDismissHandler) {
      void overlayDismissHandler();
      return;
    }
    if (!activeClose) return;
    closingFromPop = true;
    const fn = activeClose;
    activeClose = closeStack.pop() ?? null;
    fn();
    closingFromPop = false;
  });
}

export function openOverlayHistory(closeFn) {
  if (activeClose) {
    closeStack.push(activeClose);
  }
  activeClose = closeFn;
  history.pushState({ vacrecapOverlay: true }, "");
}

export function closeOverlayHistory(closeFn) {
  if (closingFromPop) {
    closeFn();
    return;
  }
  if (activeClose === closeFn) {
    const parent = closeStack.pop() ?? null;
    activeClose = null;
    overlayDismissHandler = null;
    if (history.state?.vacrecapOverlay) {
      ignoreNextPop = true;
      history.back();
    }
    activeClose = parent;
  }
  closeFn();
}

export function abandonOverlayHistory() {
  activeClose = null;
  overlayDismissHandler = null;
  closeStack.length = 0;
  if (history.state?.vacrecapOverlay) {
    ignoreNextPop = true;
    history.back();
  }
}

export function dismissOverlayOnly() {
  while (activeClose) {
    const fn = activeClose;
    activeClose = closeStack.pop() ?? null;
    fn();
  }
  closeStack.length = 0;
  overlayDismissHandler = null;
}

export function releaseOverlayHistory(closeFn) {
  if (activeClose === closeFn) {
    activeClose = closeStack.pop() ?? null;
  } else {
    closeStack.length = 0;
    activeClose = null;
  }
  overlayDismissHandler = null;
  closeFn();
  if (history.state?.vacrecapOverlay) {
    const next = { ...history.state };
    delete next.vacrecapOverlay;
    history.replaceState(Object.keys(next).length ? next : null, "");
  }
}

export function hasActiveOverlay() {
  return Boolean(activeClose);
}

/**
 * @param {HTMLElement} overlay
 * @param {() => void} domClose – synchrones Aufräumen (immer activeClose)
 * @param {() => void | Promise<void>} [dismissHandler] – optional Dirty-Check vor closeOverlayHistory(domClose)
 */
export function bindOverlay(overlay, domClose, dismissHandler) {
  overlayDismissHandler = dismissHandler ?? null;
  let unbindBackdrop = null;
  const activeDomClose = () => {
    unbindBackdrop?.();
    unbindBackdrop = null;
    domClose();
  };
  openOverlayHistory(activeDomClose);
  const openedAt = Date.now();
  const sheet = overlay.querySelector(".sheet");
  if (sheet) {
    sheet.classList.add("sheet--input-blocked");
    setTimeout(() => sheet.classList.remove("sheet--input-blocked"), SHEET_INPUT_BLOCK_MS);
  }
  unbindBackdrop = bindBackdropDismiss(overlay, () => {
    if (Date.now() - openedAt < SHEET_INPUT_BLOCK_MS) return;
    if (dismissHandler) void dismissHandler();
    else closeOverlayHistory(activeDomClose);
  });
  return activeDomClose;
}
