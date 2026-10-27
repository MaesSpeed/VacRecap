export const BOOT_GUARD_KEY = "vr-boot";
const STABLE_DELAY_MS = 5000;

export function markBootStable() {
  localStorage.setItem(
    BOOT_GUARD_KEY,
    JSON.stringify({ unstable: false, crashCount: 0 })
  );
}

export function installBootStableReporting() {
  if (window.__VR_DISABLE_STABLE__) return;
  const mark = () => markBootStable();
  window.setTimeout(mark, STABLE_DELAY_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") mark();
  });
  window.addEventListener("pagehide", mark);
}
