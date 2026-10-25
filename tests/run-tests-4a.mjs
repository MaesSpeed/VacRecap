import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";
import {
  dayCountInclusive,
  formatDateRangeCard,
  formatDateRangeOverlay,
} from "../js/utils.js";

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
  ".woff2": "font/woff2",
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

async function seedVacation(page, { title, start, end }) {
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', title);
  await page.click('[data-action="pick-dates"]');
  await page.click('.calendar-day[data-date="' + start + '"]');
  await page.click('.calendar-day[data-date="' + end + '"]');
  await page.click('button[data-action="apply"]');
  await page.click('[data-preset="stadt"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector(".trip-header__title");
  return await page.locator(".screen--trip").getAttribute("data-vacation-id");
}

async function runViewportTests(browser, baseUrl, label, viewport, hasTouch) {
  const context = await browser.newContext({
    baseURL: baseUrl,
    viewport,
    hasTouch,
    isMobile: true,
  });
  const page = await context.newPage();
  const spring = dayCountInclusive("2027-03-26", "2027-03-30");
  const winter = dayCountInclusive("2026-10-28", "2026-11-01");
  const single = formatDateRangeCard("2026-11-14", "2026-11-14");
  const crossYear = formatDateRangeOverlay("2026-12-27", "2027-01-03");
  if (spring !== 5 || winter !== 5) {
    throw new Error(`DST day count failed: ${spring} ${winter}`);
  }
  if (!single.includes("1 Tag") || single.includes("–")) {
    throw new Error(`single day format: ${single}`);
  }
  if (!crossYear.includes("2026") || !crossYear.includes("2027")) {
    throw new Error(`cross year: ${crossYear}`);
  }

  await page.goto("./");
  const vacationId = await seedVacation(page, {
    title: "Fix Test " + label,
    start: "2026-11-06",
    end: "2026-11-08",
  });
  await page.goBack();
  await page.waitForSelector(".top-bar__title");

  await page.goto("./#/urlaube");
  await page.waitForSelector(".card--compact");
  const card = page.locator(`article.card[data-vacation-id="${vacationId}"]`);
  await card.dispatchEvent("pointerdown");
  await page.waitForTimeout(850);
  await card.dispatchEvent("pointerup");
  await page.waitForSelector('[data-testid="vacation-action-sheet"]');
  await page.locator('[data-testid="vacation-action-sheet"] [data-action="cancel"]').click();
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);
  await page.waitForTimeout(500);

  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector(".trip-header__title");
  await page.screenshot({
    path: path.join(screenshotsDir, "17-urlaub-ansicht-390.png"),
    fullPage: true,
  });
  if (await page.locator('[data-action="calendar"]').count()) {
    throw new Error("Kalender-Icon soll entfernt sein");
  }
  await page.click('[data-day="2026-11-07"]');
  await page.waitForSelector('[data-testid="trip-content"][data-active-day="2026-11-07"]');

  await context.close();
}

async function main() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();

  const iPhone = devices["iPhone 8"];
  const ctxIphone = await browser.newContext({
    ...iPhone,
    baseURL: baseUrl,
    viewport: { width: 390, height: 844 },
  });
  const pageI = await ctxIphone.newPage();
  await pageI.goto("./");
  await seedVacation(pageI, { title: "Übersicht Demo", start: "2026-12-01", end: "2026-12-05" });
  await pageI.goto("./#/urlaube");
  await pageI.waitForSelector(".top-bar__title");
  await pageI.screenshot({
    path: path.join(screenshotsDir, "16-uebersicht-390.png"),
    fullPage: true,
  });

  await pageI.goto("./");
  await seedVacation(pageI, { title: "Langdruck", start: "2026-11-01", end: "2026-11-03" });
  await pageI.goto("./#/urlaube");
  const card = pageI.locator(".card--compact").first();
  await card.dispatchEvent("pointerdown");
  await pageI.waitForTimeout(850);
  await card.dispatchEvent("pointerup");
  await pageI.waitForSelector('[data-testid="vacation-action-sheet"]');
  await pageI.screenshot({
    path: path.join(screenshotsDir, "18-langdruck-menue-touch.png"),
    fullPage: true,
  });
  await ctxIphone.close();

  await runViewportTests(browser, baseUrl, "iphone8", { width: 390, height: 844 }, true);
  await runViewportTests(browser, baseUrl, "android", { width: 360, height: 740 }, true);

  await browser.close();
  server.close();
  console.log("Playwright 4a tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
