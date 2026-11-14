import {
  CloudNetworkError,
  CloudOfflineError,
  MediaSortUnavailableError,
} from "./cloud-errors.js";
import { mediaSortColumnAvailable } from "./db.js";
import { clearPlaceMediaOrder, savePlaceMediaOrder } from "./media-sort.js";
import { showToast, showWarnToast } from "./toast.js";

const THRESHOLD = 10;
const UNAVAILABLE = "Die Reihenfolge ist noch nicht verfügbar.";

let suppressClick = false;
let suppressTimer = 0;
let saving = false;
let session = null;

function armClickSuppress() {
  suppressClick = true;
  clearTimeout(suppressTimer);
  suppressTimer = setTimeout(() => {
    suppressClick = false;
  }, 350);
}

function messageFor(err) {
  if (err instanceof MediaSortUnavailableError) return err.message || UNAVAILABLE;
  if (err instanceof CloudOfflineError || err instanceof CloudNetworkError) return err.message;
  return err?.message || "Die Reihenfolge konnte nicht gespeichert werden.";
}

function overlayOpen() {
  const overlay = document.getElementById("overlay-root");
  return Boolean(overlay && !overlay.hidden);
}

function begin(target, x, y, kind, pointerId) {
  if (saving || session || overlayOpen()) return;
  const row = target?.closest?.("[data-testid='photo-caption-row']");
  if (!row || row.dataset.sortable !== "1") return;
  const list = row.closest(".photo-rows");
  const placeId = row.closest("[data-place-id]")?.dataset.placeId;
  if (!list || !placeId) return;
  session = {
    kind,
    pointerId,
    startX: x,
    startY: y,
    row,
    list,
    placeId,
    decided: null,
  };
}

function advance(x, y) {
  if (!session || session.decided === "swipe") return false;
  if (session.decided === "drag") {
    moveDrag(x, y);
    return true;
  }
  const dx = x - session.startX;
  const dy = y - session.startY;
  if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return false;
  if (Math.abs(dx) > Math.abs(dy) * 1.2) {
    session.decided = "swipe";
    return false;
  }
  if (!startDrag(y)) return false;
  moveDrag(x, y);
  return true;
}

function startDrag(y) {
  const { list, row } = session;
  const selected = [...list.querySelectorAll(".photo-row[data-sortable='1']")];
  if (!selected.length) {
    session.decided = "swipe";
    return false;
  }
  session.decided = "drag";
  if (session.kind === "pointer") armClickSuppress();
  const rowRect = row.getBoundingClientRect();
  session.grabDy = session.startY - rowRect.top;
  session.blockIds = selected.map((item) => item.dataset.mediaId);
  session.original = [...list.querySelectorAll(".photo-row")].map((item) => item.dataset.mediaId);
  const height = selected.reduce((sum, item) => sum + item.getBoundingClientRect().height, 0);
  const gap = document.createElement("div");
  gap.className = "photo-row-gap";
  gap.dataset.testid = "photo-row-gap";
  gap.setAttribute("aria-hidden", "true");
  gap.style.height = `${Math.max(76, height)}px`;
  list.insertBefore(gap, selected[0]);
  const float = document.createElement("div");
  float.className = "photo-row-drag";
  float.dataset.testid = "photo-row-drag";
  float.setAttribute("aria-hidden", "true");
  for (const source of selected) {
    const clone = source.cloneNode(true);
    clone.removeAttribute("data-testid");
    clone.querySelectorAll("[data-testid]").forEach((node) => node.removeAttribute("data-testid"));
    float.appendChild(clone);
  }
  document.body.appendChild(float);
  document.body.classList.add("photo-row-dragging");
  for (const source of selected) source.classList.add("photo-row--source");
  session.gap = gap;
  session.float = float;
  placeGap(y);
  placeFloat(y);
  return true;
}

function placeGap(y) {
  const { list, gap } = session;
  if (!list || !gap) return;
  const rows = [...list.querySelectorAll(".photo-row:not(.photo-row--source)")];
  let before = null;
  for (const item of rows) {
    const rect = item.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      before = item;
      break;
    }
  }
  if (before) list.insertBefore(gap, before);
  else list.appendChild(gap);
}

function placeFloat(y) {
  const { list, float, grabDy } = session;
  if (!list || !float) return;
  const card = list.closest(".oc") || list;
  const rect = card.getBoundingClientRect();
  float.style.width = `${rect.width + 28}px`;
  float.style.left = `${rect.left - 14}px`;
  float.style.top = `${y - (grabDy || 0)}px`;
}

function moveDrag(yClientX, y) {
  void yClientX;
  const scroller = session.list?.closest("[data-page='current']");
  if (scroller) {
    const rect = scroller.getBoundingClientRect();
    if (y < rect.top + 48) scroller.scrollTop -= 16;
    else if (y > rect.bottom - 48) scroller.scrollTop += 16;
  }
  placeGap(y);
  placeFloat(y);
}

