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
      body: JSON.stringify({
        name: "Rue de Rivoli",
        address: { road: "Rue de Rivoli", house_number: "12" },
      }),
    })
  );

  await page.goto("./");
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', "Paris 2a");
  await page.click('[data-action="pick-dates"]');
  await page.click('.calendar-day[data-date="2026-10-25"]');
  await page.click('.calendar-day[data-date="2026-10-27"]');
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');

  const vacationId = await page.locator(".screen--trip").getAttribute("data-vacation-id");
  const day = "2026-10-25";

  await page.evaluate(
    async ({ vacationId, day }) => {
      const { putPlace } = await import("./js/db.js");
      const { createPlace } = await import("./js/places.js");
      const t = Date.now();
      await putPlace(
        createPlace({
          vacationId,
          day,
          ts: t - 400000,
          lat: 48.8606,
          lng: 2.3376,
          name: "Louvre",
        })
      );
      await putPlace(
        createPlace({
          vacationId,
          day,
          ts: t - 300000,
          lat: 48.8584,
          lng: 2.2945,
          name: "Eiffelturm",
        })
      );
      await putPlace(
        createPlace({
          vacationId,
          day,
          ts: t - 200000,
          lat: 48.8867,
          lng: 2.3431,
          name: "Sacré-Cœur",
        })
      );
      await putPlace(
        createPlace({
          vacationId,
          day,
          ts: t - 100000,
          lat: 48.8566,
          lng: 2.3522,
          name: "Rue de Rivoli",
          soft: true,
          source: "open",
        })
      );
    },
    { vacationId, day }
  );

  await page.evaluate(async () => {
    const { setRememberLocationOnOpen } = await import("./js/settings-store.js");
    await setRememberLocationOnOpen(false);
  });
  await page.reload();
  await page.waitForSelector('[data-testid="place-list"]');
  await waitForNoToast(page);
  await page.screenshot({
    path: path.join(screenshotsDir, "09-orte-liste-v13.png"),
    fullPage: true,
  });

  const cards = await page.locator(".oc").count();
  const soft = await page.locator(".soft").count();
  if (cards < 3 || soft < 1) throw new Error("seed list incomplete");

  await page.locator(".oc--dim").first().click();
  await page.waitForSelector(".oc--selected");
  await page.locator('[data-action="edit-place"]').click();
  await page.waitForSelector(".sheet--place-edit");
  await page.screenshot({
    path: path.join(screenshotsDir, "10-ort-bearbeiten-sheet.png"),
    fullPage: true,
  });
  await page.click('[data-action="cancel"]');

  await page.locator(".soft").filter({ hasText: "Rue de Rivoli" }).click();
  await page.waitForSelector(".sheet--soft-point");
  await page.screenshot({
    path: path.join(screenshotsDir, "11-weicher-punkt-sheet.png"),
    fullPage: true,
  });
  await page.click('[data-action="cancel"]');

  await context.setGeolocation({ latitude: 48.8584, longitude: 2.2945 });
  await page.click('[data-footer-action="pin"]');
  await page.waitForSelector('[data-testid="app-toast"]');
  const toastText = await page.locator('[data-testid="app-toast"]').innerText();
  if (!toastText.includes("Schon gemerkt")) {
    throw new Error("expected duplicate toast");
  }
  await waitForNoToast(page);

  const countBefore = await page.locator(".oc").count();
  await page.evaluate(
    async ({ vacationId, day }) => {
      const { rememberPlaceAtLocation } = await import("./js/place-service.js");
      await rememberPlaceAtLocation({
        vacationId,
        day,
        lat: 43.603,
        lng: 1.444,
        accuracy: 8,
      });
    },
    { vacationId, day }
  );
  await page.reload();
  await page.waitForSelector('[data-testid="place-list"]');
  const countAfter = await page.locator(".oc").count();
  if (countAfter <= countBefore) throw new Error("new hard place should be added");

  await browser.close();
  server.close();
  console.log("Playwright 2a tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
