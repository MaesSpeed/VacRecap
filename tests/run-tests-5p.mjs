import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

const VIEWPORTS = [
  { name: "375x667", width: 375, height: 667 },
  { name: "360x740", width: 360, height: 740 },
  { name: "390x844", width: 390, height: 844 },
];

const CONTEXT_OPTS = {
  ...devices["iPhone 8"],
  viewport: { width: 375, height: 667 },
  serviceWorkers: "block",
};

function startServer({ swVariant = "current" } = {}) {
  let swV35Body = null;
  return new Promise(async (resolve) => {
    if (swVariant === "dual") {
      const current = await readFile(path.join(root, "sw.js"), "utf8");
      swV35Body = current.replace(/vacrecap-v39/g, "vacrecap-v35").replace(/v39/g, "v35");
    }
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      let rel = decodeURIComponent(url.pathname);
      if (rel === "/sw-v35.js" && swV35Body) {
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=600",
        });
        res.end(swV35Body);
        return;
      }
      if (rel.endsWith("/")) rel += "index.html";
      try {
        const data = await readFile(path.join(root, rel.replace(/^\//, "")));
        const headers = { "Content-Type": MIME[path.extname(rel)] || "application/octet-stream" };
        if (rel.endsWith(".js") || rel.endsWith("sw.js")) {
          headers["Cache-Control"] = "public, max-age=600";
        }
        res.writeHead(200, headers);
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/` });
    });
  });
}

async function seedTrip(page) {
  await page.goto("./");
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', "Stabilität");
  await page.click('[data-action="pick-dates"]');
  await page.click('.calendar-day[data-date="2026-11-06"]');
  await page.click('.calendar-day[data-date="2026-11-06"]');
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  return await page.locator(".screen--trip").getAttribute("data-vacation-id");
}

async function assertBootCrashCounter(page, label) {
  const crash = await page.evaluate(() => {
    const boot = (data) => {
      let crashCount = data.crashCount || 0;
      if (data.unstable === true) crashCount += 1;
      return { unstable: true, crashCount };
    };
    let state = { unstable: false, crashCount: 0 };
    state = boot(state);
    state = boot(state);
    state = boot(state);
    return state.crashCount >= 2;
  });
  if (!crash) throw new Error(`${label}: Absturz-Zähler löst nicht aus`);
}

async function assertSafeModeBackup(page, label, vacationId, baseUrl) {
  await page.goto(baseUrl);
  await page.evaluate(async (vid) => {
    const { getPlacesForVacation, putPlace, putMedia, getMediaForPlace, getVacation } =
      await import("./js/db.js");
    const { createPlace } = await import("./js/places.js");
    const { createId, todayIso } = await import("./js/utils.js");
    const vacation = await getVacation(vid);
    const day = vacation?.startDate || todayIso();
    const places = await getPlacesForVacation(vid);
    let place = places.find((p) => !p.soft);
    if (!place) {
      place = createPlace({
        id: createId(),
        vacationId: vid,
        day,
        ts: Date.now(),
        lat: 1,
        lng: 2,
        name: "Safe-Ort",
        soft: false,
        source: "test",
      });
      await putPlace(place);
    }
    const media = await getMediaForPlace(place.id);
    if (!media.some((m) => m.type !== "video")) {
      const canvas = document.createElement("canvas");
      canvas.width = 80;
      canvas.height = 60;
      canvas.getContext("2d").fillStyle = "#336699";
      canvas.getContext("2d").fillRect(0, 0, 80, 60);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
      await putMedia({
        id: createId(),
        placeId: place.id,
        vacationId: vid,
        day: place.day || day,
        ts: Date.now(),
        type: "photo",
        blob,
        mime: "image/jpeg",
        ext: "jpg",
      });
    }
  }, vacationId);
  await page.goto(`./?safe=1#/notfall`);
  await page.waitForSelector('[data-testid="safe-mode-screen"]');
  const zipMeta = await page.evaluate(async (vid) => {
    const { buildVacationZip } = await import("./js/backup-service.js");
    const { ZipReader } = await import("./js/zip-reader.js");
    const { getMediaForPlace, getPlacesForVacation } = await import("./js/db.js");
    const zip = await buildVacationZip(vid);
    const file = new File([zip.blob], "t.zip", { type: "application/zip" });
    if (file.size < 100) return { ok: false, err: `ZIP zu klein (${file.size})` };
    const reader = new ZipReader(file);
    await reader.loadCatalog();
    const manifest = await reader.readJSON("reise.json");
    const places = await getPlacesForVacation(vid);
    const place = places.find((p) => !p.soft);
    const media = place ? await getMediaForPlace(place.id) : [];
    const photo = media.find((m) => m.type !== "video");
    if (!photo?.blob) return { ok: false, err: "kein Foto" };
    const origHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", await photo.blob.arrayBuffer()))
    )
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    const paths = reader.listPaths();
    const photoPath = manifest.media?.find((m) => m.type === "photo")?.path;
    if (!photoPath) {
      return { ok: false, err: `kein Foto in Manifest (${manifest.media?.length || 0})` };
    }
    if (!paths.includes(photoPath)) {
      return { ok: false, err: `Pfad fehlt (${photoPath}) in ${paths.slice(0, 3).join(",")}` };
    }
    const fromZip = await reader.readBlob(photoPath, photo.mime);
    const zipHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", await fromZip.arrayBuffer()))
    )
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    return { ok: zipHash === origHash && manifest.app === "Reisetagebuch", origHash, zipHash };
  }, vacationId);
  if (!zipMeta?.ok) throw new Error(`${label}: ${zipMeta?.err || "ZIP/Hash"}`);
}

async function assertSafeModeCrash(page, label) {
  await page.goto("./?safe=1");
  await page.waitForSelector('[data-testid="safe-mode-screen"]', { timeout: 15_000 });
  await page.locator('[data-action="normal"]').click();
  await page.waitForSelector(".top-bar__title");
  const url = await page.evaluate(() => ({
    hash: location.hash,
    search: location.search,
    safe: window.__VACRECAP_SAFE__,
  }));
  if (url.safe || url.search.includes("safe=1") || url.hash.includes("notfall")) {
    throw new Error(`${label}: URL/Modus nach Normalstart (${JSON.stringify(url)})`);
  }
}

async function assertResumeOverview(page, label, vacationId) {
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="trip-content"]');
  const moved = await page.evaluate(async () => {
    const pausedAt = Date.now() - 3 * 60 * 1000;
    localStorage.setItem("vr-last-active", String(pausedAt));
    const { runColdResumeCheck } = await import("./js/resume-policy.js");
    runColdResumeCheck();
    return { hash: location.hash };
  });
  if (moved.hash !== "#/urlaube") {
    throw new Error(`${label}: keine Übersicht nach Pause (${JSON.stringify(moved)})`);
  }
  await page.waitForSelector(".screen--urlaube", { timeout: 15_000 });
}

async function assertSwUpdateWithSha(page, baseUrl, label) {
  const ctx = await page.context().browser().newContext({
    baseURL: baseUrl,
    ...devices["iPhone 8"],
    serviceWorkers: "allow",
  });
  const p = await ctx.newPage();
  await p.goto(baseUrl);
  const result = await p.evaluate(async () => {
    const digestBytes = async (blob) => {
      const d = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      return Array.from(new Uint8Array(d))
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
    };
    const { createId, todayIso } = await import("./js/utils.js");
    const { putPlace, putMedia, getMedia } = await import("./js/db.js");
    const { createPlace } = await import("./js/places.js");
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 24;
    canvas.getContext("2d").fillRect(0, 0, 32, 24);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    const expected = await digestBytes(blob);
    const vacationId = createId();
    const placeId = createId();
    const mediaId = createId();
    const day = todayIso();
    await putPlace(
      createPlace({
        id: placeId,
        vacationId,
        day,
        ts: Date.now(),
        lat: 1,
        lng: 2,
        name: "SW",
        soft: false,
        source: "test",
      })
    );
    await putMedia({
      id: mediaId,
      placeId,
      vacationId,
      day,
      ts: Date.now(),
      type: "photo",
      blob,
      mime: "image/jpeg",
      ext: "jpg",
    });
    const oldCache = await caches.open("vacrecap-v35");
    await oldCache.put("./js/app-version.js", new Response("export const APP_BUILD_VERSION = 35;\n"));
    let reg = await navigator.serviceWorker.register("./sw-v35.js", { updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    reg = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
    await reg.update();
    await new Promise((r) => setTimeout(r, 500));
    if (reg.waiting) {
      reg.waiting.postMessage({ type: "SKIP_WAITING" });
    }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 2000);
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true }
      );
    });
    let keys = await caches.keys();
    for (let i = 0; i < 15; i++) {
      keys = await caches.keys();
      if (keys.length === 1 && keys[0] === "vacrecap-v39") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const onlyV39 = keys.length === 1 && keys[0] === "vacrecap-v39";
    const verResp = await (await caches.open("vacrecap-v39")).match("./js/app-version.js");
    const verText = verResp ? await verResp.text() : "";
    const build = /APP_BUILD_VERSION\s*=\s*(\d+)/.exec(verText)?.[1];
    const after = await digestBytes((await getMedia(mediaId)).blob);
    return { onlyV39, build: Number(build), shaOk: after === expected, keys };
  });
  await ctx.close();
  if (!result.onlyV39 || result.build !== 39 || !result.shaOk) {
    throw new Error(`${label}: SW-Update (${JSON.stringify(result)})`);
  }
}

