import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const screenshotsDir = path.join(root, "docs", "screenshots");

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
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

async function waitForNoToast(page) {
  await page.waitForFunction(() => {
    const toast = document.querySelector('[data-testid="app-toast"]');
    return !toast || !toast.classList.contains("toast--visible");
  });
}

async function makeJpegBytes(page, hue) {
  return await page.evaluate(async (h) => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 400, 300);
    g.addColorStop(0, `hsl(${h}, 65%, 50%)`);
    g.addColorStop(1, `hsl(${h + 30}, 55%, 70%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 400, 300);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    const buf = await blob.arrayBuffer();
    return Array.from(new Uint8Array(buf));
  }, hue);
}

async function openMediathekWithFiles(page, fileSpecs) {
  await page.evaluate(
    async (specs) => {
      const input = document.querySelector('[data-role="gallery-input"]');
      const dt = new DataTransfer();
      for (const spec of specs) {
        const file = new File([new Uint8Array(spec.bytes)], spec.name, {
          type: spec.type,
          lastModified: spec.lastModified,
        });
        dt.items.add(file);
      }
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    fileSpecs
  );
  await page.waitForSelector('[data-testid="mediathek-screen"]');
}

async function runMediathekTests(page, { captureScreenshots, label }) {
  await page.goto("./");
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', `Mediathek ${label}`);
  await page.click('[data-action="pick-dates"]');
  await page.click('.calendar-day[data-date="2026-10-25"]');
  await page.click('.calendar-day[data-date="2026-10-27"]');
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');

  const vacationId = await page.locator(".screen--trip").getAttribute("data-vacation-id");
  const day2 = "2026-10-26";

  const placeId = await page.evaluate(
    async ({ vacationId, day2 }) => {
      const { putPlace } = await import("./js/db.js");
      const { createPlace } = await import("./js/places.js");
      const place = createPlace({
        vacationId,
        day: day2,
        ts: new Date(`${day2}T14:30:00`).getTime(),
        lat: 48.8584,
        lng: 2.2945,
        name: "Eiffelturm",
      });
      await putPlace(place);
      return place.id;
    },
    { vacationId, day2 }
  );

  await page.evaluate(async () => {
    const { setRememberLocationOnOpen } = await import("./js/settings-store.js");
    await setRememberLocationOnOpen(false);
  });
  await page.reload();
  await page.waitForSelector('[data-testid="trip-content"]');

  await page.locator(`[data-day="${day2}"]`).tap();
  await page.waitForSelector(`.oc[data-place-id="${placeId}"]`);

  const fileSpecs = [];
  const baseTs = 1_700_000_000_000;
  for (let i = 0; i < 9; i++) {
    const bytes = await makeJpegBytes(page, 40 + i * 18);
    fileSpecs.push({
      bytes,
      name: `mediathek-${i}.jpg`,
      type: "image/jpeg",
      lastModified: baseTs + i * 60_000,
    });
  }

  await openMediathekWithFiles(page, fileSpecs);
  await page.waitForFunction(() => {
    const tiles = document.querySelectorAll(".mediathek-tile");
    return tiles.length === 9 && document.querySelector(".mediathek-tile__badge--on");
  });

  const tiles = page.locator(".mediathek-tile");
  for (let i = 0; i < 6; i++) {
    await tiles.nth(i).tap();
  }

  const meta = await page.locator(".mediathek-bar__meta").innerText();
  if (!meta.includes("3 AUSGEWÄHLT")) {
    throw new Error(`${label}: expected 3 selected, meta=${meta}`);
  }

  const placeLine = await page.locator(".mediathek-bar__place-text").innerText();
  if (!placeLine.includes("Eiffelturm") || !placeLine.includes("2. Tag")) {
    throw new Error(`${label}: place line mismatch: ${placeLine}`);
  }

  if (captureScreenshots) {
    await page.screenshot({
      path: path.join(screenshotsDir, "20-mediathek-auswahl.png"),
      fullPage: true,
    });
  }

  await page.tap('[data-action="change-place"]');
  await page.waitForSelector('[data-testid="mediathek-place-sheet"]');
  if (captureScreenshots) {
    await page.screenshot({
      path: path.join(screenshotsDir, "21-mediathek-ort-aendern.png"),
      fullPage: true,
    });
  }
  await page.locator('[data-testid="mediathek-place-sheet"] [data-action="cancel"]').tap();
  await page.waitForSelector('[data-testid="mediathek-screen"]');

  await page.tap('[data-action="add"]');
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="app-toast"]');
    return t?.textContent?.includes("hinzugefügt");
  });
  await page.waitForSelector(".screen--trip");
  await page.waitForSelector(`.oc[data-place-id="${placeId}"].oc--selected`);

  const tileCount = await page.locator(".oc--selected .tile").count();
  if (tileCount < 3) {
    throw new Error(`${label}: expected at least 3 tiles after add, got ${tileCount}`);
  }

  if (captureScreenshots) {
    await page.screenshot({
      path: path.join(screenshotsDir, "22-nach-hinzufuegen.png"),
      fullPage: true,
    });
  }

  await waitForNoToast(page);

  await page.goto(`./#/urlaub/${vacationId}/mediathek`);
  await page.waitForSelector('[data-testid="trip-content"]');

  const dupSpecs = [fileSpecs[0]];
  await openMediathekWithFiles(page, dupSpecs);
  await page.tap('[data-action="add"]');
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="app-toast"]');
    return t?.textContent?.includes("übersprungen");
  });
  await waitForNoToast(page);
}

async function main() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();

  const iPhone = devices["iPhone 8"];
  const ctxIphone = await browser.newContext({ ...iPhone, baseURL: baseUrl, hasTouch: true });
  const pageI = await ctxIphone.newPage();
  await runMediathekTests(pageI, { captureScreenshots: true, label: "iphone8" });
  await ctxIphone.close();

  const ctxAndroid = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 360, height: 740 },
    hasTouch: true,
    isMobile: true,
  });
  const pageA = await ctxAndroid.newPage();
  await runMediathekTests(pageA, { captureScreenshots: false, label: "android" });
  await ctxAndroid.close();

  await browser.close();
  server.close();
  console.log("Playwright 3a tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
