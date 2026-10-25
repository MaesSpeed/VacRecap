import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const screenshotsDir = path.join(root, "docs", "screenshots");

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
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

async function waitForNoToast(page) {
  await page.waitForFunction(() => {
    const toast = document.querySelector('[data-testid="app-toast"]');
    return !toast || !toast.classList.contains("toast--visible");
  });
}

async function gradientJpegBuffer(page) {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 640, 480);
    g.addColorStop(0, "#2a6ea8");
    g.addColorStop(1, "#8fd3ff");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 640, 480);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    const buf = await blob.arrayBuffer();
    return Array.from(new Uint8Array(buf));
  });
  return Buffer.from(bytes);
}

async function main() {
  const { server, baseUrl } = await startServer();
  const iPhone = devices["iPhone 8"];
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...iPhone, baseURL: baseUrl });
  await context.grantPermissions(["geolocation"], { origin: baseUrl });

  const page = await context.newPage();
  await page.route("**/nominatim.openstreetmap.org/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ name: "Teststraße", address: { road: "Teststraße" } }),
    })
  );

  await page.goto("./");
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', "Paris 2b");
  await page.click('[data-action="pick-dates"]');
  await page.click('.calendar-day[data-date="2026-10-25"]');
  await page.click('.calendar-day[data-date="2026-10-27"]');
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');

  const vacationId = await page.locator(".screen--trip").getAttribute("data-vacation-id");
  const day = "2026-10-25";

  const placeId = await page.evaluate(
    async ({ vacationId, day }) => {
      const { putPlace } = await import("./js/db.js");
      const { createPlace } = await import("./js/places.js");
      const { putMedia, putNote } = await import("./js/db.js");
      const { createId } = await import("./js/utils.js");

      const place = createPlace({
        vacationId,
        day,
        ts: Date.now() - 500000,
        lat: 48.8584,
        lng: 2.2945,
        name: "Eiffelturm",
      });
      await putPlace(place);

      async function jpegThumb(hue) {
        const canvas = document.createElement("canvas");
        canvas.width = 200;
        canvas.height = 200;
        const ctx = canvas.getContext("2d");
        const g = ctx.createLinearGradient(0, 0, 200, 200);
        g.addColorStop(0, `hsl(${hue}, 70%, 55%)`);
        g.addColorStop(1, `hsl(${hue + 40}, 60%, 70%)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 200, 200);
        return await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
      }

      const base = Date.now() - 400000;
      for (let i = 0; i < 3; i++) {
        const thumb = await jpegThumb(200 + i * 30);
        const full = await jpegThumb(180 + i * 30);
        await putMedia({
          id: createId(),
          placeId: place.id,
          vacationId,
          day,
          ts: base + i * 10000,
          type: "photo",
          blob: full,
          thumbBlob: thumb,
          w: 200,
          h: 200,
        });
      }

      const vThumb = await jpegThumb(40);
      await putMedia({
        id: createId(),
        placeId: place.id,
        vacationId,
        day,
        ts: base + 50000,
        type: "video",
        blob: new Blob([], { type: "video/mp4" }),
        thumbBlob: vThumb,
        w: 1280,
        h: 720,
        duration: 14,
        durationLabel: "0:14",
      });

      const notes = [
        "Aussicht von der zweiten Plattform – windig!",
        "Croissant am Fuß des Turms gekauft.",
        "Warteschlange war kurz heute Morgen.",
        "Abends leuchtet der Turm gold.",
        "Ticket online gebucht.",
      ];
      for (let i = 0; i < notes.length; i++) {
        await putNote({
          id: createId(),
          placeId: place.id,
          vacationId,
          day,
          ts: base + 60000 + i * 5000,
          text: notes[i],
        });
      }

      return place.id;
    },
    { vacationId, day }
  );

  await page.evaluate(async () => {
    const { setRememberLocationOnOpen } = await import("./js/settings-store.js");
    await setRememberLocationOnOpen(false);
  });
  await page.reload();
  await page.waitForSelector('[data-testid="place-list"]');
  await page.waitForSelector(`.oc[data-place-id="${placeId}"].oc--selected`);
  await waitForNoToast(page);

  const meta = await page.locator(".oc--selected .oc__meta").innerText();
  if (!meta.includes("3 Fotos") || !meta.includes("1 Video") || !meta.includes("5 Notizen")) {
    throw new Error(`unexpected meta: ${meta}`);
  }

  const tiles = await page.locator(".oc--selected .tile").count();
  if (tiles !== 4) throw new Error(`expected 4 tiles, got ${tiles}`);

  const moreNotes = page.locator(".notes-more", { hasText: "weitere Notizen" });
  if (!(await moreNotes.count())) throw new Error("missing +N weitere Notizen");

  const draftStyles = await page.evaluate(() => {
    const meta = document.querySelector(".oc--selected .oc__meta");
    const note = document.querySelector(".oc--selected .nr__text");
    const nr = document.querySelector(".oc--selected .nr");
    const icon = document.querySelector(".oc--selected .nr__icon");
    const csM = getComputedStyle(meta);
    const csN = getComputedStyle(note);
    const csNr = getComputedStyle(nr);
    const csI = getComputedStyle(icon);
    return {
      meta: {
        fontSize: csM.fontSize,
        fontWeight: csM.fontWeight,
        color: csM.color,
        whiteSpace: csM.whiteSpace,
        overflow: csM.overflow,
        textOverflow: csM.textOverflow,
        lineCount: meta.scrollWidth > meta.clientWidth ? "ellipsis-active" : "fits",
      },
      note: { fontSize: csN.fontSize, lineHeight: csN.lineHeight },
      nrGap: csNr.gap,
      icon: { width: csI.width, height: csI.height },
    };
  });
  console.log("Draft pixel check (2b):", JSON.stringify(draftStyles, null, 2));
  if (draftStyles.meta.fontSize !== "12px" || draftStyles.meta.fontWeight !== "800") {
    throw new Error(`meta style mismatch: ${JSON.stringify(draftStyles.meta)}`);
  }
  if (draftStyles.note.fontSize !== "12.8px") {
    throw new Error(`note font-size mismatch: ${draftStyles.note.fontSize}`);
  }
  if (parseFloat(draftStyles.note.lineHeight) < 17.2 || parseFloat(draftStyles.note.lineHeight) > 17.6) {
    throw new Error(`note line-height mismatch: ${draftStyles.note.lineHeight}`);
  }
  if (draftStyles.nrGap !== "7px") {
    throw new Error(`nr gap mismatch: ${draftStyles.nrGap}`);
  }

  await page.screenshot({
    path: path.join(screenshotsDir, "12-karte-kacheln-notizen.png"),
    fullPage: true,
  });

  await page.click('[data-footer-action="note"]');
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.screenshot({
    path: path.join(screenshotsDir, "13-notiz-sheet.png"),
    fullPage: true,
  });
  await page.click('[data-action="cancel"]');

  await page.evaluate(() => {
    window.__captureOpens = 0;
    document.querySelector('[data-role="capture-photo-input"]')?.addEventListener("click", () => {
      window.__captureOpens = (window.__captureOpens || 0) + 1;
    });
  });
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 3000 }).catch(() => null);
  await page.click('[data-footer-action="camera"]');
  const chooser = await chooserPromise;
  if (chooser) await chooser.setFiles([]);
  const captureOpens = await page.evaluate(() => window.__captureOpens ?? 0);
  if (captureOpens !== 1) {
    throw new Error(`camera footer should open capture-input once, got ${captureOpens}`);
  }
  await page.screenshot({
    path: path.join(screenshotsDir, "14-kamera-auswahl-sheet.png"),
    fullPage: true,
  });

  await page.locator(".oc--selected .tile").first().click();
  await page.waitForSelector('[data-testid="media-viewer"]');
  await page.screenshot({
    path: path.join(screenshotsDir, "15-media-viewer.png"),
    fullPage: true,
  });
  await page.click('[data-testid="media-viewer-close"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);

  const jpeg = await gradientJpegBuffer(page);
  await page.evaluate(
    async (bytes) => {
      const input = document.querySelector('[data-role="capture-photo-input"]');
      const file = new File([new Uint8Array(bytes)], "gradient.jpg", { type: "image/jpeg" });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    [...jpeg]
  );
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="app-toast"]');
    return t?.textContent?.includes("Foto gespeichert");
  });
  await waitForNoToast(page);
  const tilesAfter = await page.locator(".oc--selected .tile").count();
  if (tilesAfter < 4) throw new Error("expected photo tile after upload");

  await browser.close();
  server.close();
  console.log("Playwright 2b tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
