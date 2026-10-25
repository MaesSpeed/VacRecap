import { bindBackdropDismiss } from "./gesture-guard.js";

let activeClose = null;
let closingFromPop = false;

export function initOverlayHistory() {
  window.addEventListener("popstate", () => {
    if (!activeClose) return;
    closingFromPop = true;
    const fn = activeClose;
    activeClose = null;
    fn();
    closingFromPop = false;
  });
}

export function openOverlayHistory(closeFn) {
  if (activeClose) {
    activeClose();
    activeClose = null;
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
    activeClose = null;
    if (history.state?.vacrecapOverlay) {
      history.back();
    }
  }
  closeFn();
}

export function dismissOverlayOnly() {
  if (activeClose) {
    const fn = activeClose;
    activeClose = null;
    fn();
  }
}

export function hasActiveOverlay() {
  return Boolean(activeClose);
}

export function bindOverlay(overlay, closeFn) {
  openOverlayHistory(closeFn);
  bindBackdropDismiss(overlay, () => closeOverlayHistory(closeFn));
}
