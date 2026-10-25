import { bindBackdropDismiss } from "./gesture-guard.js";

let activeClose = null;
const closeStack = [];
let closingFromPop = false;
let ignoreNextPop = false;

export function initOverlayHistory() {
  window.addEventListener("popstate", () => {
    if (ignoreNextPop) {
      ignoreNextPop = false;
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
}

/** Menü schließen ohne history.back(), damit eine folgende Navigation nicht rückgängig wird. */
export function releaseOverlayHistory(closeFn) {
  if (activeClose === closeFn) {
    activeClose = closeStack.pop() ?? null;
  } else {
    closeStack.length = 0;
    activeClose = null;
  }
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

export function bindOverlay(overlay, closeFn) {
  openOverlayHistory(closeFn);
  const openedAt = Date.now();
  bindBackdropDismiss(overlay, () => {
    if (Date.now() - openedAt < 300) return;
    closeOverlayHistory(closeFn);
  });
}
