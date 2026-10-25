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

async function assertFooterCenter(page, label) {
  const m = await page.locator(".trip-footer").evaluate((footer) => {
    const fr = footer.getBoundingClientRect();
    const icon = footer.querySelector('[data-testid="footer-icon"]');
    const ir = icon.getBoundingClientRect();
    const contentBottom = fr.bottom - (parseFloat(getComputedStyle(footer).paddingBottom) || 0);
    const mid = (fr.top + contentBottom) / 2;
    return { mid, cy: ir.top + ir.height / 2, h: fr.height - (parseFloat(getComputedStyle(footer).paddingBottom) || 0) };
  });
  if (Math.abs(m.mid - m.cy) > 0.5) {
    throw new Error(`${label}: Footer-Icon Abweichung ${Math.abs(m.mid - m.cy)}px`);
  }
  if (Math.abs(m.h - 52) > 0.5) {
    throw new Error(`${label}: Footer-Höhe ${m.h}px statt 52px`);
  }
}

async function runSuite(label, viewport, { baseUrl, browser }) {
  const ctx = await browser.newContext({
    baseURL: baseUrl,
    viewport,
    ...devices[label.includes("iPhone") ? "iPhone 8" : "Pixel 5"],
  });
  await ctx.addInitScript(leafMock());
  const page = await ctx.newPage();

  await page.goto("./");
  const title = await page.locator(".top-bar__title").textContent();
  if (title?.trim() !== "Reisen") {
    throw new Error(`${label}: Übersicht-Titel ist nicht „Reisen“ (${title})`);
  }

  const vacationId = await seedTrip(page);
  await page.goto(`./#/urlaub/${vacationId}`);
  await assertFooterCenter(page, label);

  if (await page.locator('[data-action="calendar"]').count()) {
    throw new Error(`${label}: Kalender-Icon noch vorhanden`);
  }

  const backLabel = await page.locator('[data-action="back"] span').textContent();
  if (backLabel?.trim() !== "Reisen") {
    throw new Error(`${label}: Zurück-Label falsch (${backLabel})`);
  }

  const hBefore = await page.evaluate(() => history.length);
  await page.click('[data-action="back"]');
  await page.waitForSelector(".top-bar__title");
  const hAfter = await page.evaluate(() => history.length);
  if (hAfter > hBefore) {
    throw new Error(`${label}: Zurück mit replace verlängert History (${hBefore}→${hAfter})`);
  }

  await page.goto(`./#/urlaub/${vacationId}`);
  await page.locator('[data-footer-action="note"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.evaluate(() => {
    const mockHeight = window.innerHeight - 291;
    const vv = window.visualViewport;
    window._vvOrig = { height: vv.height, offsetTop: vv.offsetTop };
    Object.defineProperty(window.visualViewport, "height", {
      configurable: true,
      get: () => mockHeight,
    });
    Object.defineProperty(window.visualViewport, "offsetTop", {
      configurable: true,
      get: () => 0,
    });
    window.visualViewport.dispatchEvent(new Event("resize"));
  });
  await page.waitForFunction(() => {
    const kb = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--kb"), 10);
    return kb >= 280;
  });
  const saveVisible = await page.locator('[data-action="save"]').isVisible();
  const sheetBox = await page.locator(".sheet--note-bottom").boundingBox();
  const innerH = await page.evaluate(() => window.innerHeight);
  if (!saveVisible || !sheetBox || sheetBox.bottom > innerH - 250) {
    throw new Error(`${label}: Notiz-Sheet/ Speichern nicht über Tastatur`);
  }
  await page.click('[data-action="cancel"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);

  await ctx.close();
}

async function main() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  await runSuite("iPhone", { width: 375, height: 667 }, { baseUrl, browser });
  await runSuite("Android", { width: 360, height: 740 }, { baseUrl, browser });
  await browser.close();
  server.close();
  console.log("Playwright 5a tests OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
