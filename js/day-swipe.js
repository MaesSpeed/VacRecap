/**
 * Tageswechsel per Wisch: nur transform (translate3d), kein Layout im Move.
 * Vertikal bleibt natives Scrollen (touch-action: pan-y). iPhone 8 / Safari.
 */

const REST = "translate3d(-33.333333%, 0, 0)";
const DAY_SWIPE_BEZIER = [0.2, 0.82, 0.2, 1];

export const DAY_SWIPE_MS = 280;

function bezierAxis(a, b, t) {
  const c = 3 * a;
  const d = 3 * (b - a) - c;
  const e = 1 - c - d;
  return ((e * t + d) * t + c) * t;
}

export function daySwipeEase(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = DAY_SWIPE_BEZIER;
  let lo = 0;
  let hi = 1;
  let t = x;
  for (let i = 0; i < 14; i++) {
    t = (lo + hi) / 2;
    if (bezierAxis(x1, x2, t) < x) lo = t;
    else hi = t;
  }
  return bezierAxis(y1, y2, t);
}

function daySwipeTransition() {
  const [x1, y1, x2, y2] = DAY_SWIPE_BEZIER;
  return `transform ${DAY_SWIPE_MS}ms cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`;
}

function trackOf(root) {
  return root.querySelector("[data-role='day-track']");
}

const settleControls = new WeakMap();

/** Bricht die Einrast-Animation ab, ohne den Tag zu wechseln. */
export function cancelDaySwipeSettle(root) {
  settleControls.get(root)?.cancel();
}

function ensureStructure(root) {
  if (root.dataset.daySwipe === "1" && trackOf(root)) return;
  root.dataset.daySwipe = "1";
  root.classList.add("trip-content--swipe");
  root.innerHTML = `
    <div class="day-swipe">
      <div class="day-swipe__track" data-role="day-track">
        <div class="day-swipe__page" data-page="prev" aria-hidden="true"></div>
        <div class="day-swipe__page day-swipe__page--current" data-page="current"></div>
        <div class="day-swipe__page" data-page="next" aria-hidden="true"></div>
      </div>
    </div>
    <div class="place-list-fade" aria-hidden="true"></div>`;
  const track = trackOf(root);
  if (track) {
    track.style.transition = "none";
    track.style.transform = REST;
  }
}

export function setDaySwipePage(root, html, opts = {}) {
  ensureStructure(root);
  const page = root.querySelector("[data-page='current']");
  const track = trackOf(root);
  const gesturing = root.dataset.gesture === "1";
  const scrollTop = page && (gesturing || opts.keepScroll) ? page.scrollTop : 0;
  if (page) {
    page.innerHTML = html;
    page.scrollTop = scrollTop;
  }
  if (track && !gesturing) {
    track.style.transition = "none";
    track.style.transform = REST;
    root.dataset.swipeLock = "0";
  }
}

export function setDaySwipeNeighbor(root, which, html) {
  const page = root.querySelector(`[data-page="${which}"]`);
  if (page) page.innerHTML = html || "";
}

