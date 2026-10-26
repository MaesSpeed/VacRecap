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

async function installThumbObservers(page) {
  await page.evaluate(() => {
    window.__thumbImgErrors = 0;
    window.__thumbImgCreates = 0;
    window.__listMutations = 0;
    document.addEventListener(
      "error",
      (e) => {
        if (e.target?.matches?.(".tile__img, .th__img")) window.__thumbImgErrors += 1;
      },
      true
    );
    const orig = document.createElement.bind(document);
    document.createElement = function (tag, ...rest) {
      const el = orig(tag, ...rest);
      if (tag === "img") window.__thumbImgCreates += 1;
      return el;
    };
    const list = document.querySelector('[data-testid="place-list"]');
    if (list) {
      new MutationObserver(() => {
        window.__listMutations += 1;
      }).observe(list, { subtree: true, childList: true });
    }
  });
}

async function assertCorruptThumbRebuilds(page, label, vacationId) {
  const { placeId, mediaId } = await page.evaluate(async (vid) => {
    const { createPlace } = await import("./js/places.js");
    const { putPlace, putMedia } = await import("./js/db.js");
    const { todayIso, createId } = await import("./js/utils.js");
    const day = todayIso();
    const place = createPlace({
      vacationId: vid,
      day,
      ts: Date.now() - 2000,
      lat: 48.87,
      lng: 2.35,
      name: "Rebuild-Ort",
      soft: false,
      source: "test",
    });
    await putPlace(place);
    const id = createId();
    const canvas = document.createElement("canvas");
    canvas.width = 100;
    canvas.height = 80;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#225588";
    ctx.fillRect(0, 0, 100, 80);
    const full = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92));
    await putMedia({
      id,
      placeId: place.id,
      vacationId: vid,
      day,
      ts: Date.now() - 1000,
      type: "photo",
      blob: full,
      thumbBlob: new Blob([9, 8, 7, 6, 5, 4, 3, 2, 1], { type: "image/jpeg" }),
      w: 100,
      h: 80,
    });
    return { placeId: place.id, mediaId: id };
  }, vacationId);

  await page.reload();
  await page.waitForSelector('[data-testid="place-list"]');
  await installThumbObservers(page);
  await page.locator(`[data-place-id="${placeId}"]`).click();
  await page.waitForSelector(`[data-place-id="${placeId}"].oc--selected`);
  await page.waitForFunction(
    (mediaId) => {
      const img = document.querySelector(`.tile__img[data-media-id="${mediaId}"]`);
      return img && img.complete && img.naturalWidth > 0;
    },
    mediaId,
    { timeout: 15000 }
  );
  await page.waitForTimeout(500);
  const stats = await page.evaluate(() => ({
    errors: window.__thumbImgErrors ?? 0,
    creates: window.__thumbImgCreates ?? 0,
    mut: window.__listMutations ?? 0,
  }));
  if (stats.errors > 4) {
    throw new Error(`${label}: zu viele img-Errors (${stats.errors})`);
  }
  if (stats.creates > 80) {
    throw new Error(`${label}: img-Neuerzeugungen ${stats.creates}`);
  }
  const rebuilds = await page.evaluate(async (mediaId) => {
    const { getMedia } = await import("./js/db.js");
    const m = await getMedia(mediaId);
    return m?.thumbBlob?.size ?? 0;
  }, mediaId);
  if (rebuilds < 200) {
    throw new Error(`${label}: Thumb nicht neu gebaut (${rebuilds} bytes)`);
  }
  const titleW = await page.locator(`[data-place-id="${placeId}"] .oc__title`).evaluate((el) => el.getBoundingClientRect().width);
  if (titleW < 40) {
    throw new Error(`${label}: Titel nicht antippbar/breit (${titleW})`);
  }
}

async function assertUnreadableOriginalStillRenders(page, label, vacationId) {
  const { placeId } = await page.evaluate(async (vid) => {
    const { createPlace } = await import("./js/places.js");
    const { putPlace, putMedia } = await import("./js/db.js");
    const { todayIso, createId } = await import("./js/utils.js");
    const day = todayIso();
    const place = createPlace({
      vacationId: vid,
      day,
      ts: Date.now() - 1500,
      lat: 48.88,
      lng: 2.36,
      name: "Kaputt-Original",
      soft: false,
      source: "test",
    });
    await putPlace(place);
    await putMedia({
      id: createId(),
      placeId: place.id,
      vacationId: vid,
      day,
      ts: Date.now() - 500,
      type: "photo",
      blob: new Blob([1, 2, 3], { type: "image/jpeg" }),
      thumbBlob: null,
      w: 0,
      h: 0,
    });
    return { placeId: place.id };
  }, vacationId);

  await page.reload();
  await page.waitForSelector('[data-testid="place-list"]');
  await installThumbObservers(page);
  await page.waitForTimeout(2500);

  const ui = await page.evaluate(() => ({
    places: document.querySelectorAll("article.oc").length,
    footer: Boolean(document.querySelector('[data-footer-action="camera"]')),
    mut: window.__listMutations ?? 0,
    errors: window.__thumbImgErrors ?? 0,
  }));
  if (ui.places < 1 || !ui.footer) {
    throw new Error(`${label}: Reise unvollständig (places=${ui.places}, footer=${ui.footer})`);
  }
  if (ui.mut > 40 || ui.errors > 4) {
    throw new Error(`${label}: Render-Schleife (mut=${ui.mut}, errors=${ui.errors})`);
  }
  await page.locator(`[data-place-id="${placeId}"]`).click();
  await page.waitForSelector(`[data-place-id="${placeId}"].oc--selected`);
  const ph = await page.locator(`[data-place-id="${placeId}"] .tile.tile--btn`).count();
  if (ph < 1) {
    throw new Error(`${label}: keine Kachel mit Platzhalter`);
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
  await assertCorruptThumbRebuilds(page, "B16-1", vacationId);
  await assertUnreadableOriginalStillRenders(page, "B16-2", vacationId);

  await ctx.close();
  await browser.close();
  server.close();
  console.log("Playwright 5l tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