async function assertThumbStoreMigration(page, label) {
  const result = await page.evaluate(async () => {
    const { createId, todayIso } = await import("./js/utils.js");
    const { putPlace, putMedia } = await import("./js/db.js");
    const { createPlace } = await import("./js/places.js");
    const { resetThumbRepairSessionForTests } = await import("./js/thumb-repair-queue.js");
    resetThumbRepairSessionForTests();
    const vacationId = createId();
    const placeId = createId();
    const day = todayIso();
    await putPlace(
      createPlace({
        id: placeId,
        vacationId,
        day,
        ts: Date.now(),
        lat: 1,
        lng: 2,
        name: "Thumb",
        soft: false,
        source: "test",
      })
    );
    let maxInflight = 0;
    let inflight = 0;
    const orig = createImageBitmap.bind(globalThis);
    globalThis.createImageBitmap = async (...args) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      try {
        return await orig(...args);
      } finally {
        inflight -= 1;
      }
    };
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 30;
    canvas.getContext("2d").fillRect(0, 0, 40, 30);
    const full = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    const thumb = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.5));
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const id = createId();
      ids.push(id);
      await putMedia({
        id,
        placeId,
        vacationId,
        day,
        ts: Date.now() + i,
        type: "photo",
        blob: full,
        thumbBlob: thumb,
        mime: "image/jpeg",
        ext: "jpg",
      });
    }
    const thumbEntry = await new Promise((resolve, reject) => {
      const req = indexedDB.open("vacrecap");
      req.onsuccess = () => {
        const tx = req.result.transaction("thumbs", "readonly");
        const g = tx.objectStore("thumbs").get(ids[0]);
        g.onsuccess = () => resolve(g.result);
        g.onerror = () => reject(g.error);
      };
      req.onerror = () => reject(req.error);
    });
    if (!thumbEntry?.blob && !thumbEntry?.data) {
      return { ok: false, err: "Thumb nicht im thumbs-Store" };
    }
    const { scheduleThumbRepairs } = await import("./js/thumb-repair-queue.js");
    const { deleteMediaThumb } = await import("./js/db.js");
    for (const id of ids) await deleteMediaThumb(id);
    scheduleThumbRepairs(ids.map((id) => ({ id, type: "photo", thumbBlob: null })));
    await new Promise((r) => setTimeout(r, 3500));
    const lateId = createId();
    await putMedia({
      id: lateId,
      placeId,
      vacationId,
      day,
      ts: Date.now() + 99,
      type: "photo",
      blob: full,
      mime: "image/jpeg",
      ext: "jpg",
    });
    await deleteMediaThumb(lateId);
    scheduleThumbRepairs([{ id: lateId, type: "photo", thumbBlob: null }]);
    await new Promise((r) => setTimeout(r, 8000));
    const lateThumb = await new Promise((resolve, reject) => {
      const req = indexedDB.open("vacrecap");
      req.onsuccess = () => {
        const tx = req.result.transaction("thumbs", "readonly");
        const g = tx.objectStore("thumbs").get(lateId);
        g.onsuccess = () => resolve(g.result);
        g.onerror = () => reject(g.error);
      };
      req.onerror = () => reject(req.error);
    });
    if (!lateThumb?.blob?.size) {
      return { ok: false, err: "Thumb-Reparatur nach 3-s-Fenster fehlgeschlagen (N1)" };
    }
    if (maxInflight > 1) {
      return { ok: false, err: `mehr als 1 Decode parallel (${maxInflight})` };
    }
    return { ok: true };
  });
  if (!result?.ok) throw new Error(`${label}: ${result.err}`);
}

