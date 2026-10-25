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
      control: { attribution: () => ({ addAttribution: () => ({ addTo: () => {} }) }) },
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
  await page.waitForFunction(() => !document.querySelector('button[data-action="apply"]')?.disabled);
  await page.click('button[data-action="apply"]');
  await page.click('[data-preset="stadt"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  return await page.locator(".screen--trip").getAttribute("data-vacation-id");
}

async function assertCalendarNewTrip(page, label) {
  await page.goto("./");
  await page.click('[data-action="new"]');
  await page.click('[data-action="pick-dates"]');
  await page.waitForSelector(".calendar-month__title");
  const firstMonth = await page.locator(".calendar-month__title").first().textContent();
  if (firstMonth?.includes("2025")) {
    throw new Error(`${label}: Kalender startet in der Vergangenheit (${firstMonth})`);
  }
  const today = await page.locator(".calendar-day--today[data-date='2026-10-25']");
  if (!(await today.count())) {
    throw new Error(`${label}: Heute (25.10.2026) nicht markiert`);
  }
  await page.click(".calendar-day--today");
  const startLabel = await page.locator('[data-role="start-label"]').textContent();
  if (!startLabel?.includes("25.10.2026")) {
    throw new Error(`${label}: Heute-Tipp wählte falsches Datum (${startLabel})`);
  }
  await page.locator(".sheet--calendar [data-action='cancel']").click();
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);
}

async function assertToastPill(page, label) {
  await page.evaluate(async () => {
    const { showToast } = await import("./js/toast.js");
    showToast("Ort gespeichert");
  });
  await page.waitForSelector('[data-testid="app-toast"]');
  const style = await page.locator('[data-testid="app-toast"]').evaluate((el) => {
    const body = el.querySelector(".toast__body");
    const cs = getComputedStyle(el);
    const bs = body ? getComputedStyle(body) : null;
    const root = el.getBoundingClientRect();
    const mid = root.left + root.width / 2;
    const vw = window.innerWidth;
    return {
      bg: cs.backgroundColor,
      textAlign: bs?.textAlign,
      centered: Math.abs(mid - vw / 2) < 24,
    };
  });
  if (!style.bg.includes("22, 58, 120") && style.bg !== "rgb(22, 58, 120)") {
    throw new Error(`${label}: Snackbar nicht Navy (${style.bg})`);
  }
  if (style.textAlign !== "center") {
    throw new Error(`${label}: Snackbar-Text nicht zentriert`);
  }
  if (!style.centered) {
    throw new Error(`${label}: Snackbar-Pille nicht horizontal zentriert`);
  }
}

async function assertNativeCamera(page, label) {
  await page.evaluate(() => {
    window.__captureOpens = 0;
    document.querySelector('[data-role="capture-input"]')?.addEventListener("click", () => {
      window.__captureOpens = (window.__captureOpens || 0) + 1;
    });
  });
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 3000 }).catch(() => null);
  await page.locator('[data-footer-action="camera"]').click();
  const chooser = await chooserPromise;
  if (chooser) await chooser.setFiles([]);
  const opens = await page.evaluate(() => window.__captureOpens ?? 0);
  if (opens !== 1) {
    throw new Error(`${label}: Kamera-Tipp öffnete capture-input ${opens}x statt 1x`);
  }
  if (await page.locator('[data-testid="camera-sheet"]').count()) {
    throw new Error(`${label}: Kamera-Sheet noch vorhanden`);
  }
  await page.waitForTimeout(500);
}

async function assertNoteSheetGap(page, label) {
  await page.locator('[data-footer-action="note"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  const gap = await page.evaluate(() => {
    const chips = document.querySelector(".day-chips-wrap");
    const sheet = document.querySelector(".sheet--note-bottom");
    if (!chips || !sheet) return null;
    const cb = chips.getBoundingClientRect();
    const sb = sheet.getBoundingClientRect();
    return sb.top - cb.bottom;
  });
  if (gap == null || Math.abs(gap - 20) > 6) {
    throw new Error(`${label}: Notiz-Sheet-Abstand ${gap}px (Ziel ~20px)`);
  }
  await page.click('[data-action="cancel"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);
}

async function runSuite(label, viewport, { baseUrl, browser }) {
  const ctx = await browser.newContext({
    baseURL: baseUrl,
    viewport,
    ...devices[label.includes("iPhone") ? "iPhone 8" : "Pixel 5"],
  });
  await ctx.addInitScript(leafMock());
  const page = await ctx.newPage();

  await assertCalendarNewTrip(page, label);

  const vacationId = await seedTrip(page);
  await page.goto(`./#/urlaub/${vacationId}`);
  await assertToastPill(page, label);
  await assertNoteSheetGap(page, label);
  await assertNativeCamera(page, label);

  await ctx.close();
}

async function main() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  await runSuite("iPhone", { width: 375, height: 667 }, { baseUrl, browser });
  await runSuite("Android", { width: 360, height: 740 }, { baseUrl, browser });

  const ctx = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 390, height: 844 },
    ...devices["iPhone 12"],
  });
  await ctx.addInitScript(leafMock());
  const page = await ctx.newPage();
  const vacationId = await seedTrip(page);
  await page.goto(`./#/urlaub/${vacationId}`);
  await assertNoteSheetGap(page, "390x844");
  await ctx.close();

  await browser.close();
  server.close();
  console.log("Playwright 5b tests OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
