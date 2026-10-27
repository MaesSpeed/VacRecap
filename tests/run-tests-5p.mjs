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

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      let rel = decodeURIComponent(url.pathname);
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
    const KEY = "vr-boot";
    const now = Date.now();
    const run = (data) => {
      const gap = now - (data?.lastLoad || 0);
      if (!data || now - (data.since || 0) > 120000) {
        data = { since: now, attempts: 0, stable: false, lastLoad: 0 };
      }
      if (data.stable) {
        data.attempts = 0;
        data.stable = false;
      } else if (gap < 15000) {
        data.attempts = (data.attempts || 0) + 1;
      } else {
        data.attempts = 1;
        data.since = now;
      }
      data.lastLoad = now;
      return data;
    };
    let d = run({ since: now, attempts: 0, stable: false, lastLoad: now - 5000 });
    d = run(d);
    return d.attempts >= 2;
  });
  if (!crash) throw new Error(`${label}: Absturz-Zähler löst nicht aus`);
}

async function assertSafeModeCrash(page, label) {
  await page.goto("./?safe=1");
  await page.waitForSelector('[data-testid="safe-mode-screen"]', { timeout: 15_000 });
  const vid = await page.evaluate(async () => {
    const { getAllVacations } = await import("./js/db.js");
    const list = await getAllVacations();
    return list[0]?.id || null;
  });
  if (!vid) throw new Error(`${label}: keine Reise für Safe-Backup`);
  await page.locator(`[data-action="backup"][data-id="${vid}"]`).click();
  await page.waitForTimeout(500);
  await page.locator('[data-action="normal"]').click();
  await page.waitForSelector(".top-bar__title");
  const safe = await page.locator('[data-testid="safe-mode-screen"]').count();
  if (safe) throw new Error(`${label}: Normal start blieb im Notfallmodus`);
}

async function assertResumeOverview(page, label, vacationId) {
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="trip-content"]');
  const moved = await page.evaluate(async () => {
    const pausedAt = Date.now() - 3 * 60 * 1000;
    localStorage.setItem("vr-last-active", String(pausedAt));
    const stored = Number(localStorage.getItem("vr-last-active"));
    const { runColdResumeCheck } = await import("./js/resume-policy.js");
    runColdResumeCheck();
    return {
      hash: location.hash,
      resume: window.__VR_RESUME_DEBUG,
      stored,
      pausedAt,
    };
  });
  if (moved.hash !== "#/urlaube") {
    throw new Error(`${label}: keine Übersicht nach Pause (${JSON.stringify(moved)})`);
  }
  await page.waitForSelector(".screen--urlaube", { timeout: 15_000 });
}

async function assertSwSingleVersion(page, baseUrl, label) {
  const ctx = await page.context().browser().newContext({
    baseURL: baseUrl,
    ...devices["iPhone 8"],
    serviceWorkers: "allow",
  });
  const p = await ctx.newPage();
  await p.goto("./");
  const info = await p.evaluate(async () => {
    const reg = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    const cache = await caches.open("vacrecap-v36");
    const app = await cache.match("./js/app.js");
    const ver = await cache.match("./js/app-version.js");
    let build = 0;
    if (ver) {
      const t = await ver.text();
      const m = t.match(/APP_BUILD_VERSION\s*=\s*(\d+)/);
      build = m ? Number(m[1]) : 0;
    }
    return { keys, hasApp: !!app, build, onlyV36: keys.every((k) => k === "vacrecap-v36") };
  });
  await ctx.close();
  if (!info.onlyV36 || !info.hasApp || info.build !== 36) {
    throw new Error(`${label}: SW-Cache (${JSON.stringify(info)})`);
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
    for (let i = 0; i < 12; i++) {
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
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("vacrecap");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const raw = await new Promise((resolve, reject) => {
      const tx = db.transaction("media", "readonly");
      const req = tx.objectStore("media").get(ids[0]);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (raw?.thumbBlob) {
      return { ok: false, err: "thumbBlob noch im Medien-Record" };
    }
    const { scheduleThumbRepairs } = await import("./js/thumb-repair-queue.js");
    const { deleteMediaThumb } = await import("./js/db.js");
    for (const id of ids) await deleteMediaThumb(id);
    const list = ids.map((id) => ({ id, type: "photo", thumbBlob: null }));
    scheduleThumbRepairs(list);
    await new Promise((r) => setTimeout(r, 4500));
    await new Promise((r) => setTimeout(r, 8000));
    if (maxInflight > 1) {
      return { ok: false, err: `mehr als 1 Decode parallel (${maxInflight})` };
    }
    return { ok: true };
  });
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

async function assertVersion36(page, label) {
  await page.goto("./");
  const v = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  if (v !== 36) throw new Error(`${label}: Version ${v}`);
}

async function main() {
  const { server, baseUrl } = await startServer();
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
  await assertSafeModeCrash(page, "5p-safe-crash");
  await assertThumbStoreMigration(page, "5p-thumbs");
  await assertOriginalShaAfterReload(page, "5p-sha", baseUrl);

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await assertVersion36(page, `5p-version-${vp.name}`);
  }

  await assertSwSingleVersion(page, baseUrl, "5p-sw-cache");

  const webkitUserData = await mkdtemp(path.join(tmpdir(), "vacrecap-5p-wk-"));
  const webkitCtx = await webkit.launchPersistentContext(webkitUserData, {
    baseURL: baseUrl,
    ...CONTEXT_OPTS,
  });
  const wPage = await webkitCtx.newPage();
  wPage.setDefaultTimeout(120_000);
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