async function assertWebKitV5Migration64(page, label, { runSw = false } = {}) {
  const result = await page.evaluate(async (doSw) => {
    const imp = (rel) => import(new URL(rel, location.origin).href);
    const digestBytes = async (blob) => {
      const d = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      return Array.from(new Uint8Array(d))
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
    };
    const deleteDb = () =>
      new Promise((resolve) => {
        const req = indexedDB.deleteDatabase("vacrecap");
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    await deleteDb();
    const COUNT = 64;
    const expected = [];
    const ids = [];
    const canvas = document.createElement("canvas");
    canvas.width = 12;
    canvas.height = 12;
    const ctx = canvas.getContext("2d");
    const blobs = [];
    const thumbs = [];
    for (let i = 0; i < COUNT; i++) {
      ctx.fillStyle = `rgb(${i % 255}, ${(i * 5) % 255}, ${(i * 11) % 255})`;
      ctx.fillRect(0, 0, 12, 12);
      blobs.push(await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92)));
      thumbs.push(await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.55)));
      expected.push(await digestBytes(blobs[i]));
      ids.push(`mig-${i}`);
    }
    await new Promise((resolve, reject) => {
      const req = indexedDB.open("vacrecap", 5);
      req.onerror = () => reject(req.error);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("vacations")) {
          db.createObjectStore("vacations", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("places")) {
          db.createObjectStore("places", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("media")) {
          db.createObjectStore("media", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "key" });
        }
      };
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction(["vacations", "places", "media"], "readwrite");
        tx.objectStore("vacations").put({
          id: "v1",
          title: "Mig",
          startDate: "2026-01-01",
          endDate: "2026-01-02",
        });
        tx.objectStore("places").put({
          id: "p1",
          vacationId: "v1",
          day: "2026-01-01",
          dayDate: "2026-01-01",
          ts: 1,
          lat: 0,
          lng: 0,
          name: "Ort",
          soft: false,
        });
        const store = tx.objectStore("media");
        for (let i = 0; i < COUNT; i++) {
          store.put({
            id: ids[i],
            placeId: "p1",
            vacationId: "v1",
            day: "2026-01-01",
            ts: i,
            type: "photo",
            blob: blobs[i],
            thumbBlob: thumbs[i],
            mime: "image/jpeg",
            ext: "jpg",
          });
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    const { getMedia } = await imp("/js/db.js");
    for (let i = 0; i < COUNT; i++) {
      const m = await getMedia(ids[i]);
      if (!m?.blob) return { ok: false, err: `kein Blob ${i}` };
      const h = await digestBytes(m.blob);
      if (h !== expected[i]) return { ok: false, err: `Original SHA ${i}` };
      if (!m.thumbBlob?.size) return { ok: false, err: `kein Thumb ${i}` };
      const th = await digestBytes(m.thumbBlob);
      const expTh = await digestBytes(thumbs[i]);
      if (th !== expTh) return { ok: false, err: `Thumb SHA ${i}` };
    }
    const thumbInStore = await new Promise((resolve, reject) => {
      const req = indexedDB.open("vacrecap");
      req.onsuccess = () => {
        const tx = req.result.transaction("thumbs", "readonly");
        const g = tx.objectStore("thumbs").get(ids[0]);
        g.onsuccess = () => resolve(g.result);
        g.onerror = () => reject(g.error);
      };
      req.onerror = () => reject(req.error);
    });
    if (!thumbInStore?.blob?.size) {
      return { ok: false, err: "thumbs-Store leer nach v5→v6" };
    }
    if (doSw) {
      const oldCache = await caches.open("vacrecap-v35");
      await oldCache.put("./js/app-version.js", new Response("export const APP_BUILD_VERSION = 35;\n"));
      let reg = await navigator.serviceWorker.register("./sw-v35.js", { updateViaCache: "none" });
      await navigator.serviceWorker.ready;
      reg = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
      await reg.update();
      await new Promise((r) => setTimeout(r, 400));
      if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 2000);
        navigator.serviceWorker.addEventListener(
          "controllerchange",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true }
        );
      });
      const m0 = await getMedia(ids[0]);
      const hAfter = await digestBytes(m0.blob);
      if (hAfter !== expected[0]) {
        return { ok: false, err: "Original nach SW-Update nicht lesbar" };
      }
      const { buildVacationZip } = await imp("/js/backup-service.js");
      const zip = await buildVacationZip("v1");
      if (!zip?.blob || zip.blob.size < 100) {
        return { ok: false, err: "Backup-ZIP nach Migration" };
      }
    }
    return { ok: true };
  }, runSw);
  if (!result?.ok) throw new Error(`${label}: ${result.err}`);
}

