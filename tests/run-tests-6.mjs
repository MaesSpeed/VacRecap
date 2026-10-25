import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tilePlaceholder = path.join(root, "assets", "map-tile-placeholder.png");

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

function sampleRoute(distance = 420) {
  return {
    routes: [
      {
        distance,
        geometry: {
          type: "LineString",
          coordinates: [
            [2.2945, 48.8584],
            [2.296, 48.8595],
            [2.295, 48.8738],
          ],
        },
      },
    ],
  };
}

function pathStats(page) {
  return page.evaluate(() => {
    const paths = [...document.querySelectorAll(".leaflet-overlay-pane path")];
    return paths.map((p) => {
      const cs = getComputedStyle(p);
      return {
        w: parseFloat(cs.strokeWidth || "0"),
        dash: cs.strokeDasharray || "",
      };
    });
  });
}

async function seedMapTrip(page, coordOffset = 0, { enableRoutes = true } = {}) {
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

  await page.evaluate(
    async ({ vacationId, coordOffset: off, enableRoutes }) => {
      const coordOffset = off;
      const { putPlace } = await import("./js/db.js");
      const { createPlace } = await import("./js/places.js");
      const { createId } = await import("./js/utils.js");
      const day = "2026-10-25";
      const pts = [
        [48.8584 + coordOffset, 2.2945 + coordOffset],
        [48.8738 + coordOffset, 2.295 + coordOffset],
      ];
      for (let i = 0; i < pts.length; i++) {
        const [lat, lng] = pts[i];
        await putPlace(
          createPlace({
            id: createId(),
            vacationId,
            day,
            ts: Date.now() + i * 1000,
            lat,
            lng,
            name: `Ort ${i + 1}`,
            soft: false,
          })
        );
      }
      if (enableRoutes) {
        const { setMapRoutesEnabled } = await import("./js/settings-store.js");
        await setMapRoutesEnabled(true);
      }
    },
    { vacationId, coordOffset, enableRoutes }
  );
  return vacationId;
}

async function openMap(page, vacationId, { offline = false } = {}) {
  if (offline) {
    await page.evaluate((id) => {
      window.location.hash = `#/urlaub/${id}/karte`;
    }, vacationId);
  } else {
    await page.goto(`./#/urlaub/${vacationId}/karte`);
  }
  await page.waitForSelector('[data-testid="map-screen"]');
  await page.waitForSelector(".leaflet-overlay-pane path", { timeout: 8000 });
}

async function waitRoutedSolid(page) {
  await page.waitForFunction(
    () => {
      const paths = [...document.querySelectorAll(".leaflet-overlay-pane path")];
      return paths.some((p) => {
        const w = parseFloat(p.getAttribute("stroke-width") || "0");
        const dash = p.getAttribute("stroke-dasharray");
        return w >= 3.4 && (!dash || dash === "none");
      });
    },
    { timeout: 8000 }
  );
}

async function runViewport(label, viewport, { baseUrl, browser }) {
  const ctx = await browser.newContext({
    baseURL: baseUrl,
    viewport,
    serviceWorkers: "block",
    ...devices[label.includes("iPhone") ? "iPhone 8" : "Pixel 5"],
  });
  const page = await ctx.newPage();
  await page.route("**/tile.openstreetmap.org/**", (route) =>
    route.fulfill({ path: tilePlaceholder, contentType: "image/png" })
  );

  let routeCalls = 0;
  await page.route("**/routing.openstreetmap.de/**", async (route) => {
    routeCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sampleRoute()),
    });
  });

  const vacationId = await seedMapTrip(page);
  await openMap(page, vacationId);
  await waitRoutedSolid(page);

  await page.goto(`./#/urlaub/${vacationId}/karte`);
  await page.waitForSelector(".leaflet-overlay-pane path");
  const callsBefore = routeCalls;
  await page.waitForTimeout(1200);
  if (routeCalls > callsBefore) {
    throw new Error(`${label}: Cache miss – zweites Öffnen löste Routing aus`);
  }

  await ctx.close();
}