export function installDaySwipe(root, onShift, hooks = {}) {
  ensureStructure(root);
  if (root.dataset.swipeBound === "1") return;
  root.dataset.swipeBound = "1";

  let tracking = false;
  let mode = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastT = 0;
  let vel = 0;
  let width = 1;
  let docMove = null;
  const settle = { gen: 0, timer: 0, onEnd: null };

  const cancelSettle = () => {
    settle.gen += 1;
    if (settle.timer) clearTimeout(settle.timer);
    settle.timer = 0;
    const track = trackOf(root);
    if (settle.onEnd && track) track.removeEventListener("transitionend", settle.onEnd);
    settle.onEnd = null;
    if (track) {
      track.style.transition = "none";
      track.style.transform = REST;
    }
    root.dataset.swipeLock = "0";
    root.dataset.gesture = "0";
  };
  settleControls.set(root, { cancel: cancelSettle });

  const canPrev = () => root.dataset.canPrev === "1";
  const canNext = () => root.dataset.canNext === "1";

  const resisted = (dx) => {
    if (dx > 0 && !canPrev()) return dx * 0.32;
    if (dx < 0 && !canNext()) return dx * 0.32;
    return dx;
  };

  const dragRatio = (dx) => (width ? resisted(dx) / width : 0);

  const apply = (dx) => {
    const track = trackOf(root);
    if (!track) return;
    const px = Math.abs(dx);
    const signed = dx < 0 ? `- ${px}px` : `+ ${px}px`;
    track.style.transform = `translate3d(calc(-33.333333% ${signed}), 0px, 0px)`;
  };

  const rest = () => {
    const track = trackOf(root);
    if (!track) return;
    track.style.transition = "transform 360ms cubic-bezier(0.34, 1.28, 0.64, 1)";
    track.style.transform = REST;
  };

  const detachDoc = () => {
    if (!docMove) return;
    document.removeEventListener("touchmove", docMove);
    docMove = null;
  };

  const armDocBlock = () => {
    if (docMove) return;
    docMove = (ev) => {
      if (mode === "h" && ev.cancelable) ev.preventDefault();
    };
    document.addEventListener("touchmove", docMove, { passive: false });
  };

  const onStart = (x, y) => {
    if (root.dataset.swipeLock === "1") return;
    if (!root.isConnected) return;
    const track = trackOf(root);
    if (!track) return;
    tracking = true;
    mode = null;
    startX = lastX = x;
    startY = y;
    lastT = performance.now();
    vel = 0;
    width = root.clientWidth || window.innerWidth || 1;
    track.style.transition = "none";
    root.dataset.gesture = "1";
  };

  const onMove = (x, y, event) => {
    if (!tracking) return;
    const dx = x - startX;
    const dy = y - startY;
    if (!mode) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      mode = Math.abs(dx) > Math.abs(dy) * 1.2 ? "h" : "v";
      if (mode === "h") {
        if (event?.pointerId != null) {
          try {
            root.setPointerCapture?.(event.pointerId);
          } catch {
            /* synthetischer Pointer oder bereits gelöst */
          }
        }
        hooks.onLock?.();
        armDocBlock();
      }
    }
    if (mode !== "h") return;
    if (event?.pointerType && event.cancelable) event.preventDefault();
    const now = performance.now();
    const dt = now - lastT;
    if (dt >= 16) {
      vel = (x - lastX) / dt;
      lastX = x;
      lastT = now;
    }
    const moved = resisted(dx);
    apply(moved);
    hooks.onDrag?.({ ratio: dragRatio(dx), dx, width });
  };

  const finish = (x) => {
    if (!tracking) return;
    const wasH = mode === "h";
    const dx = x - startX;
    tracking = false;
    mode = null;
    root.dataset.gesture = "0";
    detachDoc();
    if (!wasH) return;
    if (Math.abs(dx) > 36) {
      root.dataset.suppressClick = "1";
      setTimeout(() => {
        if (root.isConnected) root.dataset.suppressClick = "0";
      }, 400);
    }
    const track = trackOf(root);
    if (!track) return;
    hooks.onDrag?.({ ratio: dragRatio(dx), dx, width });
    const threshold = Math.min(96, Math.max(48, width * 0.22));
    const fling = Math.abs(vel) > 0.55 && Math.abs(dx) > 16;
    let dir = 0;
    if ((dx <= -threshold || (fling && vel < 0 && dx < 0)) && canNext()) dir = 1;
    else if ((dx >= threshold || (fling && vel > 0 && dx > 0)) && canPrev()) dir = -1;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!dir) {
      rest();
      hooks.onCancel?.();
      hooks.onRest?.();
      return;
    }
    hooks.onCommit?.(dir);
    if (reduce) {
      track.style.transition = "none";
      track.style.transform = REST;
      onShift(dir);
      return;
    }
    root.dataset.swipeLock = "1";
    const target = dir > 0 ? "translate3d(-66.666666%, 0, 0)" : "translate3d(0px, 0, 0)";
    track.style.transition = daySwipeTransition();
    track.style.transform = target;
    const gen = ++settle.gen;
    let settled = false;
    const done = () => {
      if (settled || gen !== settle.gen) return;
      settled = true;
      if (settle.timer) clearTimeout(settle.timer);
      settle.timer = 0;
      if (settle.onEnd) track.removeEventListener("transitionend", settle.onEnd);
      settle.onEnd = null;
      const incoming = root.querySelector(`[data-page="${dir > 0 ? "next" : "prev"}"]`);
      const current = root.querySelector("[data-page='current']");
      if (incoming && current && incoming.innerHTML.trim()) current.innerHTML = incoming.innerHTML;
      hooks.onRest?.();
      track.style.transition = "none";
      track.style.transform = REST;
      onShift(dir);
      setTimeout(() => {
        if (root.isConnected && root.dataset.swipeLock === "1") root.dataset.swipeLock = "0";
      }, 900);
    };
    const onEnd = (ev) => {
      if (ev.propertyName !== "transform") return;
      done();
    };
    settle.onEnd = onEnd;
    track.addEventListener("transitionend", onEnd);
    settle.timer = setTimeout(done, 420);
  };

  root.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      onStart(e.touches[0].clientX, e.touches[0].clientY);
    },
    { passive: true }
  );

  root.addEventListener(
    "touchmove",
    (e) => {
      if (!tracking || e.touches.length !== 1) return;
      onMove(e.touches[0].clientX, e.touches[0].clientY, e);
    },
    { passive: true }
  );

  root.addEventListener("touchend", (e) => {
    finish(e.changedTouches[0].clientX);
  });

  const abortGesture = () => {
    if (!tracking) return;
    const wasH = mode === "h";
    tracking = false;
    mode = null;
    root.dataset.gesture = "0";
    detachDoc();
    rest();
    if (wasH) hooks.onCancel?.();
  };

  root.addEventListener("touchcancel", () => {
    abortGesture();
  });

  root.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    onStart(e.clientX, e.clientY);
  });
  root.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    onMove(e.clientX, e.clientY, e);
  });
  root.addEventListener("pointerup", (e) => {
    if (e.pointerType === "touch") return;
    finish(e.clientX);
  });
  root.addEventListener("pointercancel", (e) => {
    if (e.pointerType === "touch") return;
    abortGesture();
  });

  root.addEventListener(
    "click",
    (e) => {
      if (root.dataset.suppressClick !== "1") return;
      root.dataset.suppressClick = "0";
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );
}