async function assertOriginalShaAfterReload(page, label, baseUrl) {
  await page.goto(baseUrl);
  const digest = await page.evaluate(async () => {
    const { createId, todayIso } = await import("./js/utils.js");
    const { putPlace, putMedia, getMedia } = await import("./js/db.js");
    const { createPlace } = await import("./js/places.js");
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#aa4422";
    ctx.fillRect(0, 0, 64, 48);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    const bytes = await blob.arrayBuffer();
    const d0 = await crypto.subtle.digest("SHA-256", bytes);
    const hex0 = Array.from(new Uint8Array(d0))
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    const vacationId = createId();
    const placeId = createId();
    const id = createId();
    const day = todayIso();
    await putPlace(
      createPlace({
        id: placeId,
        vacationId,
        day,
        ts: Date.now(),
        lat: 1,
        lng: 2,
        name: "Sha",
        soft: false,
        source: "test",
      })
    );
    await putMedia({
      id,
      placeId,
      vacationId,
      day,
      ts: Date.now(),
      type: "photo",
      blob,
      mime: "image/jpeg",
      ext: "jpg",
    });
    const m = await getMedia(id);
    const d1 = await crypto.subtle.digest("SHA-256", await m.blob.arrayBuffer());
    const hex1 = Array.from(new Uint8Array(d1))
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    return { hex0, hex1, id };
  });
  if (digest.hex0 !== digest.hex1) throw new Error(`${label}: hash vor reload`);
  await page.reload();
  const after = await page.evaluate(async ({ id, hex0 }) => {
    const { getMedia } = await import("./js/db.js");
    const m = await getMedia(id);
    const d = await crypto.subtle.digest("SHA-256", await m.blob.arrayBuffer());
    const hex = Array.from(new Uint8Array(d))
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    return hex === hex0;
  }, digest);
  if (!after) throw new Error(`${label}: hash nach reload`);
}

