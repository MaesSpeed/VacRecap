const DB_NAME = "vacrecap";
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains("vacations")) {
          const store = db.createObjectStore("vacations", { keyPath: "id" });
          store.createIndex("startDate", "startDate", { unique: false });
          store.createIndex("endDate", "endDate", { unique: false });
        }
        if (!db.objectStoreNames.contains("blobs")) {
          db.createObjectStore("blobs", { keyPath: "id" });
        }
      };
    });
  }
  return dbPromise;
}

export async function requestPersistentStorage() {
  if (navigator.storage?.persist) {
    try {
      await navigator.storage.persist();
    } catch {
      /* ignore */
    }
  }
}

export async function putVacation(vacation) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("vacations", "readwrite");
    tx.oncomplete = () => resolve(vacation);
    tx.onerror = () => reject(tx.error);
    tx.objectStore("vacations").put(vacation);
  });
}

export async function getVacation(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("vacations", "readonly");
    const req = tx.objectStore("vacations").get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllVacations() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("vacations", "readonly");
    const req = tx.objectStore("vacations").getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteVacation(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("vacations", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore("vacations").delete(id);
  });
}

export async function putBlob(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("blobs", "readwrite");
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
    tx.objectStore("blobs").put(record);
  });
}

export async function getBlob(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("blobs", "readonly");
    const req = tx.objectStore("blobs").get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteBlob(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("blobs", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore("blobs").delete(id);
  });
}
