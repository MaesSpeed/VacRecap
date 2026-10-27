import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
};

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      try {
        const data = await readFile(path.join(root, rel.replace(/^\//, "")));
        res.writeHead(200, { "Content-Type": MIME[path.extname(rel)] || "application/octet-stream" });
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
  await page.fill('[name="title"]', "Paris");
  await page.click('[data-action="pick-dates"]');
  await page.click(".calendar-day--today");
  await page.click(".calendar-day--today");
  await page.click('button[data-action="apply"]');
  await page.click('[data-preset="stadt"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  return await page.locator(".screen--trip").getAttribute("data-vacation-id");
}

async function openSettings(page, vacationId) {
  await page.goto(`./#/urlaub/${vacationId}/einstellungen`);
  await page.waitForSelector('[data-testid="settings-screen"]');
}

async function assertVersionLine(page, label) {
  const line = await page.locator('[data-testid="app-version-line"]');
  await line.waitFor({ state: "visible" });
  const text = await line.innerText();
  const { APP_BUILD_VERSION } = await page.evaluate(async () => {
    const mod = await import("./js/app-version.js");
    return { APP_BUILD_VERSION: mod.APP_BUILD_VERSION };
  });
  if (!text.includes(`Version ${APP_BUILD_VERSION}`)) {
    throw new Error(`${label}: Versionszeile falsch (${text}, erwartet ${APP_BUILD_VERSION})`);
  }
  const style = await line.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { fontWeight: cs.fontWeight, opacity: cs.opacity };
  });
  if (Number(style.fontWeight) < 600) {
    throw new Error(`${label}: Version nicht gut sichtbar (font-weight ${style.fontWeight})`);
  }
}

async function assertInvalidStateRetry(page, label, vacationId) {
  const mediaId = await page.evaluate(async (vid) => {
    const { createPlace } = await import("./js/places.js");
    const { putPlace, putMedia } = await import("./js/db.js");
    const { todayIso, createId } = await import("./js/utils.js");
    const day = todayIso();
    const place = createPlace({
      vacationId: vid,
      day,
      ts: Date.now() - 1000,
      lat: 48.87,
      lng: 2.35,
      name: "Retry-Ort",
      soft: false,
      source: "test",
    });
    await putPlace(place);
    const id = createId();
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 60;
    canvas.getContext("2d").fillStyle = "#4488aa";
    canvas.getContext("2d").fillRect(0, 0, 80, 60);
    const full = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    await putMedia({
      id,
      placeId: place.id,
      vacationId: vid,
      day,
      ts: Date.now(),
      type: "photo",
      blob: full,
      thumbBlob: new Blob([1, 2, 3], { type: "image/jpeg" }),
      w: 80,
      h: 60,
    });
    return id;
  }, vacationId);

  const ok = await page.evaluate(async (mediaId) => {
    let bitmapCalls = 0;
    const orig = createImageBitmap.bind(globalThis);
    globalThis.createImageBitmap = async (...args) => {
      bitmapCalls += 1;
      if (bitmapCalls === 1) {
        throw new DOMException("Invalid state", "InvalidStateError");
      }
      return orig(...args);
    };
    const { deleteMediaThumb, getMedia } = await import("./js/db.js");
    const { resetThumbRepairSessionForTests } = await import("./js/thumb-repair-queue.js");
    const { clearAllThumbDecodeFailures } = await import("./js/thumb-decode-state.js");
    const { resetThumbForceRebuildSession } = await import("./js/ui-place-list.js");
    await deleteMediaThumb(mediaId);
    clearAllThumbDecodeFailures();
    resetThumbForceRebuildSession();
    resetThumbRepairSessionForTests();
    const { forceRebuildPhotoThumb } = await import("./js/ui-place-list.js");
    await forceRebuildPhotoThumb(mediaId);
    await new Promise((r) => setTimeout(r, 9000));
    const m = await getMedia(mediaId);
    const hasThumb = !!(m?.thumbBlob && m.thumbBlob.size > 20);
    return { hasThumb, bitmapCalls };
  }, mediaId);

  if (!ok.hasThumb) {
    throw new Error(`${label}: Rebuild nach Retry fehlgeschlagen`);
  }
  if (ok.bitmapCalls < 2) {
    throw new Error(`${label}: createImageBitmap nicht erneut versucht (${ok.bitmapCalls})`);
  }
}

async function assertNoPutOnFailure(page, label, vacationId) {
  const result = await page.evaluate(async (vid) => {
    const { createPlace } = await import("./js/places.js");
    const { putPlace, putMedia, getMedia } = await import("./js/db.js");
    const { todayIso, createId } = await import("./js/utils.js");
    const day = todayIso();
    const place = createPlace({
      vacationId: vid,
      day,
      ts: Date.now() - 1000,
      lat: 48.88,
      lng: 2.36,
      name: "No-Put",
      soft: false,
      source: "test",
    });
    await putPlace(place);
    const id = createId();
    const bad = new Blob([9, 9, 9], { type: "image/jpeg" });
    await putMedia({
      id,
      placeId: place.id,
      vacationId: vid,
      day,
      ts: Date.now(),
      type: "photo",
      blob: bad,
      thumbBlob: null,
      w: 0,
      h: 0,
    });
    const before = await getMedia(id);
    const beforeBytes = before?.blob ? await before.blob.arrayBuffer() : null;
    const beforeThumb = before?.thumbBlob;

    let putCalls = 0;
    const db = await import("./js/db.js");
    const origPut = db.putMedia;
    db.putMedia = async (...args) => {
      putCalls += 1;
      return origPut(...args);
    };

    globalThis.createImageBitmap = async () => {
      throw new DOMException("Invalid state", "InvalidStateError");
    };

    const { forceRebuildPhotoThumb } = await import("./js/ui-place-list.js");
    const rebuilt = await forceRebuildPhotoThumb(id);
    const after = await getMedia(id);
    const afterBytes = after?.blob ? await after.blob.arrayBuffer() : null;

    return {
      rebuilt,
      putCalls,
      sameBlob:
        beforeBytes &&
        afterBytes &&
        beforeBytes.byteLength === afterBytes.byteLength &&
        new Uint8Array(beforeBytes).every((b, i) => b === new Uint8Array(afterBytes)[i]),
      sameThumb: beforeThumb === after?.thumbBlob,
    };
  }, vacationId);

  if (result.rebuilt) {
    throw new Error(`${label}: erwarteter Fehlschlag war Erfolg`);
  }
  if (result.putCalls > 0) {
    throw new Error(`${label}: putMedia im Fehlerzweig (${result.putCalls})`);
  }
  if (!result.sameBlob || !result.sameThumb) {
    throw new Error(`${label}: Record wurde verändert`);
  }
}

async function main() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    baseURL: baseUrl,
    ...devices["iPhone 8"],
    viewport: { width: 375, height: 667 },
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);

  const vacationId = await seedTrip(page);
  await openSettings(page, vacationId);
  await assertVersionLine(page, "B17-version");

  await assertInvalidStateRetry(page, "B17-retry", vacationId);
  await assertNoPutOnFailure(page, "B17-no-put", vacationId);

  await ctx.close();
  await browser.close();
  server.close();
  console.log("Playwright 5m tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
