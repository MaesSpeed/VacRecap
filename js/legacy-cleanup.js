import { getBasePath } from "./config.js";

const IDB_NAME = "vacrecap";
const IDB_TIMEOUT_MS = 8000;

function deleteVacrecapIdb() {
  return new Promise((resolve) => {
    if (!indexedDB?.deleteDatabase) {
      resolve();
      return;
    }
    const req = indexedDB.deleteDatabase(IDB_NAME);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    req.onsuccess = done;
    req.onerror = done;
    req.onblocked = done;
    setTimeout(done, IDB_TIMEOUT_MS);
  });
}

async function clearVacrecapCaches() {
  if (!("caches" in window)) return;
  const keys = await caches.keys();
  await Promise.all(
    keys.filter((k) => k.startsWith("vacrecap-")).map((k) => caches.delete(k))
  );
}

function isVacrecapServiceWorkerScope(scopeUrl) {
  try {
    const scopePath = new URL(scopeUrl).pathname;
    if (scopePath.includes("/VacRecap")) return true;
    const basePath = new URL(getBasePath(), window.location.href).pathname;
    if (basePath.includes("/VacRecap")) {
      return scopePath === basePath || scopePath.startsWith(basePath);
    }
    return scopePath === basePath;
  } catch {
    return false;
  }
}

async function unregisterVacrecapServiceWorkers() {
  if (!("serviceWorker" in navigator)) return;
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    regs.filter((r) => isVacrecapServiceWorkerScope(r.scope)).map((r) => r.unregister())
  );
}

export function runLegacyCleanup() {
  queueMicrotask(() => {
    void (async () => {
      try {
        await Promise.all([
          deleteVacrecapIdb(),
          clearVacrecapCaches(),
          unregisterVacrecapServiceWorkers(),
        ]);
      } catch {
        /* Altbestand darf Start nicht blockieren */
      }
    })();
  });
}
