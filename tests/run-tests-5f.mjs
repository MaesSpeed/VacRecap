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

async function makeJpeg(page, seed) {
  const bytes = await page.evaluate(async (s) => {
    const canvas = document.createElement("canvas");
    canvas.width = 80 + s;
    canvas.height = 60 + s;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = `hsl(${s * 40}, 70%, 50%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, seed);
  return Buffer.from(bytes);
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
  const vacationId = await page.locator(".screen--trip").getAttribute("data-vacation-id");
  await page.locator('[data-footer-action="pin"]').click();
  await page.waitForFunction(() => {
    const toast = document.querySelector('[data-testid="app-toast"]');
    return !toast || !toast.classList.contains("toast--visible");
  });
  return vacationId;
}

async function assertViewerUndoAboveViewer(page, label) {
  const jpeg = await makeJpeg(page, 1);
  for (let i = 0; i < 2; i++) {
    await page.locator('[data-testid="capture-photo-input"]').setInputFiles({
      name: `p${i}.jpg`,
      mimeType: "image/jpeg",
      buffer: jpeg,
    });
    await page.waitForTimeout(400);
  }
  const tiles = page.locator(".tile[data-media-id]");
  if ((await tiles.count()) < 2) {
    throw new Error(`${label}: braucht 2+ Fotos im Raster`);
  }
  await tiles.first().click();
  await page.waitForSelector('[data-testid="media-viewer"]');
  await page.click(".media-viewer__delete");
  await page.waitForSelector('[data-testid="confirm-delete-media"]');
  await page.locator(".overlay-confirm-layer--top [data-action='confirm']").click();
  await page.waitForSelector('[data-testid="app-toast"] [data-action="undo"]', { timeout: 10000 });
  const zToast = await page.evaluate(() => {
    const root = document.getElementById("toast-root");
    const viewer = document.querySelector('[data-testid="media-viewer"]');
    return {
      toastZ: root ? getComputedStyle(root).zIndex : null,
      viewerZ: viewer ? getComputedStyle(viewer.closest(".media-viewer")).zIndex : null,
    };
  });
  if (Number(zToast.toastZ) <= Number(zToast.viewerZ || 200)) {
    throw new Error(`${label}: Toast z-index nicht über Viewer (${JSON.stringify(zToast)})`);
  }
  const hitUndo = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="app-toast"] [data-action="undo"]');
    if (!btn) return { ok: false, reason: "kein Rückgängig" };
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    return { ok: top === btn || btn.contains(top), top: top?.tagName };
  });
  if (!hitUndo.ok) {
    throw new Error(`${label}: elementFromPoint trifft Rückgängig nicht (${hitUndo.reason ?? hitUndo.top})`);
  }
  const beforeCount = await tiles.count();
  await page.locator('[data-testid="app-toast"] [data-action="undo"]').click();
  await page.waitForFunction(
    (n) => document.querySelectorAll(".tile[data-media-id]").length >= n,
    beforeCount
  );
  await page.click('[data-testid="media-viewer-close"]');
  await page.waitForSelector('[data-testid="media-viewer"]', { state: "hidden" });
}

async function assertGpsPrefetchAfterCancel(page, label, vacationId) {
  await page.context().setGeolocation({ latitude: 48.8566, longitude: 2.3522 });
  const chooser1 = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
  await page.locator('[data-footer-action="camera"]').click();
  const ch1 = await chooser1;
  if (ch1) await ch1.setFiles([]);
  else {
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="capture-photo-input"]');
      input?.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  await page.context().setGeolocation({ latitude: 52.52, longitude: 13.405 });
  const jpeg = await makeJpeg(page, 9);
  const chooser2 = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
  await page.locator('[data-footer-action="camera"]').click();
  const ch2 = await chooser2;
  const file = { name: "berlin.jpg", mimeType: "image/jpeg", buffer: jpeg };
  if (ch2) await ch2.setFiles(file);
  else await page.locator('[data-testid="capture-photo-input"]').setInputFiles(file);
  await page.waitForFunction(
    async ({ vid, lat, lng }) => {
      const { getAllMediaForVacation, getPlacesForDay } = await import("./js/db.js");
      const { haversineMeters } = await import("./js/geo.js");
      const all = await getAllMediaForVacation(vid);
      const sorted = all.sort((a, b) => a.ts - b.ts);
      const last = sorted[sorted.length - 1];
      if (!last?.placeId) return false;
      const places = await getPlacesForDay(vid, last.day);
      const place = places.find((p) => p.id === last.placeId);
      if (!place?.lat) return false;
      return haversineMeters(lat, lng, place.lat, place.lng) < 200;
    },
    { vid: vacationId, lat: 52.52, lng: 13.405 },
    { timeout: 20000 }
  );
}

async function assertMapFromTripAfterDelay(page, label, vacationId) {
  await page.route("**/routing.openstreetmap.de/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"routes":[]}' })
  );
  await page.evaluate(async () => {
    const { setMapRoutesEnabled } = await import("./js/settings-store.js");
    await setMapRoutesEnabled(false);
  });
  await page.click('[data-action="map"]');
  await page.waitForSelector('[data-testid="map-screen"]');
  await page.waitForTimeout(15_000);
  await page.click('[data-testid="map-screen"] [data-action="back"]');
  await page.waitForFunction((vid) => location.hash === `#/urlaub/${vid}`, vacationId);
  await page.locator('.link-btn--back[data-action="back"]').click();
  await page.waitForFunction(() => location.hash.includes("/urlaube"), null, { timeout: 10000 });
  const title = await page.locator(".top-bar__title").textContent();
  if (title?.trim() !== "Reisen") {
    throw new Error(`${label}: nach 15s Karte nicht 1× ‹ Reisen zur Übersicht (${title})`);
  }
}

async function assertMapFooterNoteFromTrip(page, label, vacationId) {
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.click('[data-action="map"]');
  await page.waitForSelector('[data-testid="map-screen"]');
  await page.waitForTimeout(15_000);
  await page.locator('[data-testid="map-screen"] [data-footer-action="note"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.click('[data-action="cancel"]');
  await page.waitForFunction((vid) => location.hash === `#/urlaub/${vid}`, vacationId);
}

async function assertNoGpsWarnToast(page, label, vacationId) {
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.evaluate(async () => {
    navigator.geolocation.getCurrentPosition = (_ok, err) => {
      err?.({ code: 1, PERMISSION_DENIED: 1, message: "denied" });
    };
    const { resetCapturePositionCache } = await import("./js/geo.js");
    const { resetCaptureGpsPrefetch } = await import("./js/capture-gps-prefetch.js");
    resetCapturePositionCache();
    resetCaptureGpsPrefetch();
  });
  const placeIds = await page.evaluate(async (vid) => {
    const { getPlacesForDay } = await import("./js/db.js");
    const { todayIso } = await import("./js/utils.js");
    return (await getPlacesForDay(vid, todayIso()))
      .filter((p) => !p.soft)
      .sort((a, b) => a.ts - b.ts)
      .map((p) => p.id);
  }, vacationId);
  if (placeIds.length >= 2) {
    await page.locator(`[data-place-id="${placeIds[0]}"]`).click();
    await page.locator(`[data-place-id="${placeIds[1]}"]`).click();
  }
  const jpeg = await makeJpeg(page, 11);
  const chooser = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
  await page.locator('[data-footer-action="camera"]').click();
  const ch = await chooser;
  const file = { name: "nogps.jpg", mimeType: "image/jpeg", buffer: jpeg };
  if (ch) await ch.setFiles(file);
  else await page.locator('[data-testid="capture-photo-input"]').setInputFiles(file);
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="app-toast"]')?.textContent ?? "";
    return t.includes("Kein GPS");
  });
}

