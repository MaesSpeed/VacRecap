const SUPPRESS_MS = 400;
let suppressUntil = 0;
let suppressRoot = null;

export function armPointerSuppression(ms = SUPPRESS_MS, rootEl = null) {
  suppressUntil = Date.now() + ms;
  suppressRoot = rootEl;
}

export function isPointerSuppressed() {
  return Date.now() < suppressUntil;
}

export function installGestureGuards() {
  const block = (e) => {
    if (!isPointerSuppressed()) return;
    const overlay = document.getElementById("overlay-root");
    if (overlay && !overlay.hidden && e.target === overlay) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (suppressRoot && suppressRoot.contains(e.target)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  ["click", "pointerup", "touchend"].forEach((type) => {
    document.addEventListener(type, block, true);
  });
}

export function bindBackdropDismiss(overlay, closeFn) {
  overlay.addEventListener("click", (e) => {
    if (isPointerSuppressed()) return;
    if (e.target === overlay) closeFn();
  });
}
