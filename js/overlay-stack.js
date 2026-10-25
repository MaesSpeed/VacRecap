import { bindBackdropDismiss } from "./gesture-guard.js";

let activeClose = null;
const closeStack = [];
let closingFromPop = false;

export function initOverlayHistory() {
  window.addEventListener("popstate", () => {
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

export function hasActiveOverlay() {
  return Boolean(activeClose);
}

export function bindOverlay(overlay, closeFn) {
  openOverlayHistory(closeFn);
  bindBackdropDismiss(overlay, () => closeOverlayHistory(closeFn));
}
