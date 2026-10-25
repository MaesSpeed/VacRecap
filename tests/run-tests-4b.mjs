import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";
import { formatDateRangeOverlay } from "../js/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const screenshotsDir = path.join(root, "docs", "screenshots");

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      const filePath = path.join(root, rel.replace(/^\//, ""));
      try {
        const data = await readFile(filePath);
        const ext = path.extname(filePath);
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/` });
    });
  });
}

async function seedTrip(page, title = "Paris") {
  await page.goto("./");
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', title);
  await page.click('[data-action="pick-dates"]');
  await page.waitForSelector(".calendar-day[data-date='2026-10-24']");
  await page.click('.calendar-day[data-date="2026-10-24"]');
  await page.click('.calendar-day[data-date="2026-10-26"]');
  await page.waitForFunction(() => {
    const btn = document.querySelector('button[data-action="apply"]');
    return btn && !btn.disabled;
  });
  await page.click('button[data-action="apply"]');
  await page.click('[data-preset="stadt"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  return await page.locator(".screen--trip").getAttribute("data-vacation-id");
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

async function runSuite(deviceName, contextOptions) {
  const { baseUrl, browser } = contextOptions;
  const ctx = await browser.newContext({
    baseURL: baseUrl,
    ...devices[deviceName],
    permissions: ["geolocation"],
  });
  const page = await ctx.newPage();

  const cross = formatDateRangeOverlay("2026-12-27", "2027-01-03");
  if (!cross.includes("2026") || !cross.includes("2027")) {
    throw new Error(`Jahreswechsel: ${cross}`);
  }

  const vacationId = await seedTrip(page);
  const day = "2026-10-25";

  await page.evaluate(
    async ({ vacationId, day }) => {
      const { putPlace } = await import("./js/db.js");
      const { createPlace } = await import("./js/places.js");
      const p = createPlace({
        vacationId,
        day,
        ts: Date.now(),
        lat: 48.8584,
        lng: 2.2945,
        name: "Eiffelturm",
        rememberCount: 1,
        rememberFirstTs: Date.now(),
        rememberLastTs: Date.now(),
      });
      await putPlace(p);
    },
    { vacationId, day }
  );
  await page.reload();
  await page.waitForSelector('[data-testid="place-list"]');

  await ctx.setGeolocation({ latitude: 48.8587, longitude: 2.2948 });
  const buf = await makeJpeg(page, 1);
  await page.locator('[data-role="photo-input"]').setInputFiles({
    name: "near.jpg",
    mimeType: "image/jpeg",
    buffer: buf,
  });
  await page.waitForFunction(
    () => {
      const t = document.querySelector('[data-testid="app-toast"]');
      return t && /Eiffelturm|Foto gespeichert/.test(t.innerText) && !t.innerText.includes("Wird gespeichert");
    },
    { timeout: 20000 }
  );
  const toastNear = await page.locator('[data-testid="app-toast"]').innerText();
  if (!toastNear.includes("Eiffelturm")) {
    throw new Error(`${deviceName}: 38m sollte Eiffelturm nutzen: ${toastNear}`);
  }

  await ctx.setGeolocation({ latitude: 48.873, longitude: 2.32 });
  await page.reload();
  await page.waitForSelector('[data-testid="place-list"]');
  const buf2 = await makeJpeg(page, 2);
  await page.locator('[data-role="photo-input"]').setInputFiles({
    name: "far.jpg",
    mimeType: "image/jpeg",
    buffer: buf2,
  });
  await page.waitForFunction(
    () => {
      const t = document.querySelector('[data-testid="app-toast"]');
      return t && t.innerText.includes("Neuer Ort");
    },
    { timeout: 20000 }
  );
  const toastFar = await page.locator('[data-testid="app-toast"]').innerText();
  if (!toastFar.includes("Neuer Ort")) {
    throw new Error(`${deviceName}: 650m sollte Neuer Ort: ${toastFar}`);
  }

  await ctx.setGeolocation(null);
  const buf3 = await makeJpeg(page, 3);
  await page.locator('[data-role="photo-input"]').setInputFiles({
    name: "denied.jpg",
    mimeType: "image/jpeg",
    buffer: buf3,
  });
  await page.waitForTimeout(400);

  await page.goto("./#/urlaube");
  await page.waitForSelector(".top-bar__title");
  const statsText = await page
    .locator(`article.card[data-vacation-id="${vacationId}"] .card-compact__stats, article.card[data-vacation-id="${vacationId}"] .card--hero__footer span`)
    .first()
    .innerText();
  if (statsText.includes("0 Orte") || !statsText.includes("Ort")) {
    throw new Error(`${deviceName}: Stats falsch: ${statsText}`);
  }

  const compact = page.locator(`article.card[data-vacation-id="${vacationId}"]`).first();
  await compact.dispatchEvent("pointerdown");
  await page.waitForTimeout(600);
  await compact.dispatchEvent("pointerup");
  await page.waitForSelector('[data-testid="vacation-action-sheet"]');
  await page.click('[data-testid="vacation-action-sheet"] [data-action="edit"]');
  await page.waitForURL(/bearbeiten/);

  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="place-list"]');
  await page.click('[data-action="settings"]');
  await page.waitForSelector('[data-testid="settings-screen"]');
  await page.click('[data-action="back"]');
  await page.waitForSelector(".trip-header__title");

  await ctx.close();
}

async function main() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();

  await runSuite("iPhone 8", { baseUrl, browser });
  await runSuite("Pixel 5", { baseUrl, browser });

  const ctx = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 390, height: 844 },
    permissions: ["geolocation"],
  });
  const page = await ctx.newPage();
  const vacationId = await seedTrip(page, "Screenshots 4b");
  await page.evaluate(
    async ({ vacationId }) => {
      const { putPlace, putNote } = await import("./js/db.js");
      const { createPlace } = await import("./js/places.js");
      const { createId } = await import("./js/utils.js");
      const p = createPlace({
        vacationId,
        day: "2026-10-25",
        ts: new Date("2026-10-25T09:15:00").getTime(),
        lat: 48.86,
        lng: 2.33,
        name: "Louvre",
        rememberCount: 2,
        rememberFirstTs: new Date("2026-10-25T09:15:00").getTime(),
        rememberLastTs: new Date("2026-10-25T09:40:00").getTime(),
      });
      await putPlace(p);
      await putNote({
        id: createId(),
        placeId: p.id,
        vacationId,
        day: "2026-10-25",
        text: "Testnotiz",
        ts: Date.now(),
      });
    },
    { vacationId }
  );
  await page.reload();
  await page.waitForSelector(".oc--selected");
  await page.screenshot({
    path: path.join(screenshotsDir, "29-urlaub-karten-meta-390.png"),
    fullPage: true,
  });
  await page.goto("./#/urlaube");
  await page.waitForSelector(".card--hero");
  await page.screenshot({
    path: path.join(screenshotsDir, "29-uebersicht-hero-390.png"),
    fullPage: true,
  });
  await ctx.close();

  await browser.close();
  server.close();
  console.log("Playwright 4b tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
