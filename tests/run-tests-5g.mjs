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

async function makeJpeg(page, seed) {
  const bytes = await page.evaluate(async (s) => {
    const canvas = document.createElement("canvas");
    canvas.width = 80 + s;
    canvas.height = 60 + s;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = `hsl(${s * 40}, 70%, 50%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, seed);
  return Buffer.from(bytes);
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
  await page.locator('[data-footer-action="pin"]').click();
  await page.waitForFunction(() => {
    const toast = document.querySelector('[data-testid="app-toast"]');
    return !toast || !toast.classList.contains("toast--visible");
  });
  return vacationId;
}

async function assertVideoHintDelayed(page, label) {
  await page.evaluate(() => localStorage.removeItem("vacrecap-video-longpress-hint"));
  const file = { name: "hint.jpg", mimeType: "image/jpeg", buffer: await makeJpeg(page, 2) };
  const chooser = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
  await page.locator('[data-footer-action="camera"]').click();
  const ch = await chooser;
  if (ch) await ch.setFiles(file);
  else await page.locator('[data-testid="capture-photo-input"]').setInputFiles(file);
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="app-toast"]')?.textContent ?? "";
    return t.includes("Foto gespeichert") || t.includes("hinzugefügt") || t.includes("«");
  });
  const early = await page.evaluate(() =>
    document.querySelector('[data-testid="app-toast"]')?.textContent?.includes("Lange drücken")
  );
  if (early) {
    throw new Error(`${label}: Video-Hinweis ersetzt Foto-Toast zu früh`);
  }
  await page.waitForFunction(
    () => document.querySelector('[data-testid="app-toast"]')?.textContent?.includes("Lange drücken = Video"),
    null,
    { timeout: 5000 }
  );
}

async function assertSoftMarkerUnderHard(page, label, vacationId) {
  await page.route("**/routing.openstreetmap.de/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"routes":[]}' })
  );
  await page.evaluate(async () => {
    const { setMapRoutesEnabled } = await import("./js/settings-store.js");
    await setMapRoutesEnabled(false);
  });
  await page.evaluate(
    async ({ vacationId, lat, lng }) => {
      const { createPlace } = await import("./js/places.js");
      const { putPlace } = await import("./js/db.js");
      const { todayIso } = await import("./js/utils.js");
      const day = todayIso();
      await putPlace(
        createPlace({
          vacationId,
          day,
          ts: Date.now() - 500,
          lat,
          lng,
          name: "Weich",
          soft: true,
          source: "open",
        })
      );
    },
    { vacationId, lat: 48.8566, lng: 2.3522 }
  );
  await page.click('[data-action="map"]');
  await page.waitForSelector('[data-testid="map-screen"]');
  await page.waitForTimeout(800);
  const meta = await page.evaluate(() => {
    const map = window.__vacrecapMap;
    if (!map) return { ok: false, reason: "keine Karte" };
    let soft = null;
    let hard = null;
    map.eachLayer((layer) => {
      if (!layer.getLatLng || !layer.options) return;
      const el = layer.getElement?.();
      const softEl = el?.querySelector?.(".map-marker--soft");
      const hardEl = el?.querySelector?.(".map-marker--hard");
      if (softEl) soft = { interactive: layer.options.interactive, z: layer.options.zIndexOffset, pane: layer.options.pane };
      if (hardEl) hard = { interactive: layer.options.interactive, pane: layer.options.pane };
    });
    return { soft, hard };
  });
  if (!meta.soft || !meta.hard) {
    throw new Error(`${label}: weicher/harter Marker fehlt (${JSON.stringify(meta)})`);
  }
  if (meta.soft.interactive !== false) {
    throw new Error(`${label}: weicher Punkt soll nicht klickbar sein`);
  }
  if (meta.soft.pane !== "softPointPane") {
    throw new Error(`${label}: weicher Punkt nicht im softPointPane`);
  }
  await page.evaluate(() => {
    const map = window.__vacrecapMap;
    const hard = [];
    map.eachLayer((layer) => {
      const el = layer.getElement?.();
      if (el?.querySelector?.(".map-marker--hard")) hard.push(layer);
    });
    if (hard[0]) hard[0].openPopup();
  });
  await page.waitForSelector(".map-popup__btn");
}

async function assertNoGpsToastText(page, label, vacationId) {
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.evaluate(async () => {
    navigator.geolocation.getCurrentPosition = (_ok, err) => {
      err?.({ code: 1, PERMISSION_DENIED: 1, message: "denied" });
    };
    const { resetCapturePositionCache } = await import("./js/geo.js");
    const { resetCaptureGpsPrefetch } = await import("./js/capture-gps-prefetch.js");
    resetCapturePositionCache();
    resetCaptureGpsPrefetch();
  });
  const file = { name: "nogps.jpg", mimeType: "image/jpeg", buffer: await makeJpeg(page, 8) };
  const chooser = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
  await page.locator('[data-footer-action="camera"]').click();
  const ch = await chooser;
  if (ch) await ch.setFiles(file);
  else await page.locator('[data-testid="capture-photo-input"]').setInputFiles(file);
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="app-toast"]')?.textContent ?? "";
    return t.includes("Standort ungenau");
  });
  const text = await page.evaluate(() => document.querySelector('[data-testid="app-toast"]')?.textContent ?? "");
  if (text.includes("gespeichert")) {
    throw new Error(`${label}: Standort-Toast enthält 'gespeichert' (${text})`);
  }
  if (!text.includes("Standort ungenau") || !/Foto bei «/.test(text)) {
    throw new Error(`${label}: Standort-Text unerwartet (${text})`);
  }
  const lineCount = await page.evaluate(() => {
    const body = document.querySelector('[data-testid="app-toast"] .toast__body');
    return body?.querySelectorAll(".toast__line").length ?? 0;
  });
  if (lineCount > 2) {
    throw new Error(`${label}: Kein-GPS-Toast zu viele Zeilen (${lineCount})`);
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
  await assertVideoHintDelayed(page, "B11-1");
  await assertNoGpsToastText(page, "B11-3", vacationId);
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="trip-content"]');
  await assertSoftMarkerUnderHard(page, "B11-2", vacationId);

  await ctx.close();
  await browser.close();
  server.close();
  console.log("Playwright 5g tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