async function assertVideoHintAfterFirstFooterPhoto(page, label) {
  await page.evaluate(() => localStorage.removeItem("vacrecap-video-longpress-hint"));
  const jpeg = await makeJpeg(page, 5);
  const file = { name: "hint.jpg", mimeType: "image/jpeg", buffer: jpeg };
  const chooser = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
  await page.locator('[data-footer-action="camera"]').click();
  const ch = await chooser;
  if (ch) await ch.setFiles(file);
  else await page.locator('[data-testid="capture-photo-input"]').setInputFiles(file);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="app-toast"]')?.textContent?.includes("Lange drücken = Video"),
    null,
    { timeout: 5000 }
  );
  const noIcon = await page.evaluate(() =>
    document.querySelector('[data-testid="app-toast"]')?.classList.contains("toast--no-icon")
  );
  if (!noIcon) {
    throw new Error(`${label}: Video-Hinweis soll ohne Haken-Icon sein`);
  }
}

async function main() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    baseURL: baseUrl,
    ...devices["iPhone 8"],
    viewport: { width: 375, height: 667 },
    geolocation: { latitude: 48.8566, longitude: 2.3522 },
    permissions: ["geolocation"],
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);

  const vacationId = await seedTrip(page);
  await assertViewerUndoAboveViewer(page, "B10-1");
  await assertVideoHintAfterFirstFooterPhoto(page, "B10-4");
  await assertGpsPrefetchAfterCancel(page, "B10-2", vacationId);
  await assertMapFromTripAfterDelay(page, "B10-3", vacationId);
  await assertMapFooterNoteFromTrip(page, "B10-3-note", vacationId);
  await assertNoGpsWarnToast(page, "B10-5", vacationId);

  await ctx.close();
  await browser.close();
  server.close();
  console.log("Playwright 5f tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
