import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const screenshotsDir = path.join(root, "docs", "screenshots");
const tilePlaceholder = path.join(root, "assets", "map-tile-placeholder.png");

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

async function seedMapVacation(page) {
  await page.goto("./");
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', "Paris");
  await page.click('[data-action="pick-dates"]');
  await page.click('.calendar-day[data-date="2026-10-25"]');
  await page.click('.calendar-day[data-date="2026-10-27"]');
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  const vacationId = await page.locator(".screen--trip").getAttribute("data-vacation-id");

  await page.evaluate(async ({ vacationId }) => {
    const { putPlace } = await import("./js/db.js");
    const { createPlace } = await import("./js/places.js");
    const { createId } = await import("./js/utils.js");

    const days = ["2026-10-25", "2026-10-26", "2026-10-27"];
    const coords = [
      [48.8584, 2.2945],
      [48.8738, 2.295],
      [48.8606, 2.3376],
      [48.8529, 2.35],
      [48.8462, 2.3372],
      [48.8705, 2.3865],
      [48.8867, 2.3431],
      [48.8799, 2.3553],
      [48.8656, 2.3212],
      [48.8412, 2.3522],
    ];
    let i = 0;
    for (const day of days) {
      const count = day === "2026-10-26" ? 4 : 3;
      let lastLat = coords[0][0];
      let lastLng = coords[0][1];
      for (let j = 0; j < count; j++) {
        const [lat, lng] = coords[i++];
        lastLat = lat;
        lastLng = lng;
        await putPlace(
          createPlace({
            id: createId(),
            vacationId,
            day,
            ts: new Date(`${day}T${10 + j}:15:00`).getTime(),
            lat,
            lng,
            name: `Ort ${i}`,
            soft: false,
          })
        );
      }
      await putPlace(
        createPlace({
          id: createId(),
          vacationId,
          day,
          ts: new Date(`${day}T19:00:00`).getTime(),
          lat: lastLat + 0.002,
          lng: lastLng + 0.002,
          name: "Weicher Punkt",
          soft: true,
          source: "open",
        })
      );
    }
  }, { vacationId });

  await page.evaluate(async () => {
    const { setRememberLocationOnOpen } = await import("./js/settings-store.js");
    await setRememberLocationOnOpen(false);
  });
  await page.reload();
  await page.waitForSelector('[data-testid="trip-content"]');
  return vacationId;
}

async function assertTripNameVisible(page, expected) {
  const trip = page.locator(".map-header__trip");
  const text = await trip.innerText();
  if (text !== expected) {
    throw new Error(`trip name: expected "${expected}", got "${text}"`);
  }
  const clipped = await trip.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  if (expected === "Paris" && clipped) {
    throw new Error("Paris should not be truncated in header");
  }
}

async function assertSettingsLinesSingleRow(page, label) {
  const bad = await page.evaluate(() => {
    const els = document.querySelectorAll(".settings-item__title, .settings-item__sub");
    return [...els].filter((el) => {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 14;
      return el.scrollHeight > lh * 1.3;
    }).map((el) => el.textContent);
  });
  if (bad.length) {
    throw new Error(`${label}: wrapped settings lines: ${bad.join(" | ")}`);
  }
}

async function runFlow(page, { captureScreenshots, label }) {
  await page.route("**/tile.openstreetmap.org/**", (route) =>
    route.fulfill({ path: tilePlaceholder, contentType: "image/png" })
  );

  const vacationId = await seedMapVacation(page);

  await page.tap('[data-action="map"]');
  await page.waitForSelector('[data-testid="map-screen"]');
  await assertTripNameVisible(page, "Paris");
  await page.waitForSelector(".leaflet-container");
  await page.waitForFunction(
    () => document.querySelectorAll(".map-marker--hard").length >= 10
  );

  const hard = await page.locator(".map-marker--hard").count();
  const soft = await page.locator(".map-marker--soft").count();
  if (hard < 10 || soft < 2) {
    throw new Error(`${label}: markers hard=${hard} soft=${soft}`);
  }

  if (captureScreenshots) {
    await page.screenshot({
      path: path.join(screenshotsDir, "23-karte-alle-tage.png"),
      fullPage: true,
    });
  }

  await page.locator('[data-segment="2026-10-26"]').tap();
  await page.waitForTimeout(400);
  if (captureScreenshots) {
    await page.screenshot({
      path: path.join(screenshotsDir, "24-karte-ein-tag.png"),
      fullPage: true,
    });
  }

  await page.tap('[data-action="back"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-action="settings"]');

  if (captureScreenshots) {
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await page.locator('[data-action="settings"]').tap();
  await page.waitForSelector('[data-testid="settings-screen"]');
  await assertTripNameVisible(page, "Paris");
  await assertSettingsLinesSingleRow(page, label);
  const radiusBtn = page.locator('[data-radius="100"]');
  await radiusBtn.tap();
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-role="radius-value"]');
    return v?.textContent?.includes("100");
  });

  if (captureScreenshots) {
    await page.screenshot({
      path: path.join(screenshotsDir, "25-einstellungen.png"),
      fullPage: true,
    });
  }

  await page.tap('[data-action="back"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  if (!vacationId) throw new Error(`${label}: missing vacation id`);
}

async function testLongVacationName(page, width) {
  await page.setViewportSize({ width, height: 740 });
  await page.goto("./");
  const longTitle = "Alpenüberquerung Sommer 2026 CH";
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', longTitle);
  await page.click('[data-action="pick-dates"]');
  await page.click('.calendar-day[data-date="2026-11-01"]');
  await page.click('.calendar-day[data-date="2026-11-03"]');
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.tap('[data-action="settings"]');
  await page.waitForSelector('[data-testid="settings-screen"]');
  await assertSettingsLinesSingleRow(page, `long-${width}`);
  const clipped = await page.locator(".map-header__trip").evaluate(
    (el) => el.scrollWidth > el.clientWidth + 1
  );
  if (!clipped) {
    throw new Error(`expected long title ellipsis at ${width}px`);
  }
  const titleOk = await page.locator(".map-header__title").evaluate(
    (el) => el.scrollWidth <= el.clientWidth + 1
  );
  if (!titleOk) {
    throw new Error(`settings title clipped at ${width}px`);
  }
}

async function main() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const iPhone = devices["iPhone 8"];

  const ctxI = await browser.newContext({
    ...iPhone,
    baseURL: baseUrl,
    hasTouch: true,
    geolocation: { latitude: 48.8566, longitude: 2.3522 },
    permissions: ["geolocation"],
  });
  const pageI = await ctxI.newPage();
  await runFlow(pageI, { captureScreenshots: true, label: "iphone8" });
  await testLongVacationName(pageI, 375);
  await ctxI.close();

  const ctxA = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 360, height: 740 },
    hasTouch: true,
    isMobile: true,
    geolocation: { latitude: 48.8566, longitude: 2.3522 },
    permissions: ["geolocation"],
  });
  const pageA = await ctxA.newPage();
  await runFlow(pageA, { captureScreenshots: false, label: "android" });
  await testLongVacationName(pageA, 360);
  await ctxA.close();

  await browser.close();
  server.close();
  console.log("Playwright 3b-1 tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
