export const APP_BUILD_VERSION = 43;

export async function getAppVersionDisplayState() {
  const appVersion = APP_BUILD_VERSION;
  let updateHint = false;
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      const versions = keys
        .filter((k) => k.startsWith("vacrecap-v"))
        .map((k) => Number(k.replace("vacrecap-v", "")))
        .filter((n) => Number.isFinite(n));
      if (versions.length) {
        const cacheVersion = Math.max(...versions);
        if (cacheVersion !== appVersion) updateHint = true;
      }
    }
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg?.waiting) updateHint = true;
    }
  } catch {
    /* ignore */
  }
  return { appVersion, updateHint };
}
