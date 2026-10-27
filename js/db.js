const DB_NAME = "vacrecap";
const DB_VERSION = 6;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        resolve(req.result);
        queueMicrotask(() => void migrateResidualThumbBlobs());
      };
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        const tx = event.target.transaction;
        if (!db.objectStoreNames.contains("vacations")) {
          const store = db.createObjectStore("vacations", { keyPath: "id" });
          store.createIndex("startDate", "startDate", { unique: false });
          store.createIndex("endDate", "endDate", { unique: false });
        }
        if (!db.objectStoreNames.contains("blobs")) {
          db.createObjectStore("blobs", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("places")) {
          const places = db.createObjectStore("places", { keyPath: "id" });
          places.createIndex("vacationDay", ["vacationId", "dayDate"], {
            unique: false,
          });
          places.createIndex("vacationId", "vacationId", { unique: false });
        }
        if (!db.objectStoreNames.contains("media")) {
          const media = db.createObjectStore("media", { keyPath: "id" });
          media.createIndex("placeId", "placeId", { unique: false });
          media.createIndex("vacationId", "vacationId", { unique: false });
          media.createIndex("vacationSourceKey", ["vacationId", "sourceKey"], {
            unique: false,
          });
        }
        if (!db.objectStoreNames.contains("notes")) {
          const notes = db.createObjectStore("notes", { keyPath: "id" });
          notes.createIndex("placeId", "placeId", { unique: false });
          notes.createIndex("vacationId", "vacationId", { unique: false });
        }
        if (!db.objectStoreNames.contains("routeCache")) {
          db.createObjectStore("routeCache", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("thumbs")) {
          db.createObjectStore("thumbs", { keyPath: "mediaId" });
        }

        if (db.objectStoreNames.contains("media")) {
          const media = tx.objectStore("media");
          if (!media.indexNames.contains("vacationSourceKey")) {
            media.createIndex("vacationSourceKey", ["vacationId", "sourceKey"], {
              unique: false,
            });
          }
        }

        if (event.oldVersion < 3 && db.objectStoreNames.contains("places")) {
          const store = tx.objectStore("places");
          store.openCursor().onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) return;
            const v = cursor.value;
            if (v.dayDate && !v.day) {
              v.day = v.dayDate;
            }
            if (!v.ts) v.ts = v.createdAt ?? Date.now();
            if (v.title && !v.name) v.name = v.title;
            cursor.update(v);
            cursor.continue();
          };
        }

        if (event.oldVersion < 6 && db.objectStoreNames.contains("media")) {
          const mediaStore = tx.objectStore("media");
          const thumbsStore = tx.objectStore("thumbs");
          mediaStore.openCursor().onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) return;
            const v = cursor.value;
            const thumbBlob = v.thumbBlob;
            if (thumbBlob && thumbBlob.size > 0) {
              thumbsStore.put({
                mediaId: v.id,
                mime: thumbBlob.type || "image/jpeg",
                blob: thumbBlob,
              });
            }
            cursor.continue();
          };
        }
      };
    });
  }
  return dbPromise;
}

async function migrateResidualThumbBlobs() {
  const { runWithMigrationRecovery } = await import("./migration-recovery.js");
  await runWithMigrationRecovery(async () => {
    const done = await getSetting("thumbs_blob_migrated_v7");
    if (done) return;
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["media", "thumbs"], "readwrite");
      const mediaStore = tx.objectStore("media");
      const thumbsStore = tx.objectStore("thumbs");
      mediaStore.openCursor().onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return;
        const v = cursor.value;
        const thumbBlob = v.thumbBlob;
        if (thumbBlob && thumbBlob.size > 0) {
          thumbsStore.put({
            mediaId: v.id,
            mime: thumbBlob.type || "image/jpeg",
            blob: thumbBlob,
          });
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await putSetting("thumbs_blob_migrated_v7", true);
  });
}