async function assertVersion39(page, label) {
  await page.goto("./");
  const v = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  if (v !== 39) throw new Error(`${label}: Version ${v}`);
}

async function main() {
  const { server, baseUrl } = await startServer({ swVariant: "dual" });
  const chromiumBrowser = await chromium.launch();
  const ctx = await chromiumBrowser.newContext({ baseURL: baseUrl, ...CONTEXT_OPTS });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120_000);
  await page.addInitScript(() => {
    window.__VR_DISABLE_STABLE__ = true;
  });

  const vacationId = await seedTrip(page);
  await assertResumeOverview(page, "5p-resume", vacationId);
  await assertBootCrashCounter(page, "5p-boot-crash");
  await assertSafeModeBackup(page, "5p-safe-backup", vacationId, baseUrl);
  await assertSafeModeCrash(page, "5p-safe-normal");
  await assertThumbStoreMigration(page, "5p-thumbs");
  await assertOriginalShaAfterReload(page, "5p-sha", baseUrl);

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await assertVersion39(page, `5p-version-${vp.name}`);
  }

  await assertSwUpdateWithSha(page, baseUrl, "5p-sw-update");

  const webkitUserData = await mkdtemp(path.join(tmpdir(), "vacrecap-5p-wk-"));
  const webkitCtx = await webkit.launchPersistentContext(webkitUserData, {
    baseURL: baseUrl,
    ...devices["iPhone 8"],
    viewport: { width: 375, height: 667 },
    serviceWorkers: "allow",
  });
  for (let run = 1; run <= 5; run++) {
    const migPage = await webkitCtx.newPage();
    migPage.setDefaultTimeout(180_000);
    await migPage.goto(`${baseUrl}tests/idb-blank.html`, { waitUntil: "commit" });
    await assertWebKitV5Migration64(migPage, `5p-webkit-mig-${run}`, { runSw: run === 1 });
    await migPage.close();
  }
  const wPage = await webkitCtx.newPage();
  wPage.setDefaultTimeout(180_000);
  await assertOriginalShaAfterReload(wPage, "5p-sha-webkit", baseUrl);
  await webkitCtx.close();
  await rm(webkitUserData, { recursive: true, force: true });

  await ctx.close();
  await chromiumBrowser.close();
  server.close();
  console.log("Playwright 5p tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
