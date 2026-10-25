import { spawn } from "node:child_process";
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

async function main() {
  const { server, baseUrl } = await startServer();
  const iPhone = devices["iPhone 8"];
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...iPhone, baseURL: baseUrl });
  const page = await context.newPage();

  await page.goto("./");
  await page.waitForSelector("h1.top-bar__title");

  await page.screenshot({ path: path.join(screenshotsDir, "01-urlaube-leer.png"), fullPage: true });

  await page.click('[data-action="new"]');
  await page.waitForSelector(".form-header__title");
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
  await page.waitForSelector(".detail-header__title");
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(screenshotsDir, "03-urlaub-platzhalter.png"), fullPage: true });

  await page.click('[data-action="back"]');
  await page.waitForSelector(".card--compact, .card--hero");
  await page.screenshot({ path: path.join(screenshotsDir, "04-urlaube-mit-eintrag.png"), fullPage: true });

  const title = await page.textContent(".card-compact__title, .card--hero__title");
  if (!title?.includes("Paris")) throw new Error("Paris card missing");

  await browser.close();
  server.close();
  console.log("Playwright tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
