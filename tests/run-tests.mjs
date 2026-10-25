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

async function swipeHorizontal(page, selector, direction = "left") {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error("swipe target missing");
  const y = box.y + box.height / 2;
  const fromX = direction === "left" ? box.x + box.width * 0.75 : box.x + box.width * 0.25;
  const toX = direction === "left" ? box.x + box.width * 0.25 : box.x + box.width * 0.75;
  await page.mouse.move(fromX, y);
  await page.mouse.down();
  await page.mouse.move(toX, y, { steps: 14 });
  await page.mouse.up();
}

async function longPress(page, selector, ms = 550) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error("long-press target missing");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

async function waitForNoToast(page) {
  await page.waitForFunction(() => {
    const toast = document.querySelector('[data-testid="app-toast"]');
    return !toast || !toast.classList.contains("toast--visible");
  });
}

async function createVacation(page, { title, start, end }) {
  await page.click('[data-action="new"]');
  await page.waitForSelector(".form-header--minimal");
  await page.fill('[name="title"]', title);
  await page.click('[data-action="pick-dates"]');
  await page.click(`.calendar-day[data-date="${start}"]`);
  await page.click(`.calendar-day[data-date="${end}"]`);
  await page.click('button[data-action="apply"]');
  await page.click('[data-preset="stadt"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector(".trip-header__title");
}

async function main() {
  const { server, baseUrl } = await startServer();
  const iPhone = devices["iPhone 8"];
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...iPhone, baseURL: baseUrl });
  await context.grantPermissions(["geolocation"], { origin: baseUrl });
  await context.setGeolocation({ latitude: 48.8566, longitude: 2.3522 });
  const page = await context.newPage();
  await page.route("**/nominatim.openstreetmap.org/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ name: "Paris", address: { road: "Rue de Rivoli" } }),
    })
  );

  await page.goto("./");
  await page.waitForSelector("h1.top-bar__title");
  await page.screenshot({ path: path.join(screenshotsDir, "01-urlaube-leer.png"), fullPage: true });

  await page.click('[data-action="new"]');
  await page.waitForSelector(".form-header--minimal");
  await page.fill('[name="title"]', "Paris");
  await page.click('[data-action="pick-dates"]');
  await page.click('.calendar-day[data-date="2026-11-06"]');
  await page.click('.calendar-day[data-date="2026-11-08"]');
  await page.click('button[data-action="apply"]');
  await page.click('[data-preset="stadt"]');
  await page.click('[data-tag="familie"]');
  await page.fill('[data-role="name-input"]', "Anna");
  await page.keyboard.press("Enter");
  await page.screenshot({ path: path.join(screenshotsDir, "02-urlaub-formular.png"), fullPage: true });

  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-empty"]');
  await waitForNoToast(page);
  await page.screenshot({ path: path.join(screenshotsDir, "03-urlaub-ansicht.png"), fullPage: true });
  await page.screenshot({
    path: path.join(screenshotsDir, "08-draft-v13-urlaub.png"),
    fullPage: true,
  });
  const mapFill = await page.locator(".icon-btn--map-draft path").first().getAttribute("fill");
  if (mapFill !== "#9fb3cc") throw new Error("draft map icon fill mismatch");

  await page.click('[data-day="2026-11-07"]');
  await page.waitForSelector('[data-testid="trip-content"][data-active-day="2026-11-07"]');
  const chipActive = await page.locator('[data-day="2026-11-07"]').getAttribute("aria-selected");
  if (chipActive !== "true") throw new Error("chip day 2 not active");

  await swipeHorizontal(page, '[data-testid="trip-content"]', "left");
  await page.waitForSelector('[data-testid="trip-content"][data-active-day="2026-11-08"]');

  await page.click('[data-action="calendar"]');
  await page.waitForSelector(".sheet--trip-calendar");
  await waitForNoToast(page);
  await page.screenshot({ path: path.join(screenshotsDir, "06-kalender.png"), fullPage: true });
  await page.click('.calendar-day[data-date="2026-11-06"]');
  await page.waitForSelector('[data-testid="trip-content"][data-active-day="2026-11-06"]');

  await longPress(page, '[data-footer-action="camera"]');
  await page.waitForSelector(".trip-footer-hint--visible");
  await waitForNoToast(page);
  if (await page.locator('[data-testid="camera-sheet"]').count()) {
    await page.click('[data-action="cancel"]');
  }

  await page.click('[data-footer-action="pin"]');
  await page.waitForSelector('[data-testid="app-toast"]');
  await waitForNoToast(page);
  await page.click('[data-footer-action="note"]');
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.click('[data-action="cancel"]');

  await page.click('[data-action="settings"]');
  await waitForNoToast(page);
  await page.waitForSelector('[data-testid="remember-location"]');
  await page.screenshot({ path: path.join(screenshotsDir, "07-einstellungen.png"), fullPage: true });

  const toggle = page.locator('[role="switch"][data-testid="remember-location"]');
  const settingsUrl = page.url();
  await Promise.all([
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.addEventListener("vacrecap:setting-saved", resolve, { once: true });
        })
    ),
    toggle.click(),
  ]);
  if ((await toggle.getAttribute("aria-checked")) !== "false") {
    throw new Error("switch should be off after click");
  }
  await page.goto(settingsUrl);
  await page.waitForSelector('[data-testid="remember-location"]');
  if ((await toggle.getAttribute("aria-checked")) !== "false") {
    throw new Error("remember-location should stay off after reload");
  }
  await Promise.all([
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.addEventListener("vacrecap:setting-saved", resolve, { once: true });
        })
    ),
    toggle.click(),
  ]);
  await page.goto(settingsUrl);
  await page.waitForSelector('[data-testid="remember-location"]');
  if ((await toggle.getAttribute("aria-checked")) !== "true") {
    throw new Error("remember-location should stay on after reload");
  }

  await page.click('[data-action="back"]');
  await page.waitForSelector(".trip-header__title");
  await waitForNoToast(page);
  await page.screenshot({ path: path.join(screenshotsDir, "05-urlaub-tag-anreise.png"), fullPage: true });

  await page.click('[data-action="back"]');
  await page.waitForSelector(".card--compact");

  await createVacation(page, {
    title: "Herbst",
    start: "2026-10-20",
    end: "2026-11-22",
  });
  await page.click('[data-action="calendar"]');
  await page.waitForSelector(".calendar-month__title");
  const months = await page.locator(".calendar-month__title").allTextContents();
  if (!months.some((t) => t.includes("November"))) throw new Error("calendar missing November");
  await page.click('.calendar-day[data-date="2026-11-10"]');
  await page.waitForSelector('[data-testid="trip-content"][data-active-day="2026-11-10"]');

  await page.click('[data-action="back"]');
  await page.waitForSelector("h1.top-bar__title");
  await waitForNoToast(page);
  await page.screenshot({ path: path.join(screenshotsDir, "04-urlaube-mit-eintrag.png"), fullPage: true });

  await browser.close();
  server.close();
  console.log("Playwright tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
