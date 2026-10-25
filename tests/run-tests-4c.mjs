import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";
import { formatDateRangeCard } from "../js/utils.js";

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

async function assertFooterVerticalCenter(page, deviceName, width) {
  await page.setViewportSize({ width, height: 844 });
  const m = await page.locator(".trip-footer").evaluate((footer) => {
    const fr = footer.getBoundingClientRect();
    const icon = footer.querySelector('[data-testid="footer-icon"]');
    const ir = icon.getBoundingClientRect();
    const contentBottom = fr.bottom - (parseFloat(getComputedStyle(footer).paddingBottom) || 0);
    const contentTop = fr.top;
    const mid = (contentTop + contentBottom) / 2;
    return { mid, cy: ir.top + ir.height / 2 };
  });
  if (Math.abs(m.mid - m.cy) > 1.5) {
    throw new Error(`${deviceName} ${width}px: Footer-Icon nicht mittig (${m.cy} vs ${m.mid})`);
  }
}

async function runSuite(deviceName, { baseUrl, browser }) {
  const ctx = await browser.newContext({
    baseURL: baseUrl,
    ...devices[deviceName],
    permissions: ["geolocation"],
  });
  await ctx.addInitScript(() => {
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
  });
  const page = await ctx.newPage();

  const cross = formatDateRangeCard("2026-12-27", "2027-01-03");
  if (!cross.includes("2026") || !cross.includes("2027")) {
    throw new Error(`Jahreswechsel Karte: ${cross}`);
  }

  const vacationId = await seedTrip(page);

  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="trip-content"]');
  for (let i = 0; i < 3; i++) {
    await page.goto(`./#/urlaub/${vacationId}/karte`);
    await page.waitForSelector(".screen--map");
    await page.goBack();
    await page.waitForSelector('[data-testid="trip-content"]');
  }
  await page.click(".link-btn--back");
  await page.waitForSelector(".top-bar__title");

  await page.goto(`./#/urlaub/${vacationId}`);
  const placesBefore = await page.locator(".oc[data-place-id]").count();
  await page.locator('[data-footer-action="note"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.click('[data-action="cancel"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);
  const placesAfter = await page.locator(".oc[data-place-id]").count();
  if (placesAfter > placesBefore) {
    throw new Error(`${deviceName}: Notiz-Abbrechen legte Karte an`);
  }

  await assertFooterVerticalCenter(page, deviceName, deviceName.includes("iPhone") ? 375 : 360);

  await ctx.setGeolocation(null);
  const buf = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 90;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#4488cc";
    ctx.fillRect(0, 0, 120, 90);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.locator('[data-role="capture-input"]').setInputFiles({
    name: "x.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from(buf),
  });
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="app-toast"]');
    return t && /Ohne Position|Foto gespeichert/.test(t.innerText);
  });

  await page.evaluate(
    async ({ vacationId }) => {
      const { putPlace } = await import("./js/db.js");
      const { createPlace } = await import("./js/places.js");
      await putPlace(
        createPlace({
          vacationId,
          day: "2026-10-25",
          ts: Date.now(),
          lat: 48.86,
          lng: 2.33,
          name: "Louvre",
        })
      );
    },
    { vacationId }
  );
  await page.reload();
  await page.waitForSelector(".oc--selected");
  const lava = await page.locator(".oc--selected").first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { boxShadow: s.boxShadow };
  });
  if (!lava.boxShadow.includes("240, 196, 132")) {
    throw new Error(`${deviceName}: Lava-Glow fehlt`);
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
  });
  await ctx.addInitScript(() => {
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
  });
  const page = await ctx.newPage();
  const vacationId = await seedTrip(page);

  await page.locator('[data-footer-action="note"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.screenshot({
    path: path.join(screenshotsDir, "33-notiz-sheet-neu-390.png"),
    fullPage: true,
  });
  await page.click('[data-action="cancel"]');

  await page.goto(`./#/urlaub/${vacationId}/bearbeiten`);
  await page.click('[data-preset="strand"]');
  await page.screenshot({
    path: path.join(screenshotsDir, "33-titelbild-strand-form-390.png"),
    fullPage: true,
  });

  await page.goto(`./#/urlaub/${vacationId}`);
  await page.evaluate(
    async ({ vacationId }) => {
      const { putPlace } = await import("./js/db.js");
      const { createPlace } = await import("./js/places.js");
      await putPlace(
        createPlace({
          vacationId,
          day: "2026-10-25",
          ts: Date.now(),
          lat: 48.86,
          lng: 2.33,
          name: "Louvre",
        })
      );
    },
    { vacationId }
  );
  await page.reload();
  await page.waitForSelector(".oc--selected");
  await page.screenshot({
    path: path.join(screenshotsDir, "33-karte-lava-390.png"),
    fullPage: true,
  });

  await page.goto("./#/urlaube");
  await page.waitForSelector("[data-vacation-id]");
  await page.screenshot({
    path: path.join(screenshotsDir, "33-uebersicht-390.png"),
    fullPage: true,
  });

  await ctx.close();
  await browser.close();
  server.close();
  console.log("Playwright 4c tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
