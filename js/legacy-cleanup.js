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

function vacrecapScopePrefix() {
  try {
    return new URL(getBasePath(), window.location.href).href;
  } catch {
    return null;
  }
}

async function unregisterVacrecapServiceWorkers() {
  if (!("serviceWorker" in navigator)) return;
  const prefix = vacrecapScopePrefix();
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    regs
      .filter((r) => {
        if (!prefix) return r.scope.includes("/VacRecap/");
        return r.scope === prefix || r.scope.startsWith(prefix);
      })
      .map((r) => r.unregister())
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
