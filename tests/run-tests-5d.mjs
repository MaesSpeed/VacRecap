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
    vv.dispatchEvent(new Event("resize"));
  });
}

async function seedTripWithPlace(page) {
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
  const vacationId = await page.locator(".screen--trip").getAttribute("data-vacation-id");
  await page.locator('[data-footer-action="pin"]').click();
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="app-toast"]');
    return t?.textContent?.includes("gemerkt") || t?.textContent?.includes("Ort");
  });
  await page.waitForFunction(() => {
    const toast = document.querySelector('[data-testid="app-toast"]');
    return !toast || !toast.classList.contains("toast--visible");
  });
  return vacationId;
}

async function assertNoteSheetKeyboardLayout(page, label, viewport) {
  await page.locator('[data-footer-action="note"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await mockKeyboard(page);
  const longText = [
    "Zeile 1 Anfang",
    "Zeile 2 Text",
    "Zeile 3 mehr",
    "Zeile 4 sichtbar",
    "Zeile 5 weiter",
    "Zeile 6 Ende",
    "Zeile 7 unten",
  ].join("\n");
  const textarea = page.locator('[data-testid="note-sheet"] [data-role="text"]');
  await textarea.fill(longText);
  await textarea.focus();

  const layout = await page.evaluate(() => {
    const kb =
      parseInt(getComputedStyle(document.documentElement).getPropertyValue("--kb"), 10) || 0;
    const kbTop = window.innerHeight - kb;
    const sheet = document.querySelector(".sheet--note-bottom");
    const field = document.querySelector(".note-sheet__field");
    const ta = document.querySelector('[data-role="text"]');
    const save = document.querySelector('[data-action="save"]');
    const dictate = document.querySelector(".note-sheet__dictate");
    const tr = ta?.getBoundingClientRect();
    const sr = save?.getBoundingClientRect();
    const fr = field?.getBoundingClientRect();
    const cs = getComputedStyle(dictate ?? document.body);
    return {
      kbTop,
      saveBottom: sr?.bottom ?? 0,
      saveTop: sr?.top ?? 0,
      fieldHeight: fr?.height ?? 0,
      textBottom: tr?.bottom ?? 0,
      textTop: tr?.top ?? 0,
      dictateDisplay: dictate ? cs.display : "none",
      sheetKb: sheet?.classList.contains("sheet--note-kb"),
      taScrollable: (ta?.scrollHeight ?? 0) > (ta?.clientHeight ?? 0) + 2,
      fieldMinOk: (fr?.height ?? 0) >= 40,
    };
  });

  if (!layout.sheetKb) {
    throw new Error(`${label}: sheet--note-kb fehlt`);
  }
  if (layout.dictateDisplay !== "none") {
    throw new Error(`${label}: Diktier-Zeile soll mit Tastatur ausgeblendet sein`);
  }
  if (layout.saveBottom > layout.kbTop + 4) {
    throw new Error(`${label}: Speichern unter Tastatur (${layout.saveBottom} > ${layout.kbTop})`);
  }
  if (layout.textBottom > layout.saveTop - 4) {
    throw new Error(
      `${label}: Textarea überlappt Speichern (${layout.textBottom} > ${layout.saveTop})`
    );
  }
  if (!layout.fieldMinOk) {
    throw new Error(`${label}: Textfeld-Container zu klein (${layout.fieldHeight}px)`);
  }
  if (viewport.height <= 740 && !layout.taScrollable) {
    throw new Error(`${label}: langer Text soll in der Textarea scrollen`);
  }

  await page.locator('[data-testid="note-sheet"] [data-action="cancel"]').click();
  const confirm = page.locator('[data-testid="confirm-discard-note"] [data-action="confirm"]');
  if (await confirm.count()) {
    await confirm.click();
  }
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);
}

async function assertMapFooterBackToOverview(page, label, vacationId) {
  await page.route("**/routing.openstreetmap.de/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"routes":[]}' })
  );
  await page.evaluate(async () => {
    const { setMapRoutesEnabled } = await import("./js/settings-store.js");
    await setMapRoutesEnabled(false);
  });
  await page.goto("./#/urlaube");
  await page.waitForSelector(".top-bar__title");
  await page.locator(`[data-vacation-id="${vacationId}"]`).click();
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.click('[data-action="map"]');
  await page.waitForSelector('[data-testid="map-screen"]');
  await page.waitForSelector('[data-testid="map-screen"] [data-footer-action="note"]');
  await page.locator('[data-testid="map-screen"] [data-footer-action="note"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.locator('[data-testid="note-sheet"] [data-action="cancel"]').click();
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);
  await page.click('[data-action="back"]');
  await page.waitForSelector(".top-bar__title");
  const hash = await page.evaluate(() => location.hash);
  if (!hash.includes("/urlaube")) {
    throw new Error(`${label}: Zurück nach Karte→Notiz landete nicht in Übersicht (${hash})`);
  }
}

async function assertDeepLinkBack(page, label, vacationId) {
  await page.goto("./#/urlaube");
  await page.waitForSelector(".top-bar__title");
  await page.evaluate(() => {
    sessionStorage.setItem("vacrecap-last-hash", "#/urlaube");
    sessionStorage.removeItem("vacrecap-nav-from-overview");
  });
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.click('[data-action="back"]');
  await page.waitForSelector(".top-bar__title");
  const title = await page.locator(".top-bar__title").textContent();
  if (title?.trim() !== "Reisen") {
    throw new Error(`${label}: Deep-Link Zurück nicht zur Übersicht (${title})`);
  }
}

async function runViewport(page, label, viewport) {
  await page.setViewportSize(viewport);
  const vacationId = await seedTripWithPlace(page);
  await assertNoteSheetKeyboardLayout(page, label, viewport);
  await assertMapFooterBackToOverview(page, label, vacationId);
  await assertDeepLinkBack(page, label, vacationId);
}

async function main() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    baseURL: baseUrl,
    ...devices["iPhone 8"],
    geolocation: { latitude: 48.8566, longitude: 2.3522 },
    permissions: ["geolocation"],
  });
  const page = await ctx.newPage();

  await runViewport(page, "375x667", { width: 375, height: 667 });
  await runViewport(page, "360x740", { width: 360, height: 740 });
  await runViewport(page, "390x844", { width: 390, height: 844 });

  await ctx.close();
  await browser.close();
  server.close();
  console.log("Playwright 5d tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
