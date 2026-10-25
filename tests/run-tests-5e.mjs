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

async function seedTripWithPlace(page) {
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

async function assertPlaceCardCamera(page, label) {
  await page.evaluate(() => {
    window.__captureOpens = 0;
    document.querySelector('[data-role="capture-input"]')?.addEventListener("click", () => {
      window.__captureOpens = (window.__captureOpens || 0) + 1;
    });
  });
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 3000 }).catch(() => null);
  await page.locator('.oc--selected [data-action="camera-place"]').click();
  const chooser = await chooserPromise;
  if (chooser) await chooser.setFiles([]);
  const opens = await page.evaluate(() => window.__captureOpens ?? 0);
  if (opens !== 1) {
    throw new Error(`${label}: Ortskarten-Kamera öffnete capture ${opens}x statt 1x`);
  }
  await page.waitForTimeout(900);
  const err = await page.evaluate(() => window.__lastError ?? null);
  if (err?.includes("openCameraSheet")) {
    throw new Error(`${label}: openCameraSheet ReferenceError`);
  }
}

async function assertMapFooterCamera(page, label, vacationId) {
  await page.route("**/routing.openstreetmap.de/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"routes":[]}' })
  );
  await page.evaluate(async () => {
    const { setMapRoutesEnabled } = await import("./js/settings-store.js");
    await setMapRoutesEnabled(false);
  });
  await page.click('[data-action="map"]');
  await page.waitForSelector('[data-testid="map-screen"]');
  await page.evaluate(() => {
    window.__mapCaptureOpens = 0;
    const el = document.querySelector('[data-testid="map-capture-input"]');
    el?.addEventListener("click", () => {
      window.__mapCaptureOpens = (window.__mapCaptureOpens || 0) + 1;
    });
  });
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null),
    page.locator('[data-testid="map-screen"] [data-footer-action="camera"]').click(),
  ]);
  if (chooser) await chooser.setFiles([]);
  const opens = await page.evaluate(() => window.__mapCaptureOpens ?? 0);
  if (opens !== 1 && !chooser) {
    throw new Error(`${label}: Karten-Footer-Kamera öffnete capture ${opens}x, kein Filechooser`);
  }
}

async function assertMapDeepLinkBack(page, label, vacationId) {
  await page.evaluate(() => {
    sessionStorage.removeItem("vacrecap-map-from-trip");
    sessionStorage.removeItem("vacrecap-map-from-trip-at");
  });
  await page.goto(`./#/urlaub/${vacationId}/karte`);
  await page.waitForSelector('[data-testid="map-screen"]');
  await page.click('[data-testid="map-screen"] [data-action="back"]');
  await page.waitForFunction(
    (vid) => location.hash === `#/urlaub/${vid}`,
    vacationId,
    { timeout: 15000 }
  );
  await page.waitForSelector(".trip-header__title");
}

async function assertStaleNavOverviewFlag(page, label, vacationId) {
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.evaluate(() => {
    sessionStorage.setItem("vacrecap-nav-from-overview", "1");
  });
  await page.reload();
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.locator('.link-btn--back[data-action="back"]').click();
  await page.waitForFunction(() => location.hash.includes("/urlaube"), null, { timeout: 15000 });
  const title = await page.locator(".top-bar__title").textContent();
  if (title?.trim() !== "Reisen") {
    throw new Error(`${label}: ‹ Reisen nach Direktlink nicht zur Übersicht (${title})`);
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

  page.on("pageerror", (err) => {
    void page.evaluate((msg) => {
      window.__lastError = msg;
    }, String(err));
  });

  const vacationId = await seedTripWithPlace(page);
  await assertPlaceCardCamera(page, "375x667");
  await assertMapFooterCamera(page, "375x667", vacationId);
  await assertMapDeepLinkBack(page, "375x667", vacationId);
  await assertStaleNavOverviewFlag(page, "375x667", vacationId);

  await ctx.close();
  await browser.close();
  server.close();
  console.log("Playwright 5e tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
