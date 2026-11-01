/**
 * Herunterziehen schließt ein Sheet.
 * Schwellen wie bisher: über 72 px, oder schnell (über 0,55 px/ms) über 24 px.
 * Gezogen wird am Griff oder Kopf. Im Inhalt nur, wenn die Liste oben steht.
 * Textfelder starten keinen Zug.
 */

const layers = [];

function pruneLayers() {
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    if (!layers[i].sheet?.isConnected) layers.splice(i, 1);
  }
}

function isField(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
}

/**
 * Schließt das oberste per bindSheetPull gemeldete Sheet, das noch im DOM hängt.
 * @returns {boolean}
 */
export function dismissTopPullLayer() {
  pruneLayers();
  const entry = layers[layers.length - 1];
  if (!entry) return false;
  entry.onClose();
  if (!entry.sheet?.isConnected) {
    const index = layers.indexOf(entry);
    if (index >= 0) layers.splice(index, 1);
  }
  return true;
}

export function bindSheetPull(sheet, { onClose, scrollEl } = {}) {
  if (!sheet || typeof onClose !== "function") return () => {};
  pruneLayers();
  let tracking = false;
  let dragging = false;
  let decided = false;
  let startY = 0;
  let startX = 0;
  let lastY = 0;
  let lastT = 0;
  let vel = 0;
  let closed = false;

  const entry = { sheet, onClose: () => closeOnce() };
  layers.push(entry);

  const forget = () => {
    const index = layers.indexOf(entry);
    if (index >= 0) layers.splice(index, 1);
  };

  const closeOnce = () => {
    if (closed) return;
    closed = true;
    forget();
    onClose();
  };

  const rearm = () => {
    if (!sheet.isConnected) return;
    closed = false;
    tracking = false;
    dragging = false;
    if (!layers.includes(entry)) layers.push(entry);
    sheet.style.transition = "transform 320ms cubic-bezier(0.34, 1.25, 0.64, 1)";
    sheet.style.transform = "translate3d(0px, 0px, 0px)";
  };
  sheet._pullRearm = rearm;

  const pullFrom = (target) =>
    Boolean(
      target?.closest?.(
        "[data-role='pick-handle'], .sheet-handle, .sheet__header, .sheet__title, .note-sheet__bar"
      )
    );

  const begin = (y, x) => {
    tracking = true;
    dragging = false;
    decided = false;
    startY = lastY = y;
    startX = x;
    lastT = performance.now();
    vel = 0;
    sheet.style.transition = "none";
  };

  const move = (y, x, event, target) => {
    if (!tracking || closed) return;
    const dy = y - startY;
    const dx = x - startX;
    if (!decided) {
      if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
      decided = true;
      const fromHandle = pullFrom(target);
      if (isField(target) && !fromHandle) {
        dragging = false;
        tracking = false;
        return;
      }
      const scrolled = scrollEl && scrollEl.scrollTop > 2;
      dragging = dy > 0 && Math.abs(dy) > Math.abs(dx) && (fromHandle || !scrolled);
    }
    if (!dragging) return;
    if (event?.pointerId != null && !sheet.hasPointerCapture?.(event.pointerId)) {
      try {
        sheet.setPointerCapture(event.pointerId);
      } catch {
        /* Zug ohne Capture */
      }
    }
    if (event?.cancelable) event.preventDefault();
    const pull = Math.max(0, y - startY);
    sheet.style.transform = `translate3d(0px, ${pull}px, 0px)`;
    const now = performance.now();
    const dt = now - lastT;
    if (dt >= 16) {
      vel = (y - lastY) / dt;
      lastY = y;
      lastT = now;
    }
  };

  const end = () => {
    if (!tracking || closed) return;
    tracking = false;
    if (!dragging) {
      sheet.style.transition = "";
      return;
    }
    dragging = false;
    const match = /translate3d\(\s*[^,]+,\s*(-?[\d.]+)px/.exec(sheet.style.transform || "");
    const pull = match ? Number(match[1]) : 0;
    if (pull > 72 || (vel > 0.55 && pull > 24)) {
      sheet.style.transition = "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)";
      sheet.style.transform = "translate3d(0, 110%, 0)";
      sheet.addEventListener("transitionend", () => closeOnce(), { once: true });
      setTimeout(closeOnce, 280);
      return;
    }
    sheet.style.transition = "transform 320ms cubic-bezier(0.34, 1.25, 0.64, 1)";
    sheet.style.transform = "translate3d(0, 0, 0)";
  };

  const reset = () => {
    tracking = false;
    dragging = false;
    if (closed) return;
    sheet.style.transition = "transform 320ms cubic-bezier(0.34, 1.25, 0.64, 1)";
    sheet.style.transform = "translate3d(0px, 0px, 0px)";
  };

  const ownsGesture = (target) => {
    const nested = target?.closest?.(".sheet");
    return !nested || nested === sheet;
  };

  const onTouchStart = (e) => {
    if (e.touches.length !== 1 || closed || isField(e.target) || !ownsGesture(e.target)) return;
    begin(e.touches[0].clientY, e.touches[0].clientX);
    sheet._pullTarget = e.target;
  };
  const onTouchMove = (e) => {
    if (!tracking || e.touches.length !== 1) return;
    move(e.touches[0].clientY, e.touches[0].clientX, e, sheet._pullTarget || e.target);
  };
  const onPointerDown = (e) => {
    if (e.pointerType === "touch" || e.button !== 0 || closed || isField(e.target) || !ownsGesture(e.target)) return;
    sheet._pullTarget = e.target;
    begin(e.clientY, e.clientX);
  };
  const onPointerMove = (e) => {
    if (e.pointerType === "touch" || !tracking) return;
    move(e.clientY, e.clientX, e, sheet._pullTarget);
  };
  const onPointerUp = (e) => {
    if (e.pointerType === "touch") return;
    end();
  };

  sheet.addEventListener("touchstart", onTouchStart, { passive: true });
  sheet.addEventListener("touchmove", onTouchMove, { passive: false });
  sheet.addEventListener("touchend", end);
  sheet.addEventListener("touchcancel", reset);
  sheet.addEventListener("pointerdown", onPointerDown);
  sheet.addEventListener("pointermove", onPointerMove);
  sheet.addEventListener("pointerup", onPointerUp);
  sheet.addEventListener("pointercancel", reset);

  return () => {
    forget();
    sheet.removeEventListener("touchstart", onTouchStart);
    sheet.removeEventListener("touchmove", onTouchMove);
    sheet.removeEventListener("touchend", end);
    sheet.removeEventListener("touchcancel", reset);
    sheet.removeEventListener("pointerdown", onPointerDown);
    sheet.removeEventListener("pointermove", onPointerMove);
    sheet.removeEventListener("pointerup", onPointerUp);
    sheet.removeEventListener("pointercancel", reset);
  };
}

export const bindSubSheetPull = bindSheetPull;
