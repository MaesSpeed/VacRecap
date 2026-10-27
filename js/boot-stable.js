export const BOOT_GUARD_KEY = "vr-boot";

export function markBootStable() {
  const now = Date.now();
  localStorage.setItem(
    BOOT_GUARD_KEY,
    JSON.stringify({ since: now, attempts: 0, stable: true })
  );
}

export function installBootStableReporting() {
  if (window.__VR_DISABLE_STABLE__) return;
  const mark = () => markBootStable();
  window.setTimeout(mark, 8000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") mark();
  });
  window.addEventListener("pagehide", mark);
}
