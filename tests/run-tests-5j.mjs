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

const VIEWPORTS = [
  { name: "375x667", width: 375, height: 667 },
  { name: "360x740", width: 360, height: 740 },
  { name: "390x844", width: 390, height: 844 },
];

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

async function seedTwoPlaceTrip(page) {
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
  return vacationId;
}

async function assertDimThumbLayout(page, label) {
  const vacationId = await page.locator(".screen--trip").getAttribute("data-vacation-id");
  const { place1, place2 } = await page.evaluate(async (vid) => {
    const { createPlace } = await import("./js/places.js");
    const { putPlace, putMedia } = await import("./js/db.js");
    const { todayIso, createId } = await import("./js/utils.js");
    const day = todayIso();
    const p1 = createPlace({
      vacationId: vid,
      day,
      ts: Date.now() - 4000,
      lat: 48.86,
      lng: 2.34,
      name: "Ort Alpha",
      soft: false,
      source: "test",
    });
    const p2 = createPlace({
      vacationId: vid,
      day,
      ts: Date.now() - 2000,
      lat: 48.87,
      lng: 2.35,
      name: "Ort Beta",
      soft: false,
      source: "test",
    });
    await putPlace(p1);
    await putPlace(p2);
    const canvas = document.createElement("canvas");
    canvas.width = 100;
    canvas.height = 80;
    canvas.getContext("2d").fillStyle = "#5588aa";
    canvas.getContext("2d").fillRect(0, 0, 100, 80);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    await putMedia({
      id: createId(),
      placeId: p1.id,
      vacationId: vid,
      day,
      ts: Date.now() - 3500,
      type: "photo",
      blob,
      thumbBlob: blob,
      w: 100,
      h: 80,
    });
    return { place1: p1.id, place2: p2.id };
  }, vacationId);

  await page.reload();
  await page.waitForSelector('[data-testid="place-list"]');
  await page.locator(`[data-place-id="${place2}"]`).click();
  await page.waitForSelector(`[data-place-id="${place2}"].oc--selected`);

  const metrics = await page.evaluate((place1) => {
    const card = document.querySelector(`article.oc--dim[data-place-id="${place1}"]`);
    const th = card?.querySelector(".th");
    const title = card?.querySelector(".oc__title");
    const thBox = th?.getBoundingClientRect();
    const titleBox = title?.getBoundingClientRect();
    return {
      thW: thBox?.width ?? 0,
      thH: thBox?.height ?? 0,
      titleW: titleBox?.width ?? 0,
      hasImg: Boolean(card?.querySelector(".th__img")),
    };
  }, place1);

  if (metrics.thW > 70 || metrics.thH > 70) {
    throw new Error(`${label}: Dim-Thumb zu groß (${metrics.thW}x${metrics.thH})`);
  }
  if (metrics.thW < 50 || metrics.thH < 50) {
    throw new Error(`${label}: Dim-Thumb zu klein (${metrics.thW}x${metrics.thH})`);
  }
  if (metrics.titleW < 40) {
    throw new Error(`${label}: Titel-Breite ${metrics.titleW}px`);
  }
  if (!metrics.hasImg) {
    throw new Error(`${label}: kein .th__img in Dim-Karte`);
  }
}

async function assertBrokenThumbRegenerates(page, label, vacationId) {
  const { mediaId, placeId } = await page.evaluate(async (vid) => {
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
      name: "Thumb-Test",
      soft: false,
      source: "test",
    });
    await putPlace(place);
    const id = createId();
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 90;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#336699";
    ctx.fillRect(0, 0, 120, 90);
    const full = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    await putMedia({
      id,
      placeId: place.id,
      vacationId: vid,
      day,
      ts: Date.now() - 1000,
      type: "photo",
      blob: full,
      thumbBlob: new Blob([], { type: "image/jpeg" }),
      w: 120,
      h: 90,
    });
    return { mediaId: id, placeId: place.id };
  }, vacationId);
  await page.reload();
  await page.waitForSelector('[data-testid="place-list"]');
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
}

async function assertMissingThumbGenerated(page, label, vacationId) {
  const { mediaId, placeId } = await page.evaluate(async (vid) => {
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
      name: "Ohne-Thumb",
      soft: false,
      source: "test",
    });
    await putPlace(place);
    const id = createId();
    const canvas = document.createElement("canvas");
    canvas.width = 90;
    canvas.height = 70;
    canvas.getContext("2d").fillStyle = "#aa6633";
    canvas.getContext("2d").fillRect(0, 0, 90, 70);
    const full = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    await putMedia({
      id,
      placeId: place.id,
      vacationId: vid,
      day,
      ts: Date.now() - 500,
      type: "photo",
      blob: full,
      thumbBlob: null,
      w: 90,
      h: 70,
    });
    return { mediaId: id, placeId: place.id };
  }, vacationId);
  await page.reload();
  await page.waitForSelector('[data-testid="place-list"]');
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
  const stored = await page.evaluate(async (mediaId) => {
    const { getMedia } = await import("./js/db.js");
    const m = await getMedia(mediaId);
    return m?.thumbBlob?.size ?? 0;
  }, mediaId);
  if (stored < 100) {
    throw new Error(`${label}: thumbBlob nicht gespeichert (${stored})`);
  }
}

async function main() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      baseURL: baseUrl,
      ...devices["iPhone 8"],
      viewport: { width: vp.width, height: vp.height },
      geolocation: { latitude: 48.8566, longitude: 2.3522 },
      permissions: ["geolocation"],
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(60_000);
    await seedTwoPlaceTrip(page);
    await assertDimThumbLayout(page, `B14-1-${vp.name}`);
    await ctx.close();
  }

  const ctx = await browser.newContext({
    baseURL: baseUrl,
    ...devices["iPhone 8"],
    viewport: { width: 375, height: 667 },
    geolocation: { latitude: 48.8566, longitude: 2.3522 },
    permissions: ["geolocation"],
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  const vacationId = await seedTwoPlaceTrip(page);
  await assertBrokenThumbRegenerates(page, "B14-2", vacationId);
  await assertMissingThumbGenerated(page, "B14-3", vacationId);
  await ctx.close();

  await browser.close();
  server.close();
  console.log("Playwright 5j tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