async function readThumbEntry(mediaId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("thumbs", "readonly");
    const req = tx.objectStore("thumbs").get(mediaId);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveMediaThumb(mediaId, blob) {
  if (!mediaId || !blob) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("thumbs", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore("thumbs").put({
      mediaId,
      mime: blob.type || "image/jpeg",
      blob,
    });
  });
}

export async function deleteMediaThumb(mediaId) {
  if (!mediaId) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("thumbs", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore("thumbs").delete(mediaId);
  });
}

export async function clearAllMediaThumbs() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("thumbs", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore("thumbs").clear();
  });
  await clearAllThumbFailureFlags();
}

export async function clearAllThumbFailureFlags() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("media", "readwrite");
    const store = tx.objectStore("media");
    store.openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      const v = cursor.value;
      if (v.thumbFailed) {
        const copy = { ...v };
        delete copy.thumbFailed;
        const req = cursor.update(copy);
        req.onsuccess = () => cursor.continue();
        req.onerror = () => cursor.continue();
      } else {
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function attachThumbInPlace(record) {
  if (!record?.id) return record;
  const entry = await readThumbEntry(record.id);
  if (entry?.blob instanceof Blob) {
    record.thumbBlob = entry.blob;
  } else if (entry?.data) {
    record.thumbBlob = new Blob([entry.data], { type: entry.mime || "image/jpeg" });
  }
  return record;
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

export async function getSetting(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readonly");
    const req = tx.objectStore("settings").get(key);
    req.onsuccess = () => resolve(req.result?.value);
    req.onerror = () => reject(req.error);
  });
}

export async function putSetting(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore("settings").put({ key, value });
  });
}

export async function getRouteCacheRecord(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("routeCache", "readonly");
    const req = tx.objectStore("routeCache").get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function putRouteCacheRecord(entry) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("routeCache", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore("routeCache").put(entry);
  });
}

export async function getPlacesForVacation(vacationId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("places", "readonly");
    const store = tx.objectStore("places");
    let req;
    try {
      req = store.index("vacationId").getAll(vacationId);
    } catch {
      req = store.getAll();
    }
    req.onsuccess = () => {
      const all = req.result ?? [];
      resolve(all.filter((p) => p.vacationId === vacationId));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getPlacesForDay(vacationId, dayDate) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("places", "readonly");
    const store = tx.objectStore("places");
    let req;
    try {
      const index = store.index("vacationDay");
      req = index.getAll([vacationId, dayDate]);
    } catch {
      req = store.getAll();
    }
    req.onsuccess = () => {
      const all = req.result ?? [];
      resolve(
        all.filter(
          (p) =>
            p.vacationId === vacationId &&
            (p.day === dayDate || p.dayDate === dayDate)
        )
      );
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getPlace(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("places", "readonly");
    const req = tx.objectStore("places").get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function deletePlace(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("places", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore("places").delete(id);
  });
}

export async function putMedia(record) {
  const thumbBlob = record.thumbBlob;
  const toStore = { ...record };
  delete toStore.thumbBlob;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("media", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    const store = tx.objectStore("media");
    if (toStore.id && toStore.blob === undefined && thumbBlob === undefined) {
      store.get(toStore.id).onsuccess = (e) => {
        const existing = e.target.result;
        const merged = existing ? { ...existing, ...toStore } : toStore;
        delete merged.thumbBlob;
        store.put(merged);
      };
    } else {
      store.put(toStore);
    }
  });
  if (thumbBlob !== undefined) {
    if (thumbBlob && thumbBlob.size > 0) await saveMediaThumb(record.id, thumbBlob);
    else await deleteMediaThumb(record.id);
  }
  return record;
}

export async function getMedia(id) {
  const db = await openDb();
  const record = await new Promise((resolve, reject) => {
    const tx = db.transaction("media", "readonly");
    const req = tx.objectStore("media").get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
  if (!record) return null;
  return attachThumbInPlace(record);
}

export async function deleteMedia(id) {
  await deleteMediaThumb(id);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("media", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore("media").delete(id);
  });
}

export async function putNote(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("notes", "readwrite");
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
    tx.objectStore("notes").put(record);
  });
}

export async function deleteNote(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("notes", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore("notes").delete(id);
  });
}

