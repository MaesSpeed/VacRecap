import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";
import { unzipSync } from "fflate";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const screenshotsDir = path.join(root, "docs", "screenshots");

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
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

async function makeDistinctJpeg(page, seed) {
  const bytes = await page.evaluate(async (s) => {
    const canvas = document.createElement("canvas");
    canvas.width = 400 + s;
    canvas.height = 300 + s;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = `hsl(${s * 17}, 60%, 55%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92));
    const buf = await blob.arrayBuffer();
    return Array.from(new Uint8Array(buf));
  }, seed);
  return Buffer.from(bytes);
}

function installMocks() {
  return `
    window.__vacrecapShared = null;
    navigator.storage.estimate = async () => ({
      usage: 1.2 * 1024 ** 3,
      quota: 40 * 1024 ** 3,
    });
    navigator.canShare = (data) => Array.isArray(data?.files) && data.files.length > 0;
    navigator.share = async ({ files }) => {
      const f = files[0];
      window.__vacrecapShared = { name: f.name, bytes: Array.from(new Uint8Array(await f.arrayBuffer())) };
    };
  `;
}

async function seedBackupVacation(page) {
  const originals = [];
  for (let i = 0; i < 4; i++) originals.push(await makeDistinctJpeg(page, i + 1));

  await page.goto("./");
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', "Paris");
  await page.click('[data-action="pick-dates"]');
  await page.click('.calendar-day[data-date="2026-11-06"]');
  await page.click('.calendar-day[data-date="2026-11-08"]');
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  const vacationId = await page.locator(".screen--trip").getAttribute("data-vacation-id");

  await page.evaluate(
    async ({ vacationId, originals }) => {
      const { putPlace, putMedia, putNote } = await import("./js/db.js");
      const { createPlace } = await import("./js/places.js");
      const { createId } = await import("./js/utils.js");

      const days = ["2026-11-06", "2026-11-07", "2026-11-08"];
      const p1 = createPlace({
        vacationId,
        day: days[0],
        ts: new Date("2026-11-06T10:30:00").getTime(),
        lat: 48.8584,
        lng: 2.2945,
        name: "Eiffelturm",
      });
      const p2 = createPlace({
        vacationId,
        day: days[1],
        ts: new Date("2026-11-07T14:00:00").getTime(),
        lat: 48.8606,
        lng: 2.3376,
        name: "Louvre",
      });
      await putPlace(p1);
      await putPlace(p2);

      for (let i = 0; i < 3; i++) {
        const bytes = new Uint8Array(originals[i]);
        const blob = new Blob([bytes], { type: "image/jpeg" });
        await putMedia({
          id: createId(),
          placeId: p1.id,
          vacationId,
          day: days[0],
          ts: Date.now() - 300000 + i * 1000,
          type: "photo",
          blob,
          thumbBlob: new Blob([bytes.slice(0, 200)], { type: "image/jpeg" }),
          w: 400 + i,
          h: 300 + i,
          mime: "image/jpeg",
          ext: "jpg",
        });
      }
      const vBytes = new Uint8Array(originals[3]);
      await putMedia({
        id: createId(),
        placeId: p1.id,
        vacationId,
        day: days[0],
        ts: Date.now() - 100000,
        type: "video",
        blob: new Blob([vBytes], { type: "video/mp4" }),
        thumbBlob: new Blob([vBytes.slice(0, 120)], { type: "image/jpeg" }),
        w: 1280,
        h: 720,
        duration: 3,
        mime: "video/mp4",
        ext: "mp4",
      });
      await putNote({
        id: createId(),
        placeId: p2.id,
        vacationId,
        day: days[1],
        ts: Date.now() - 50000,
        text: "Mona Lisa bestaunt.",
      });
    },
    { vacationId, originals: originals.map((b) => [...b]) }
  );

  return { vacationId, originals };
}

async function waitForBackupReady(page) {
  await page.waitForSelector('[data-testid="backup-sheet"]');
  await page.waitForFunction(() => {
    const btn = document.querySelector('[data-testid="backup-sheet"] [data-action="save"]');
    return btn && !btn.disabled;
  });
}

async function runBackupFlow(page, { captureScreenshots, label }) {
  const { vacationId, originals } = await seedBackupVacation(page);
  await page.reload();
  await page.waitForSelector('[data-testid="trip-content"]');

  await page.tap('[data-action="settings"]');
  await page.waitForSelector('[data-testid="settings-screen"]');
  await page.waitForSelector('[data-role="storage-line"]:not([hidden])');

  if (captureScreenshots) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(screenshotsDir, "28-einstellungen-daten.png"),
      fullPage: true,
    });
  }

  await page.tap('[data-action="backup"]');
  await waitForBackupReady(page);

  if (captureScreenshots) {
    await page.screenshot({
      path: path.join(screenshotsDir, "26-sicherung-sheet.png"),
      fullPage: true,
    });
  }

  await page.tap('[data-action="save"]');
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="app-toast"]');
    return t?.textContent?.includes("Sicherung gespeichert");
  });

  if (captureScreenshots) {
    await page.screenshot({
      path: path.join(screenshotsDir, "27-sicherung-gespeichert.png"),
      fullPage: true,
    });
  }

  const shared = await page.evaluate(() => window.__vacrecapShared);
  if (!shared?.bytes?.length) throw new Error(`${label}: no shared zip`);

  const zipBuf = Buffer.from(shared.bytes);
  const entries = unzipSync(new Uint8Array(zipBuf));
  const names = Object.keys(entries);
  if (!names.includes("reise.json") || !names.includes("LIESMICH.txt")) {
    throw new Error(`${label}: missing root files`);
  }
  const reise = JSON.parse(new TextDecoder().decode(entries["reise.json"]));
  if (!reise.vacation?.title) throw new Error(`${label}: invalid reise.json`);

  const fotoEntry = names.find((n) => n.includes("_foto.") && !n.endsWith("/"));
  if (!fotoEntry) throw new Error(`${label}: no foto in zip`);
  const fotoBytes = Buffer.from(entries[fotoEntry]);
  const match = originals.some((orig) => orig.equals(fotoBytes));
  if (!match) throw new Error(`${label}: foto bytes mismatch in zip`);

  const noteFile = names.find((n) => n.endsWith("notizen.txt"));
  if (!noteFile || !new TextDecoder().decode(entries[noteFile]).includes("Mona Lisa")) {
    throw new Error(`${label}: notizen.txt missing`);
  }

  const cameraBytes = await makeDistinctJpeg(page, 99);
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.locator(".oc[data-place-id]").first().tap();
  await page.evaluate(
    async (bytes) => {
      const input = document.querySelector('[data-role="photo-input"]');
      const file = new File([new Uint8Array(bytes)], "original-test.jpg", {
        type: "image/jpeg",
        lastModified: 1_800_000_000_000,
      });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    [...cameraBytes]
  );
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="app-toast"]');
    return t?.textContent?.includes("Foto gespeichert");
  });

  const stored = await page.evaluate(async (bytes) => {
    const { getAllMediaForVacation } = await import("./js/db.js");
    const expected = new Uint8Array(bytes);
    const all = await getAllMediaForVacation(
      document.querySelector(".screen--trip")?.dataset?.vacationId
    );
    for (const m of all.filter((x) => x.type !== "video")) {
      const full = new Uint8Array(await m.blob.arrayBuffer());
      if (full.length !== expected.length) continue;
      let ok = true;
      for (let i = 0; i < expected.length; i++) {
        if (full[i] !== expected[i]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        const thumb = new Uint8Array(await m.thumbBlob.arrayBuffer());
        return { thumbLen: thumb.length };
      }
    }
    return null;
  }, [...cameraBytes]);
  if (!stored) throw new Error(`${label}: camera original not in DB`);
  if (stored.thumbLen > 80_000) throw new Error(`${label}: thumb too large`);

  await page.evaluate(
    async (bytes) => {
      const input = document.querySelector('[data-role="gallery-input"]');
      const file = new File([new Uint8Array(bytes)], "gal-original.jpg", {
        type: "image/jpeg",
        lastModified: 1_800_000_001_000,
      });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    [...cameraBytes]
  );
  await page.waitForSelector('[data-testid="mediathek-screen"]');
  await page.tap('[data-action="add"]');
  await page.waitForSelector('[data-testid="trip-content"]');

  const galStored = await page.evaluate(async (expected) => {
    const { getAllMediaForVacation } = await import("./js/db.js");
    const id = document.querySelector(".screen--trip")?.dataset?.vacationId;
    const all = await getAllMediaForVacation(id);
    const hit = all.find((m) => m.sourceKey?.includes("gal-original"));
    if (!hit) return null;
    const full = new Uint8Array(await hit.blob.arrayBuffer());
    return Array.from(full);
  }, [...cameraBytes]);
  if (!galStored || !Buffer.from(galStored).equals(cameraBytes)) {
    throw new Error(`${label}: mediathek original bytes mismatch`);
  }
}

async function main() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const mock = installMocks();

  const ctxI = await browser.newContext({
    ...devices["iPhone 8"],
    baseURL: baseUrl,
    hasTouch: true,
  });
  await ctxI.addInitScript(mock);
  const pageI = await ctxI.newPage();
  await runBackupFlow(pageI, { captureScreenshots: true, label: "iphone8" });
  await ctxI.close();

  const ctxA = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 360, height: 740 },
    hasTouch: true,
    isMobile: true,
  });
  await ctxA.addInitScript(mock);
  const pageA = await ctxA.newPage();
  await runBackupFlow(pageA, { captureScreenshots: false, label: "android" });
  await ctxA.close();

  await browser.close();
  server.close();
  console.log("Playwright 3b-2 tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