function readOrder(current) {
  const { list, gap, blockIds } = current;
  const ids = [];
  let placed = false;
  for (const child of list?.children || []) {
    if (child === gap) {
      ids.push(...(blockIds || []));
      placed = true;
      continue;
    }
    if (child.classList?.contains("photo-row--source")) continue;
    if (child.dataset?.mediaId) ids.push(child.dataset.mediaId);
  }
  if (!placed) ids.push(...(blockIds || []));
  return ids;
}

function cleanup(current = session) {
  document.body.classList.remove("photo-row-dragging");
  current?.float?.remove();
  current?.gap?.remove();
  current?.list?.querySelectorAll(".photo-row--source").forEach((row) => {
    row.classList.remove("photo-row--source");
  });
}

async function commit(current) {
  if (!current?.list?.isConnected) {
    cleanup(current);
    return;
  }
  const ids = readOrder(current);
  if (!mediaSortColumnAvailable()) {
    cleanup(current);
    showWarnToast(UNAVAILABLE);
    return;
  }
  if (!ids.length || ids.join(",") === (current.original || []).join(",")) {
    cleanup(current);
    return;
  }
  saving = true;
  try {
    await savePlaceMediaOrder(current.placeId, ids);
    if (typeof window.vacrecapApplyMediaOrder === "function") {
      await window.vacrecapApplyMediaOrder(current.placeId, ids);
    }
    showToast("Reihenfolge gespeichert");
  } catch (err) {
    showWarnToast(messageFor(err));
  } finally {
    cleanup(current);
    saving = false;
  }
}

function end(kind, pointerId) {
  const current = session;
  if (!current || current.kind !== kind || current.pointerId !== pointerId) return;
  session = null;
  if (current.decided !== "drag") return;
  if (kind === "pointer") armClickSuppress();
  void commit(current);
}

async function onReset(event) {
  const button = event.target?.closest?.("[data-action='photo-sort-reset']");
  if (!button || saving) return;
  event.preventDefault();
  event.stopPropagation();
  const placeId = document.querySelector("[data-page='current'] .oc--selected")?.dataset.placeId;
  if (!placeId) return;
  if (!mediaSortColumnAvailable()) {
    showWarnToast(UNAVAILABLE);
    return;
  }
  saving = true;
  try {
    await clearPlaceMediaOrder(placeId);
    if (typeof window.vacrecapApplyMediaOrder === "function") {
      await window.vacrecapApplyMediaOrder(placeId, null);
    }
    showToast("Nach Aufnahmezeit sortiert");
  } catch (err) {
    showWarnToast(messageFor(err));
  } finally {
    saving = false;
  }
}

function onPointerDown(event) {
  if (event.pointerType === "touch" || event.button !== 0) return;
  begin(event.target, event.clientX, event.clientY, "pointer", event.pointerId);
}

function onPointerMove(event) {
  if (event.pointerType === "touch") return;
  if (!session || session.kind !== "pointer" || event.pointerId !== session.pointerId) return;
  if (!advance(event.clientX, event.clientY)) return;
  event.preventDefault();
  event.stopPropagation();
}

function onPointerUp(event) {
  if (event.pointerType === "touch") return;
  end("pointer", event.pointerId);
}

function onTouchStart(event) {
  if (event.touches.length !== 1) return;
  const touch = event.touches[0];
  begin(event.target, touch.clientX, touch.clientY, "touch", touch.identifier);
}

function onTouchMove(event) {
  if (!session || session.kind !== "touch") return;
  const touch = [...event.touches].find((item) => item.identifier === session.pointerId);
  if (!touch) return;
  if (!advance(touch.clientX, touch.clientY)) return;
  if (event.cancelable) event.preventDefault();
  event.stopPropagation();
}

function onTouchEnd(event) {
  const touch = event.changedTouches?.[0];
  if (!touch) return;
  end("touch", touch.identifier);
}

function onClick(event) {
  if (!suppressClick) return;
  suppressClick = false;
  event.preventDefault();
  event.stopPropagation();
}

export function installPhotoRowDrag() {
  if (typeof document === "undefined") return;
  if (document.documentElement.dataset.photoDrag === "1") return;
  document.documentElement.dataset.photoDrag = "1";
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPointerUp, false);
  document.addEventListener("pointercancel", onPointerUp, false);
  document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  document.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
  document.addEventListener("touchend", onTouchEnd, false);
  document.addEventListener("touchcancel", onTouchEnd, false);
  document.addEventListener("click", onClick, true);
  document.addEventListener("click", onReset, true);
}

installPhotoRowDrag();