async function deleteByIndex(storeName, indexName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const req = store.index(indexName).openCursor(IDBKeyRange.only(key));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteMediaForPlace(placeId) {
  await deleteByIndex("media", "placeId", placeId);
}

export async function deleteNotesForPlace(placeId) {
  await deleteByIndex("notes", "placeId", placeId);
}

export async function deleteMediaForVacation(vacationId) {
  await deleteByIndex("media", "vacationId", vacationId);
}

export async function deleteNotesForVacation(vacationId) {
  await deleteByIndex("notes", "vacationId", vacationId);
}

export async function deletePlaceCascade(placeId) {
  await deleteMediaForPlace(placeId);
  await deleteNotesForPlace(placeId);
  await deletePlace(placeId);
}

export async function deleteVacationData(vacationId) {
  await deleteMediaForVacation(vacationId);
  await deleteNotesForVacation(vacationId);
  await deletePlacesForVacation(vacationId);
}

export async function getMediaBySourceKey(vacationId, sourceKey) {
  if (!sourceKey) return null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("media", "readonly");
    const store = tx.objectStore("media");
    let req;
    try {
      req = store.index("vacationSourceKey").get([vacationId, sourceKey]);
    } catch {
      req = store.getAll();
    }
    req.onsuccess = () => {
      const val = req.result;
      if (val && !Array.isArray(val)) {
        resolve(val);
        return;
      }
      const all = val ?? [];
      resolve(all.find((m) => m.vacationId === vacationId && m.sourceKey === sourceKey) ?? null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getAllMediaForVacation(vacationId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("media", "readonly");
    const store = tx.objectStore("media");
    let req;
    try {
      req = store.index("vacationId").getAll(vacationId);
    } catch {
      req = store.getAll();
    }
    req.onsuccess = () => {
      const all = req.result ?? [];
      resolve(all.filter((m) => m.vacationId === vacationId));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getMediaForPlace(placeId) {
  const db = await openDb();
  const ids = await new Promise((resolve, reject) => {
    const tx = db.transaction("media", "readonly");
    const store = tx.objectStore("media");
    let req;
    try {
      req = store.index("placeId").getAllKeys(placeId);
    } catch {
      req = store.getAllKeys();
    }
    req.onsuccess = () => {
      const keys = req.result ?? [];
      if (keys.length && typeof keys[0] === "object") {
        resolve([]);
        return;
      }
      resolve(keys);
    };
    req.onerror = () => reject(req.error);
  });
  if (!ids.length) return [];
  const records = await Promise.all(ids.map((id) => getMedia(id)));
  return records.filter(Boolean);
}

export async function getNotesForPlace(placeId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("notes", "readonly");
    const store = tx.objectStore("notes");
    let req;
    try {
      req = store.index("placeId").getAll(placeId);
    } catch {
      req = store.getAll();
    }
    req.onsuccess = () => {
      const all = req.result ?? [];
      resolve(
        all
          .filter((n) => n.placeId === placeId)
          .sort((a, b) => (b.ts ?? b.createdAt ?? 0) - (a.ts ?? a.createdAt ?? 0))
      );
    };
    req.onerror = () => reject(req.error);
  });
}

export async function putPlace(place) {
  const day = place.day || place.dayDate;
  const record = {
    ...place,
    day,
    dayDate: day,
    name: place.name ?? place.title ?? "",
    title: place.name ?? place.title ?? "",
  };
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("places", "readwrite");
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
    tx.objectStore("places").put(record);
  });
}

export async function deletePlacesForVacation(vacationId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("places", "readwrite");
    const store = tx.objectStore("places");
    const index = store.index("vacationId");
    const req = index.openCursor(IDBKeyRange.only(vacationId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
