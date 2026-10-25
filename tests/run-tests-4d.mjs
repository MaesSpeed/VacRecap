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
  ".jpg": "image/jpeg",
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

function leafMock() {
  return () => {
    window.L = {
      map: () => ({
        remove: () => {},
        invalidateSize: () => {},
        setView: () => {},
        fitBounds: () => {},
        closePopup: () => {},
      }),
      tileLayer: () => ({ addTo: () => ({ on: () => {} }), on: () => {} }),
      layerGroup: () => ({ addTo: () => {}, clearLayers: () => {} }),
      control: {
        attribution: () => ({
          addAttribution: () => ({ addTo: () => {} }),
        }),
      },
      divIcon: (o) => o,
      marker: () => ({
        addTo: () => {},
        bindPopup: () => {},
        on: () => {},
        getPopup: () => ({ getElement: () => null }),
      }),
      polyline: () => ({ addTo: () => {} }),
      latLngBounds: () => ({}),
    };
  };
}

async function seedTrip(page) {
  await page.goto("./");
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', "Paris");
  await page.click('[data-action="pick-dates"]');
  await page.waitForSelector(".calendar-day[data-date='2026-10-25']");
  await page.click('.calendar-day[data-date="2026-10-25"]');
  await page.click('.calendar-day[data-date="2026-10-25"]');
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

async function putPlace(page, vacationId, name) {
  await page.evaluate(
    async ({ vacationId, name }) => {
      const { putPlace } = await import("./js/db.js");
      const { createPlace } = await import("./js/places.js");
      await putPlace(
        createPlace({
          vacationId,
          day: "2026-10-25",
          ts: Date.now(),
          lat: 48.86,
          lng: 2.33,
          name,
        })
      );
    },
    { vacationId, name }
  );
}

async function historyLen(page) {
  return page.evaluate(() => history.length);
}

async function assertFooterVerticalCenter(page, deviceName, width) {
  await page.setViewportSize({ width, height: 844 });
  const m = await page.locator(".trip-footer").evaluate((footer) => {
    const fr = footer.getBoundingClientRect();
    const icon = footer.querySelector('[data-testid="footer-icon"]');
    const ir = icon.getBoundingClientRect();
    const contentBottom = fr.bottom - (parseFloat(getComputedStyle(footer).paddingBottom) || 0);
    const contentTop = fr.top + (parseFloat(getComputedStyle(footer).paddingTop) || 0);
    const mid = (contentTop + contentBottom) / 2;
    return { mid, cy: ir.top + ir.height / 2 };
  });
  if (Math.abs(m.mid - m.cy) > 0.5) {
    throw new Error(`${deviceName} ${width}px: Footer-Icon nicht mittig (${m.cy} vs ${m.mid})`);
  }
}

async function runSuite(deviceName, { baseUrl, browser }) {
  const ctx = await browser.newContext({
    baseURL: baseUrl,
    ...devices[deviceName],
    permissions: ["geolocation"],
    geolocation: { latitude: 48.86, longitude: 2.33 },
  });
  await ctx.addInitScript(leafMock());
  const page = await ctx.newPage();
  const vacationId = await seedTrip(page);
  await putPlace(page, vacationId, "Louvre");
  await page.reload();
  await page.waitForSelector(".oc--selected");

  const h0 = await historyLen(page);

  await page.locator('[data-footer-action="note"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.fill('[data-role="text"]', "Test A");
  await page.click('[data-action="save"]');
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="app-toast"]');
    return t && /Notiz gespeichert/.test(t.innerText);
  });
  await page.waitForSelector('[data-action="edit-note"]', { timeout: 15000 });

  await page.goBack();
  if (await page.locator('[data-testid="confirm-discard-note"]').count()) {
    throw new Error(`${deviceName}: Geister-Dialog nach gespeicherter Notiz`);
  }
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.waitForSelector('[data-action="edit-note"]');

  await page.locator('[data-action="edit-note"]').first().click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.fill('[data-role="text"]', "Test B");
  await page.click('[data-action="save"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);
  await page.goBack();
  if (await page.locator('[data-testid="confirm-discard-note"]').count()) {
    throw new Error(`${deviceName}: Geister-Dialog nach bearbeiteter Notiz`);
  }
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="trip-content"]');

  for (let i = 0; i < 10; i++) {
    await page.locator('[data-footer-action="note"]').click();
    await page.waitForSelector('[data-testid="note-sheet"]');
    await page.click('[data-action="cancel"]');
    await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);
  }
  const h1 = await historyLen(page);
  if (h1 > h0 + 2) {
    throw new Error(`${deviceName}: History wuchs (${h0} → ${h1})`);
  }

  await page.locator('[data-footer-action="note"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.click('[data-action="cancel"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);
  await page.goto(`./#/urlaub/${vacationId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.waitForSelector(".oc[data-place-id]");

  await putPlace(page, vacationId, "Museum");
  await page.reload();
  await page.waitForSelector(".oc[data-place-id]");
  const places = page.locator(".oc[data-place-id]");
  const count = await places.count();
  if (count < 2) throw new Error(`${deviceName}: Zweite Karte fehlt`);

  await page.locator('[data-footer-action="note"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.click('[data-action="change-place"]');
  await page.waitForSelector(".sheet--note-places");
  await page.locator(".sheet--note-places button[data-place-id]").last().click();
  await page.fill('[data-role="text"]', "Manuell");
  const beforePlaces = await page.locator(".oc[data-place-id]").count();
  await page.click('[data-action="save"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);
  const afterPlaces = await page.locator(".oc[data-place-id]").count();
  if (afterPlaces > beforePlaces) {
    throw new Error(`${deviceName}: GPS legte trotz Ändern neue Karte an`);
  }

  await page.evaluate(() => {
    const input = document.querySelector('[data-role="capture-input"]');
    window.__captureInputOpens = 0;
    input?.addEventListener("click", () => {
      window.__captureInputOpens = (window.__captureInputOpens || 0) + 1;
    });
  });
  for (const ms of [80, 150, 250, 350]) {
    await page.evaluate(() => {
      window.__captureInputOpens = 0;
    });
    const cam = page.locator('[data-footer-action="camera"]');
    await cam.click();
    await page.waitForTimeout(ms);
    await page.evaluate(() => {
      document.querySelector('[data-footer-action="camera"]')?.click();
    });
    const opens = await page.evaluate(() => window.__captureInputOpens ?? 0);
    if (opens > 1) {
      throw new Error(`${deviceName}: Doppeltipp ${ms}ms öffnete Kamera-Input mehrfach (${opens})`);
    }
    if (await page.locator('[data-testid="camera-sheet"]').count()) {
      throw new Error(`${deviceName}: Kamera-Sheet soll entfernt sein`);
    }
    await page.waitForTimeout(Math.max(0, 460 - ms));
  }

  const buf = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 60;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#aa4422";
    ctx.fillRect(0, 0, 80, 60);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.locator('[data-role="capture-input"]').setInputFiles({
    name: "v.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from(buf),
  });
  await page.waitForSelector(".tile[data-media-id]");
  await page.locator(".tile[data-media-id]").first().click();
  await page.waitForSelector(".media-viewer");
  await page.click(".media-viewer__delete");
  await page.waitForSelector('[data-testid="confirm-delete-media"]');
  const z = await page.locator(".overlay-confirm-layer--top").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { z: getComputedStyle(el).zIndex, visible: r.width > 0 && r.height > 0 };
  });
  if (Number(z.z) < 250 || !z.visible) {
    throw new Error(`${deviceName}: Löschdialog nicht über Viewer`);
  }
  await page.locator(".overlay-confirm-layer--top [data-action='cancel']").click();
  await page.waitForFunction(() => !document.querySelector("[data-confirm-layer]"));
  await page.click(".media-viewer__back");
  await page.waitForSelector(".media-viewer", { state: "hidden" });

  const w = deviceName.includes("iPhone") ? 375 : 360;
  await assertFooterVerticalCenter(page, deviceName, w);
  if (deviceName.includes("Pixel")) {
    await assertFooterVerticalCenter(page, deviceName, 390);
  }

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
    geolocation: { latitude: 48.86, longitude: 2.33 },
  });
  await ctx.addInitScript(leafMock());
  const page = await ctx.newPage();
  const vacationId = await seedTrip(page);
  await putPlace(page, vacationId, "Louvre");
  await page.reload();

  await page.locator('[data-footer-action="note"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.screenshot({
    path: path.join(screenshotsDir, "34-notiz-sheet-neu-390.png"),
    fullPage: true,
  });
  await page.fill('[data-role="text"]', "Screenshot");
  await page.click('[data-action="save"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);

  await page.locator('[data-action="edit-note"]').first().click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.screenshot({
    path: path.join(screenshotsDir, "34-notiz-sheet-bearbeiten-390.png"),
    fullPage: true,
  });
  await page.click('[data-action="cancel"]');

  const buf = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 60;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#2244aa";
    ctx.fillRect(0, 0, 80, 60);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.locator('[data-role="capture-input"]').setInputFiles({
    name: "s.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from(buf),
  });
  await page.waitForSelector(".tile[data-media-id]");
  await page.locator(".tile[data-media-id]").first().click();
  await page.click(".media-viewer__delete");
  await page.waitForSelector('[data-testid="confirm-delete-media"]');
  await page.screenshot({
    path: path.join(screenshotsDir, "34-viewer-loeschdialog-390.png"),
    fullPage: true,
  });
  await page.click('[data-action="cancel"]');
  await page.click(".media-viewer__back");

  await page.screenshot({
    path: path.join(screenshotsDir, "34-footer-390.png"),
    clip: { x: 0, y: 760, width: 390, height: 84 },
  });

  await ctx.close();
  await browser.close();
  server.close();
  console.log("Playwright 4d tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
