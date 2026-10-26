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
  const vacationId = await page.locator(".screen--trip").getAttribute("data-vacation-id");
  return vacationId;
}

async function openMediathekCancel(page, vacationId) {
  await page.evaluate(
    async ({ vacationId }) => {
      const { todayIso } = await import("./js/utils.js");
      const blob = await new Promise((resolve) => {
        const c = document.createElement("canvas");
        c.width = 40;
        c.height = 30;
        c.getContext("2d").fillStyle = "#5588aa";
        c.getContext("2d").fillRect(0, 0, 40, 30);
        c.toBlob((b) => resolve(b), "image/jpeg", 0.9);
      });
      const file = new File([blob], "m.jpg", { type: "image/jpeg" });
      const { createMediathekSession } = await import("./js/mediathek-session.js");
      const { navigate } = await import("./js/router.js");
      createMediathekSession({
        vacationId,
        day: todayIso(),
        selectedPlaceId: null,
        files: [file],
      });
      navigate({ name: "urlaub-mediathek", id: vacationId }, { replace: true });
    },
    { vacationId }
  );
  await page.waitForSelector('[data-testid="mediathek-screen"]');
  await page.click('[data-action="cancel"]');
  await page.waitForSelector('[data-testid="trip-content"]');
}

async function assertMediathekBackOnce(page, label, vacationId) {
  await openMediathekCancel(page, vacationId);
  await page.click('[data-action="back"]');
  await page.waitForSelector('[data-action="new"]', { timeout: 8000 });
  const onTrip = await page.evaluate(() => Boolean(document.querySelector('[data-testid="trip-content"]')));
  if (onTrip) {
    throw new Error(`${label}: Reisen brauchte mehr als einen Tipp (noch auf Reise)`);
  }
}

async function assertMapSingleHistory(page, label, vacationId) {
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="trip-content"]');
  await openMediathekCancel(page, vacationId);
  await page.click('[data-action="map"]');
  await page.waitForSelector('[data-testid="map-screen"]');
  await page.goBack();
  await page.waitForSelector('[data-testid="trip-content"]', { timeout: 5000 });
  const stillMap = await page.evaluate(() => window.location.hash.includes("/karte"));
  if (stillMap) {
    throw new Error(`${label}: Ein Zurück reichte nicht (doppelte Karten-Navigation)`);
  }
}

async function assertShareSnackTimer(page, label) {
  const jpeg = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 60;
    canvas.height = 50;
    canvas.getContext("2d").fillStyle = "#669933";
    canvas.getContext("2d").fillRect(0, 0, 60, 50);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.locator('[data-testid="capture-photo-input"]').setInputFiles({
    name: "t.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from(jpeg),
  });
  await page.waitForSelector(".tile[data-media-id]");
  await page.locator(".tile[data-media-id]").first().click();
  await page.waitForSelector('[data-testid="media-viewer"]');
  await page.evaluate(() => {
    navigator.canShare = () => true;
    navigator.share = () => new Promise((r) => setTimeout(r, 2500));
  });
  const save = page.locator('[data-testid="media-viewer-save"]');
  await save.click();
  await page.waitForTimeout(400);
  await save.click();
  await page.waitForTimeout(1200);
  const visible = await page.locator('[data-testid="media-viewer-share-snack"]').isVisible();
  if (!visible) {
    throw new Error(`${label}: Snackbar nach Doppeltipp zu früh weg`);
  }
}

async function assertDownloadSnackText(page, label) {
  await page.evaluate(() => {
    window.__downloadClicked = false;
    navigator.canShare = () => false;
    const origCreate = document.createElement.bind(document);
    document.createElement = function (tag, ...rest) {
      const el = origCreate(tag, ...rest);
      if (tag === "a") el.click = () => { window.__downloadClicked = true; };
      return el;
    };
  });
  await page.locator('[data-testid="media-viewer-save"]').click();
  await page.waitForFunction(() => window.__downloadClicked === true);
  const text = await page.locator('[data-testid="media-viewer-share-snack"]').innerText();
  if (!text.includes("heruntergeladen")) {
    throw new Error(`${label}: Download-Snackbar falsch (${text})`);
  }
}

async function assertNotAllowedDownloads(page, label) {
  await page.evaluate(() => {
    window.__downloadClicked = false;
    navigator.canShare = () => true;
    navigator.share = () =>
      Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    const origCreate = document.createElement.bind(document);
    document.createElement = function (tag, ...rest) {
      const el = origCreate(tag, ...rest);
      if (tag === "a") el.click = () => { window.__downloadClicked = true; };
      return el;
    };
  });
  await page.locator('[data-testid="media-viewer-save"]').click();
  await page.waitForFunction(() => window.__downloadClicked === true);
  const text = await page.locator('[data-testid="media-viewer-share-snack"]').innerText();
  if (!text.includes("heruntergeladen")) {
    throw new Error(`${label}: NotAllowed-Fallback Snackbar (${text})`);
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
  await assertMediathekBackOnce(page, "B15-1-back", vacationId);
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="trip-content"]');
  await assertMapSingleHistory(page, "B15-1-map", vacationId);

  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="trip-content"]');
  await assertShareSnackTimer(page, "B15-2");
  await assertDownloadSnackText(page, "B15-3");
  await assertNotAllowedDownloads(page, "B15-4");

  await ctx.close();
  await browser.close();
  server.close();
  console.log("Playwright 5k tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
