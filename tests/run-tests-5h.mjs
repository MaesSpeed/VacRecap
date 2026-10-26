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

async function installSyncCaptureProbe(page) {
  await page.evaluate(() => {
    window.__syncCaptureClicks = [];
    window.__inGestureClick = false;
    document.addEventListener(
      "click",
      () => {
        window.__inGestureClick = true;
        queueMicrotask(() => {
          window.__inGestureClick = false;
        });
      },
      true
    );
    const hookInput = (el) => {
      el?.addEventListener(
        "click",
        () => {
          window.__syncCaptureClicks.push({
            id: el.dataset.testid || el.dataset.role,
            sync: Boolean(window.__inGestureClick),
          });
        },
        true
      );
    };
    window.__hookCaptureInputs = () => {
      document
        .querySelectorAll(
          '[data-role="capture-photo-input"], [data-testid="capture-photo-input"], [data-testid="map-capture-photo-input"]'
        )
        .forEach(hookInput);
    };
    window.__hookCaptureInputs();
  });
}

async function assertSyncCaptureClick(page, label, trigger) {
  const before = await page.evaluate(() => window.__syncCaptureClicks?.length ?? 0);
  const chooser = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
  await trigger();
  const ch = await chooser;
  if (ch) await ch.setFiles([]);
  await page.waitForTimeout(100);
  const last = await page.evaluate((n) => window.__syncCaptureClicks?.slice(n), before);
  if (!last?.length || !last.every((e) => e.sync)) {
    throw new Error(`${label}: capture input.click nicht synchron (${JSON.stringify(last)})`);
  }
}

async function assertBrokenThumbRegenerates(page, label, vacationId) {
  const { mediaId, placeId } = await page.evaluate(async (vid) => {
    const { createPlace } = await import("./js/places.js");
    const { putPlace, putMedia } = await import("./js/db.js");
    const { todayIso, createId } = await import("./js/utils.js");
    const day = todayIso();
    const place = createPlace({
      vacationId: vid,
      day,
      ts: Date.now() - 2000,
      lat: 48.87,
      lng: 2.35,
      name: "Test-Ort",
      soft: false,
      source: "test",
    });
    await putPlace(place);
    const id = createId();
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 90;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#336699";
    ctx.fillRect(0, 0, 120, 90);
    const full = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    await putMedia({
      id,
      placeId: place.id,
      vacationId: vid,
      day,
      ts: Date.now() - 1000,
      type: "photo",
      blob: full,
      thumbBlob: new Blob([], { type: "image/jpeg" }),
      w: 120,
      h: 90,
    });
    return { mediaId: id, placeId: place.id };
  }, vacationId);
  await page.reload();
  await page.waitForSelector('[data-testid="place-list"]');
  await page.locator(`[data-place-id="${placeId}"]`).click();
  await page.waitForSelector(`[data-place-id="${placeId}"].oc--selected`);
  await page.waitForFunction(
    async (mediaId) => {
      const img = document.querySelector(`.tile__img[data-media-id="${mediaId}"], .th__img[data-media-id="${mediaId}"]`);
      if (!img || img.hidden) return false;
      return img.complete && img.naturalWidth > 0;
    },
    mediaId,
    { timeout: 15000 }
  );
}

async function assertMediathekFlowThumbs(page, label, vacationId) {
  await page.evaluate(async (vid) => {
    const { createPlace } = await import("./js/places.js");
    const { putPlace } = await import("./js/db.js");
    const { todayIso } = await import("./js/utils.js");
    const day = todayIso();
    await putPlace(
      createPlace({
        vacationId: vid,
        day,
        ts: Date.now() - 5000,
        lat: 48.858,
        lng: 2.34,
        name: "Ort 1",
        soft: false,
        source: "test",
      })
    );
    await putPlace(
      createPlace({
        vacationId: vid,
        day,
        ts: Date.now() - 3000,
        lat: 48.862,
        lng: 2.36,
        name: "Ort 2",
        soft: false,
        source: "test",
      })
    );
  }, vacationId);
  await page.reload();
  await page.waitForSelector('[data-testid="place-list"]');
  const { place1, place2 } = await page.evaluate(async (vid) => {
    const { getPlacesForDay } = await import("./js/db.js");
    const { todayIso } = await import("./js/utils.js");
    const places = (await getPlacesForDay(vid, todayIso())).filter((p) => !p.soft);
    const p1 = places.find((p) => p.name === "Ort 1");
    const p2 = places.find((p) => p.name === "Ort 2");
    return { place1: p1?.id, place2: p2?.id };
  }, vacationId);

  await page.evaluate(
    async ({ vacationId, placeId }) => {
      const { todayIso } = await import("./js/utils.js");
      const day = todayIso();
      const blob = await new Promise((resolve) => {
        const c = document.createElement("canvas");
        c.width = 120;
        c.height = 90;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#cc6633";
        ctx.fillRect(0, 0, 120, 90);
        c.toBlob((b) => resolve(b), "image/jpeg", 0.9);
      });
      const file = new File([blob], `flow-${placeId}.jpg`, { type: "image/jpeg" });
      const { createMediathekSession } = await import("./js/mediathek-session.js");
      const { navigate } = await import("./js/router.js");
      createMediathekSession({
        vacationId,
        day,
        selectedPlaceId: placeId,
        files: [file],
      });
      navigate({ name: "urlaub-mediathek", id: vacationId }, { replace: true });
    },
    { vacationId, placeId: place1 }
  );
  await page.waitForSelector('[data-testid="mediathek-screen"]');
  await page.waitForFunction(
    () => {
      const tile = document.querySelector(".mediathek-tile");
      if (!tile) return false;
      const bg = getComputedStyle(tile).backgroundImage;
      return bg && bg !== "none";
    },
    { timeout: 15000 }
  );
  await page.locator(".mediathek-bar__add").click();
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.waitForFunction(
    (pid) => Boolean(document.querySelector(`article.oc[data-place-id="${pid}"] .tile[data-media-id]`)),
    place1,
    { timeout: 15000 }
  );

  await page.locator(`[data-place-id="${place2}"]`).click();
  await page.waitForSelector(`[data-place-id="${place2}"].oc--selected`);
  const jpeg2 = await makeJpeg(page, 6);
  const chooser = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
  await page.locator('[data-footer-action="camera"]').click();
  const ch = await chooser;
  const file = { name: "ort2.jpg", mimeType: "image/jpeg", buffer: jpeg2 };
  if (ch) await ch.setFiles(file);
  else await page.locator('[data-testid="capture-photo-input"]').setInputFiles(file);
  await page.waitForFunction(
    (pid) => Boolean(document.querySelector(`article.oc--dim[data-place-id="${pid}"] .th__img`)),
    place1,
    { timeout: 15000 }
  );
  const ok = await page.evaluate((place1) => {
    const card = document.querySelector(`article.oc--dim[data-place-id="${place1}"]`);
    const img = card?.querySelector(".th__img");
    if (!img) return { ok: false, reason: "kein dim-Thumb" };
    const src = img.getAttribute("src");
    if (!src || img.hidden) return { ok: false, reason: "Thumb unsichtbar" };
    return { ok: img.complete && img.naturalWidth > 0, src: src.slice(0, 30) };
  }, place1);
  if (!ok.ok) {
    throw new Error(`${label}: Ort-1-Vorschau nach Ort-2-Foto kaputt (${JSON.stringify(ok)})`);
  }
}

