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

async function mockKeyboard(page) {
  await page.evaluate(() => {
    const mockHeight = window.innerHeight - 291;
    const vv = window.visualViewport;
    Object.defineProperty(vv, "height", {
      configurable: true,
      get: () => mockHeight,
    });
    Object.defineProperty(vv, "offsetTop", {
      configurable: true,
      get: () => 0,
    });
    document.documentElement.style.setProperty("--kb", "291px");
    document.querySelector(".sheet--note-bottom")?.classList.add("sheet--note-kb");
    vv.dispatchEvent(new Event("resize"));
  });
}

async function seedTrip(page) {
  await page.goto("./");
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', "Paris");
  await page.click('[data-action="pick-dates"]');
  await page.waitForSelector(".calendar-day[data-date='2026-10-25']");
  await page.click('.calendar-day[data-date="2026-10-25"]');
  await page.click('.calendar-day[data-date="2026-10-28"]');
  await page.waitForFunction(() => !document.querySelector('button[data-action="apply"]')?.disabled);
  await page.click('button[data-action="apply"]');
  await page.click('[data-preset="stadt"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  return await page.locator(".screen--trip").getAttribute("data-vacation-id");
}

async function assertNoteSaveAboveKb(page, label) {
  await page.locator('[data-footer-action="note"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await mockKeyboard(page);
  await page.locator('[data-role="text"]').focus();
  const layout = await page.evaluate(() => {
    const kb =
      parseInt(getComputedStyle(document.documentElement).getPropertyValue("--kb"), 10) || 0;
    const vvH = window.visualViewport?.height ?? window.innerHeight;
    const kbTop = window.innerHeight - kb;
    const save = document.querySelector('[data-testid="note-sheet"] [data-action="save"]');
    const r = save?.getBoundingClientRect();
    return { kbTop, saveBottom: r?.bottom ?? 0, saveTop: r?.top ?? 0, vvH };
  });
  if (layout.saveBottom > layout.kbTop + 4) {
    throw new Error(
      `${label}: Speichern unter Tastatur (${layout.saveBottom} > ${layout.kbTop})`
    );
  }
  if (layout.saveTop < 80) {
    throw new Error(`${label}: Speichern nicht sichtbar (top ${layout.saveTop})`);
  }
  await page.locator('[data-testid="note-sheet"] [data-action="cancel"]').click();
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);
}

async function assertChipsFill(page, label, days) {
  const widths = await page.evaluate(() => {
    const row = document.querySelector(".day-chips");
    const chips = [...document.querySelectorAll(".day-chip")];
    const w = row?.clientWidth ?? 0;
    return {
      row: w,
      fill: row?.classList.contains("day-chips--fill"),
      chips: chips.map((c) => c.getBoundingClientRect().width),
    };
  });
  if (days <= 4) {
    if (!widths.fill) {
      throw new Error(`${label}: day-chips--fill fehlt bei ${days} Tagen`);
    }
    const maxDelta = Math.max(...widths.chips) - Math.min(...widths.chips);
    if (maxDelta > 3) {
      throw new Error(`${label}: Chips nicht gleich breit (Δ ${maxDelta}px)`);
    }
    const used = widths.chips.reduce((a, b) => a + b, 0) + 8 * (widths.chips.length - 1);
    if (used < widths.row - 6) {
      throw new Error(`${label}: Chips nutzen nicht die volle Breite (${used}/${widths.row})`);
    }
  }
}

async function assertFormNameVisible(page, label) {
  await page.goto("./");
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', "Test");
  await page.click('[data-action="pick-dates"]');
  await page.click(".calendar-day--today");
  await page.click(".calendar-day--today");
  await page.click('button[data-action="apply"]');
  const nameInput = page.locator('[data-role="name-input"]');
  await nameInput.focus();
  await mockKeyboard(page);
  const vis = await nameInput.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const kb =
      parseInt(getComputedStyle(document.documentElement).getPropertyValue("--kb"), 10) || 0;
    const kbTop = window.innerHeight - kb;
    const footer = document.querySelector(".form-footer");
    const fr = footer?.getBoundingClientRect();
    return {
      fieldBottom: r.bottom,
      kbTop,
      footerTop: fr?.top ?? 0,
      fieldTop: r.top,
    };
  });
  if (vis.fieldBottom > vis.footerTop - 4) {
    throw new Error(`${label}: +Name von Footer verdeckt (${JSON.stringify(vis)})`);
  }
  if (vis.fieldBottom > vis.kbTop - 4) {
    throw new Error(`${label}: +Name unter Tastatur (${JSON.stringify(vis)})`);
  }
}

async function assertBackNoDup(page, label) {
  const vacationId = await seedTrip(page);
  await page.click('[data-action="back"]');
  await page.waitForSelector(".top-bar__title");
  await page.locator(`[data-vacation-id="${vacationId}"]`).click();
  await page.waitForSelector('[data-testid="trip-content"]');
  const h0 = await page.evaluate(() => history.length);
  await page.click('[data-action="back"]');
  await page.waitForSelector(".top-bar__title");
  const h1 = await page.evaluate(() => history.length);
  await page.evaluate(() => history.back());
  await page.waitForTimeout(200);
  const hash = await page.evaluate(() => location.hash);
  if (hash.includes("/urlaub/")) {
    throw new Error(`${label}: Zweites Zurück landete in Reise (${hash})`);
  }
  if (h1 > h0) {
    throw new Error(`${label}: Zurück verlängerte History (${h0}→${h1})`);
  }
}

async function assertOfflineBackup(page) {
  await page.goto("./");
  const swText = await page.evaluate(async () => {
    const r = await fetch("./sw.js");
    return await r.text();
  });
  if (!swText.includes("backup-service.js") || !swText.includes("zip-builder.js")) {
    throw new Error("SW precache list missing backup modules");
  }
  await page.goto("./");
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.register("./sw.js");
    await new Promise((resolve) => {
      const sw = reg.installing || reg.waiting || reg.active;
      if (!sw) {
        resolve();
        return;
      }
      if (sw.state === "activated") {
        resolve();
        return;
      }
      sw.addEventListener("statechange", () => {
        if (sw.state === "activated") resolve();
      });
    });
  });
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    if (!keys.includes("vacrecap-v23")) return false;
    const cache = await caches.open("vacrecap-v23");
    const hit = await cache.match("./js/backup-service.js");
    const zip = await cache.match("./js/zip-builder.js");
    return Boolean(hit && zip);
  });
  if (!cached) throw new Error("Backup-Module nicht im SW-Precache");
}

async function runSuite(label, viewport, { baseUrl, browser }) {
  const ctx = await browser.newContext({
    baseURL: baseUrl,
    viewport,
    ...devices[label.includes("iPhone") ? "iPhone 8" : "Pixel 5"],
  });
  await ctx.addInitScript(leafMock());
  const page = await ctx.newPage();

  const title = await page.goto("./").then(() => page.locator(".top-bar__title").textContent());
  if (title?.trim() !== "Reisen") throw new Error(`${label}: Titel nicht Reisen`);

  const vacationId = await seedTrip(page);
  await page.goto(`./#/urlaub/${vacationId}`);
  await assertChipsFill(page, label, 4);
  await assertNoteSaveAboveKb(page, label);

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
  await assertFormNameVisible(page, "390x844");
  await assertBackNoDup(page, "390x844");
  await assertOfflineBackup(page);
  await ctx.close();

  await browser.close();
  server.close();
  console.log("Playwright 5c tests OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