async function main() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();

  await runViewport("iPhone", { width: 375, height: 667 }, { baseUrl, browser });
  await runViewport("Android", { width: 360, height: 740 }, { baseUrl, browser });

  const ctx = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 390, height: 844 },
    serviceWorkers: "block",
  });
  const page = await ctx.newPage();
  await page.route("**/tile.openstreetmap.org/**", (route) =>
    route.fulfill({ path: tilePlaceholder, contentType: "image/png" })
  );

  let failCalls = 0;
  await ctx.route("**/*routing.openstreetmap.de/**", async (route) => {
    failCalls += 1;
    await route.fulfill({ status: 500, body: "fail" });
  });
  const vacationId = await seedMapTrip(page, 0.05);
  try {
    await Promise.race([
      page.waitForResponse((r) => r.url().includes("routing.openstreetmap.de"), { timeout: 8000 }),
      openMap(page, vacationId),
    ]);
  } catch {
    /* may use cache */
  }
  await openMap(page, vacationId);
  await page.waitForTimeout(3000);
  const stats = await pathStats(page);
  if (!stats.some((s) => s.dash && s.dash !== "none" && !s.dash.startsWith("0px"))) {
    throw new Error(`Fehler-Fallback: keine gestrichelte Linie (${JSON.stringify(stats)})`);
  }
  const retryFetches = await page.evaluate(async () => {
    let hits = 0;
    const real = window.fetch.bind(window);
    window.fetch = async (url, ...args) => {
      if (String(url).includes("routing.openstreetmap.de")) {
        hits += 1;
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return real(url, ...args);
    };
    const { resolveRouteSegment } = await import("./js/route-service.js");
    const from = { lat: -78.12, lng: 166.55 };
    const to = { lat: -78.18, lng: 166.62 };
    await resolveRouteSegment(from, to, { routesEnabled: true, online: true });
    await resolveRouteSegment(from, to, { routesEnabled: true, online: true });
    window.fetch = real;
    return hits;
  });
  if (retryFetches < 2) {
    throw new Error(`5xx-Fehler: erwartet 2 Fetch-Versuche, got ${retryFetches}`);
  }

  await page.unroute("**/routing.openstreetmap.de/**");
  let longCalls = 0;
  await page.route("**/routing.openstreetmap.de/**", async (route) => {
    longCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sampleRoute(50000)),
    });
  });
  const vacationId2 = await seedMapTrip(page, 0.08);
  await openMap(page, vacationId2);
  await page.waitForTimeout(2000);
  const statsLong = await pathStats(page);
  if (!statsLong.every((s) => s.dash || s.w <= 3.1)) {
    throw new Error(`3x-Regel: durchgehende Route trotz zu lang (${JSON.stringify(statsLong)})`);
  }

  const offlineKind = await page.evaluate(async () => {
    const { resolveRouteSegment } = await import("./js/route-service.js");
    const r = await resolveRouteSegment(
      { lat: 48.86, lng: 2.29 },
      { lat: 48.87, lng: 2.3 },
      { routesEnabled: true, online: false }
    );
    return r.kind;
  });
  if (offlineKind !== "straight") throw new Error("Offline: erwartet gerade Linie");

  await ctx.setOffline(false);
  const routedWhenOff = await page.evaluate(async () => {
    const { setMapRoutesEnabled } = await import("./js/settings-store.js");
    await setMapRoutesEnabled(false);
    let hit = false;
    const orig = window.fetch;
    window.fetch = (url, ...args) => {
      if (String(url).includes("routing.openstreetmap.de")) hit = true;
      return orig(url, ...args);
    };
    const { resolveRouteSegment } = await import("./js/route-service.js");
    await resolveRouteSegment(
      { lat: 48.86, lng: 2.29 },
      { lat: 48.87, lng: 2.3 },
      { routesEnabled: false, online: true }
    );
    window.fetch = orig;
    return hit;
  });
  if (routedWhenOff) throw new Error("Schalter aus: Routing trotzdem angefragt");

  await ctx.close();
  await browser.close();
  server.close();
  console.log("Playwright 6 tests OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