async function assertSlowRefreshNoDeadThumbs(page, label, vacationId) {
  await page.evaluate(() => {
    window.__revokedDuringRefresh = [];
    const orig = URL.revokeObjectURL;
    URL.revokeObjectURL = (u) => {
      window.__revokedDuringRefresh.push(u);
      return orig(u);
    };
  });
  await page.reload();
  await page.waitForSelector('[data-testid="trip-content"]');
  const jpeg = await makeJpeg(page, 2);
  await page.locator('[data-testid="capture-photo-input"]').setInputFiles({
    name: "slow.jpg",
    mimeType: "image/jpeg",
    buffer: jpeg,
  });
  await page.waitForSelector(".tile[data-media-id]");
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("vacrecap:data-changed")));
  }
  await page.waitForTimeout(800);
  const bad = await page.evaluate(() => {
    const revoked = new Set(window.__revokedDuringRefresh ?? []);
    const imgs = [...document.querySelectorAll(".tile__img, .th__img")];
    return imgs.filter((img) => {
      const src = img.getAttribute("src");
      return src && revoked.has(src) && img.offsetParent !== null;
    }).length;
  });
  if (bad > 0) {
    throw new Error(`${label}: ${bad} sichtbare Kacheln mit freigegebener Object-URL`);
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
  await installSyncCaptureProbe(page);

  await assertSyncCaptureClick(page, "B-Footer", () =>
    page.locator('[data-footer-action="camera"]').click()
  );
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    window.__syncCaptureClicks = [];
    window.__hookCaptureInputs?.();
  });
  await page.waitForSelector('.oc--selected [data-action="camera-place"]');
  await assertSyncCaptureClick(page, "B-Ortskarte", () =>
    page.locator('.oc--selected [data-action="camera-place"]').click()
  );

  await page.route("**/routing.openstreetmap.de/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"routes":[]}' })
  );
  await page.evaluate(async () => {
    const { setMapRoutesEnabled } = await import("./js/settings-store.js");
    await setMapRoutesEnabled(false);
  });
  await page.click('[data-action="map"]');
  await page.waitForSelector('[data-testid="map-screen"]');
  await page.waitForTimeout(400);
  const mapSync = await page.evaluate(() => {
    window.__syncCaptureClicks = [];
    const btn = document.querySelector('[data-testid="map-screen"] [data-footer-action="camera"]');
    const input = document.querySelector('[data-testid="map-capture-photo-input"]');
    if (!btn || !input) return { ok: false, reason: "fehlende Elemente" };
    document.addEventListener(
      "click",
      () => {
        window.__inGestureClick = true;
        queueMicrotask(() => {
          window.__inGestureClick = false;
        });
      },
      true
    );
    input.addEventListener(
      "click",
      () => {
        window.__syncCaptureClicks.push({ sync: Boolean(window.__inGestureClick) });
      },
      true
    );
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return { ok: window.__syncCaptureClicks.every((e) => e.sync), log: window.__syncCaptureClicks };
  });
  if (!mapSync.ok) {
    throw new Error(`B-Karten-Footer: capture input.click nicht synchron (${JSON.stringify(mapSync)})`);
  }
  await page.click('[data-testid="map-screen"] [data-action="back"]');
  await page.waitForSelector('[data-testid="trip-content"]');

  await assertBrokenThumbRegenerates(page, "A-Thumb", vacationId);
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="trip-content"]');
  await assertMediathekFlowThumbs(page, "A-Flow", vacationId);
  await assertSlowRefreshNoDeadThumbs(page, "A-Refresh", vacationId);

  await ctx.close();
  await browser.close();
  server.close();
  console.log("Playwright 5h tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
