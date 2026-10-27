import { getRoute, navigate } from "./router.js";
import { isTripFooterBlocked } from "./overlay-stack.js";

const PAUSE_MS = 2 * 60 * 1000;
const LAST_ACTIVE_KEY = "vr-last-active";

function tripRoute(route) {
  return (
    route.name === "urlaub-detail" ||
    route.name === "urlaub-settings" ||
    route.name === "urlaub-mediathek" ||
    route.name === "urlaub-map"
  );
}

function shouldSkipResumeRedirect() {
  if (isTripFooterBlocked()) return true;
  const overlay = document.getElementById("overlay-root");
  if (overlay && !overlay.hidden) return true;
  if (document.querySelector('[data-testid="note-sheet"]')) return true;
  if (document.querySelector(".screen--trip[data-capture-busy='1']")) return true;
  return false;
}

function maybeRedirectToOverview(reason, lastActiveAt) {
  if (shouldSkipResumeRedirect()) return;
  const route = getRoute();
  if (!tripRoute(route)) return;
  const last =
    lastActiveAt !== undefined
      ? lastActiveAt
      : Number(localStorage.getItem(LAST_ACTIVE_KEY) || "0");
  if (!last) return;
  if (Date.now() - last < PAUSE_MS) return;
  navigate({ name: "urlaube" }, { replace: true });
}

function touchActive() {
  localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
}

export function runColdResumeCheck() {
  const lastAtCold = Number(localStorage.getItem(LAST_ACTIVE_KEY) || "0");
  const gap = Date.now() - lastAtCold;
  maybeRedirectToOverview("cold", lastAtCold);
  touchActive();
}

export function installResumePolicy() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      touchActive();
      return;
    }
    maybeRedirectToOverview("visible");
    touchActive();
  });
  window.addEventListener("hashchange", touchActive);
}
