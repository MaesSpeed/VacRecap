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

async function seedTripWithPhoto(page) {
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
  const jpeg = await makeJpeg(page, 3);
  await page.locator('[data-testid="capture-photo-input"]').setInputFiles({
    name: "IMG_test.jpg",
    mimeType: "image/jpeg",
    buffer: jpeg,
  });
  await page.waitForSelector(".tile[data-media-id]");
  const mediaId = await page.locator(".tile[data-media-id]").first().getAttribute("data-media-id");
  await page.locator(".tile[data-media-id]").first().click();
  await page.waitForSelector('[data-testid="media-viewer"]');
  return { vacationId, mediaId, jpeg };
}

function installShareMocksInPage({ canShare = true, abort = false } = {}) {
  window.__shareCalls = [];
  navigator.canShare = (data) => canShare && Array.isArray(data?.files) && data.files.length > 0;
  navigator.share = ({ files }) => {
    const f = files[0];
    window.__shareCalls.push({
      syncInClickTurn: Boolean(window.__shareSyncTurn),
      name: f.name,
      type: f.type,
      size: f.size,
    });
    return new Promise((resolve, reject) => {
      setTimeout(async () => {
        const bytes = Array.from(new Uint8Array(await f.arrayBuffer()));
        window.__shareCalls[window.__shareCalls.length - 1].bytes = bytes;
        if (abort) reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        else resolve();
      }, 40);
    });
  };
}

async function installShareMocks(page, opts = {}) {
  await page.evaluate(installShareMocksInPage, opts);
}

async function assertShareWithOriginal(page, label, mediaId, jpeg) {
  const call = await page.evaluate(() => {
    window.__shareCalls = [];
    navigator.canShare = (data) => Array.isArray(data?.files) && data.files.length > 0;
    navigator.share = ({ files }) => {
      const f = files[0];
      window.__shareCalls.push({
        syncInClickTurn: Boolean(window.__shareSyncTurn),
        name: f.name,
        type: f.type,
        size: f.size,
      });
      return new Promise((resolve) => {
        setTimeout(async () => {
          const bytes = Array.from(new Uint8Array(await f.arrayBuffer()));
          window.__shareCalls[window.__shareCalls.length - 1].bytes = bytes;
          resolve();
        }, 40);
      });
    };
    window.__shareSyncTurn = true;
    document.querySelector('[data-testid="media-viewer-save"]').click();
    window.__shareSyncTurn = false;
    return window.__shareCalls[window.__shareCalls.length - 1];
  });
  if (!call) {
    throw new Error(`${label}: navigator.share nicht aufgerufen`);
  }
  if (!call.syncInClickTurn) {
    throw new Error(`${label}: navigator.share nicht synchron im Tipp (${JSON.stringify(call)})`);
  }
  await page.waitForFunction(
    () => (window.__shareCalls?.[window.__shareCalls.length - 1]?.bytes?.length ?? 0) > 0
  );
  const callWithBytes = await page.evaluate(
    () => window.__shareCalls[window.__shareCalls.length - 1]
  );
  if (!callWithBytes.name.includes(".jpg")) {
    throw new Error(`${label}: falscher Dateiname (${call.name})`);
  }
  const original = await page.evaluate(async (id) => {
    const { getMedia } = await import("./js/db.js");
    const m = await getMedia(id);
    return Array.from(new Uint8Array(await m.blob.arrayBuffer()));
  }, mediaId);
  if (callWithBytes.bytes?.length !== original.length) {
    throw new Error(
      `${label}: Share-Bytes ≠ Original (${callWithBytes.bytes?.length} vs ${original.length})`
    );
  }
  const snack = await page.locator('[data-testid="media-viewer-share-snack"]');
  await snack.waitFor({ state: "visible" });
  const text = await snack.innerText();
  if (!text.includes("Bild sichern")) {
    throw new Error(`${label}: Snackbar-Text fehlt (${text})`);
  }
}

async function assertDownloadFallback(page, label, mediaId) {
  await page.evaluate(() => {
    window.__shareCalls = [];
    window.__downloadClicked = false;
    navigator.canShare = () => false;
    const origCreate = document.createElement.bind(document);
    document.createElement = function (tag, ...rest) {
      const el = origCreate(tag, ...rest);
      if (tag === "a") {
        el.click = () => {
          window.__downloadClicked = true;
          window.__downloadName = el.download;
        };
      }
      return el;
    };
  });
  await page.locator('[data-testid="media-viewer-save"]').click();
  await page.waitForFunction(() => window.__downloadClicked === true);
  const name = await page.evaluate(() => window.__downloadName);
  if (!name?.includes(".jpg")) {
    throw new Error(`${label}: Download-Dateiname fehlt (${name})`);
  }
  if ((await page.evaluate(() => window.__shareCalls?.length ?? 0)) > 0) {
    throw new Error(`${label}: share trotz Fallback aufgerufen`);
  }
}

async function assertAbortSilent(page, label) {
  await page.evaluate(() => {
    window.__shareCalls = [];
    navigator.canShare = (d) => Array.isArray(d?.files) && d.files.length > 0;
    navigator.share = () =>
      Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  });
  await page.locator('[data-testid="media-viewer-save"]').click();
  await page.waitForSelector('[data-testid="media-viewer-share-snack"]:not([hidden])');
  await page.waitForTimeout(200);
  const errToast = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="app-toast"]');
    return t?.textContent?.includes("fehlgeschlagen") || t?.textContent?.includes("Fehler");
  });
  if (errToast) {
    throw new Error(`${label}: AbortError zeigte Fehlermeldung`);
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

  const { mediaId, jpeg } = await seedTripWithPhoto(page);
  await installShareMocks(page);
  await assertShareWithOriginal(page, "5i-Share", mediaId, jpeg);

  await page.click('[data-testid="media-viewer-close"]');
  await page.waitForSelector('[data-testid="media-viewer"]', { state: "hidden" });
  await page.locator(".tile[data-media-id]").first().click();
  await page.waitForSelector('[data-testid="media-viewer"]');
  await assertDownloadFallback(page, "5i-Fallback", mediaId);

  await assertAbortSilent(page, "5i-Abort");

  await ctx.close();
  await browser.close();
  server.close();
  console.log("Playwright 5i tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
