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

async function galleryFileBuffer(page) {
  return page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#336699";
    ctx.fillRect(0, 0, 64, 48);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
}

async function openMediathekCancel(page, vacationId) {
  await page.evaluate(
    async ({ vacationId }) => {
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
        day: "2026-10-25",
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

async function runSuite(deviceName, viewport, { baseUrl, browser }) {
  const ctx = await browser.newContext({
    baseURL: baseUrl,
    viewport,
    ...devices[deviceName.includes("iPhone") ? "iPhone 8" : "Pixel 5"],
    permissions: ["geolocation"],
  });
  await ctx.addInitScript(leafMock());
  const page = await ctx.newPage();
  const vacationId = await seedTrip(page);
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="trip-content"]');

  const h0 = await page.evaluate(() => history.length);
  for (let i = 0; i < 3; i++) {
    await openMediathekCancel(page, vacationId);
  }
  const h1 = await page.evaluate(() => history.length);
  if (h1 > h0 + 2) {
    throw new Error(
      `${deviceName}: History nach 3× Mediathek ${h0}→${h1} (erwartet ≤${h0 + 2})`
    );
  }

  await page.goBack();
  await page.waitForTimeout(200);
  const onMediathek = await page.evaluate(() => window.location.hash.includes("/mediathek"));
  if (onMediathek) {
    throw new Error(`${deviceName}: Zurück landet noch auf Mediathek`);
  }

  const buf = await galleryFileBuffer(page);
  await page.locator('[data-role="capture-input"]').setInputFiles({
    name: "p.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from(buf),
  });
  await page.waitForSelector(".tile[data-media-id]");
  await page.locator(".tile[data-media-id]").first().click();
  await page.waitForSelector('[data-testid="media-viewer"]');
  const stroke = await page.locator(".media-viewer__back path").evaluate((p) => {
    const btn = p.closest(".media-viewer__back");
    return {
      stroke: getComputedStyle(p).stroke || p.getAttribute("stroke"),
      color: getComputedStyle(btn).color,
    };
  });
  if (stroke.color !== "rgb(255, 255, 255)" && stroke.stroke !== "rgb(255, 255, 255)") {
    throw new Error(`${deviceName}: Viewer-Zurück nicht weiß (${JSON.stringify(stroke)})`);
  }
  const backBox = await page.locator('[data-testid="media-viewer-close"]').boundingBox();
  if (!backBox || backBox.width < 44 || backBox.height < 44) {
    throw new Error(`${deviceName}: Viewer-Zurück Tippfläche < 44px`);
  }
  await page.click('[data-testid="media-viewer-close"]');
  await page.waitForSelector('[data-testid="media-viewer"]', { state: "hidden" });

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
    const box = await cam.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    const opens = await page.evaluate(() => window.__captureInputOpens ?? 0);
    if (opens > 1) {
      throw new Error(`${deviceName}: Kamera-Doppeltipp ${ms}ms öffnete Input mehrfach (${opens})`);
    }
    await page.waitForTimeout(Math.max(0, 460 - ms));
  }

  await ctx.close();
}

async function main() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();

  await runSuite("iPhone", { width: 375, height: 667 }, { baseUrl, browser });
  await runSuite("Android", { width: 360, height: 740 }, { baseUrl, browser });

  await browser.close();
  server.close();
  console.log("Playwright 4e tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
