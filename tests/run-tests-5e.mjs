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

async function seedTripWithPlace(page) {
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

async function assertFooterGpsNearPlace(page, label, vacationId) {
  await page.evaluate(
    async ({ vacationId, farLat, farLng }) => {
      const { createPlace } = await import("./js/places.js");
      const { putPlace } = await import("./js/db.js");
      const { todayIso } = await import("./js/utils.js");
      const day = todayIso();
      const far = createPlace({
        vacationId,
        day,
        ts: Date.now() + 5000,
        lat: farLat,
        lng: farLng,
        name: "Louvre weit",
        soft: false,
        source: "test",
      });
      await putPlace(far);
    },
    { vacationId, farLat: 48.92, farLng: 2.41 }
  );
  await page.reload();
  await page.waitForSelector('[data-testid="trip-content"]');
  const { nearPlaceId, farPlaceId } = await page.evaluate(async (vid) => {
    const { getPlacesForDay } = await import("./js/db.js");
    const { todayIso } = await import("./js/utils.js");
    const places = (await getPlacesForDay(vid, todayIso())).filter((p) => !p.soft);
    places.sort((a, b) => a.ts - b.ts);
    return { nearPlaceId: places[0]?.id, farPlaceId: places[1]?.id };
  }, vacationId);
  await page.locator(`[data-place-id="${farPlaceId}"]`).click();
  await page.waitForSelector(`[data-place-id="${farPlaceId}"].oc--selected`);
  const jpeg = await makeJpeg(page, 3);
  const filePayload = { name: "gps-test.jpg", mimeType: "image/jpeg", buffer: jpeg };
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
  await page.locator('[data-footer-action="camera"]').click();
  const chooser = await chooserPromise;
  if (chooser) {
    await chooser.setFiles(filePayload);
  } else {
    await page.locator('[data-testid="capture-photo-input"]').setInputFiles(filePayload);
  }
  let mediaReady = false;
  for (let i = 0; i < 40; i++) {
    mediaReady = await page.evaluate(async (vid) => {
      const { getAllMediaForVacation } = await import("./js/db.js");
      const all = await getAllMediaForVacation(vid);
      const sorted = all.sort((a, b) => a.ts - b.ts);
      const last = sorted[sorted.length - 1];
      return Boolean(last?.type === "photo" && last?.placeId);
    }, vacationId);
    if (mediaReady) break;
    await page.waitForTimeout(250);
  }
  if (!mediaReady) {
    throw new Error(`${label}: Footer-Foto wurde nicht gespeichert`);
  }
  const gpsCheck = await page.evaluate(
    async ({ vacationId, farPlaceId, gpsLat, gpsLng }) => {
      const { getAllMediaForVacation, getPlacesForDay } = await import("./js/db.js");
      const { todayIso } = await import("./js/utils.js");
      const { haversineMeters } = await import("./js/geo.js");
      const { getSamePlaceRadiusM } = await import("./js/settings-store.js");
      const all = await getAllMediaForVacation(vacationId);
      const sorted = all.sort((a, b) => a.ts - b.ts);
      const last = sorted[sorted.length - 1];
      if (!last?.placeId) return { ok: false, reason: "kein placeId" };
      if (last.placeId === farPlaceId) return { ok: false, reason: "an ausgewählter Ferne-Karte" };
      const places = await getPlacesForDay(vacationId, todayIso());
      const place = places.find((p) => p.id === last.placeId);
      if (!place?.lat) return { ok: false, reason: "Ort ohne GPS" };
      const radius = await getSamePlaceRadiusM();
      const dist = haversineMeters(gpsLat, gpsLng, place.lat, place.lng);
      if (dist > radius) return { ok: false, reason: `zu weit (${Math.round(dist)}m)` };
      return { ok: true, placeId: last.placeId };
    },
    { vacationId, farPlaceId, gpsLat: 48.8566, gpsLng: 2.3522 }
  );
  if (!gpsCheck.ok) {
    throw new Error(`${label}: Footer-Foto nicht am GPS-Ort (${gpsCheck.reason})`);
  }
  if (gpsCheck.placeId !== nearPlaceId) {
    const dupNear = await page.evaluate(
      async ({ vacationId, nearPlaceId, savedId }) => {
        const { getPlacesForDay } = await import("./js/db.js");
        const { todayIso } = await import("./js/utils.js");
        const places = (await getPlacesForDay(vacationId, todayIso())).filter((p) => !p.soft);
        const a = places.find((p) => p.id === nearPlaceId);
        const b = places.find((p) => p.id === savedId);
        if (!a?.lat || !b?.lat) return false;
        const { haversineMeters } = await import("./js/geo.js");
        return haversineMeters(a.lat, a.lng, b.lat, b.lng) < 1;
      },
      { vacationId, nearPlaceId, savedId: gpsCheck.placeId }
    );
    if (!dupNear) {
      throw new Error(
        `${label}: Footer-Foto Ort ${gpsCheck.placeId} passt nicht zu ${nearPlaceId}`
      );
    }
  }
}

async function assertFooterGpsDenied(page, label, vacationId) {
  await page.context().clearPermissions();
  await page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = (_ok, err) => {
      err?.({ code: 1, PERMISSION_DENIED: 1, message: "User denied Geolocation" });
    };
  });
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="trip-content"]');
  const placeIds = await page.evaluate(async (vid) => {
    const { getPlacesForDay } = await import("./js/db.js");
    const { todayIso } = await import("./js/utils.js");
    return (await getPlacesForDay(vid, todayIso()))
      .filter((p) => !p.soft)
      .sort((a, b) => a.ts - b.ts)
      .map((p) => p.id);
  }, vacationId);
  if (placeIds.length >= 2) {
    await page.locator(`[data-place-id="${placeIds[0]}"]`).click();
    await page.waitForSelector(`[data-place-id="${placeIds[0]}"].oc--selected`);
    await page.locator(`[data-place-id="${placeIds[1]}"]`).click();
    await page.waitForSelector(`[data-place-id="${placeIds[1]}"].oc--selected`);
  } else if (placeIds[0]) {
    await page.locator(`[data-place-id="${placeIds[0]}"]`).click();
  }
  const selectedId = placeIds[1] ?? placeIds[0];
  await page.evaluate(async () => {
    navigator.geolocation.getCurrentPosition = (_ok, err) => {
      err?.({ code: 1, PERMISSION_DENIED: 1, message: "User denied Geolocation" });
    };
    const { resetCapturePositionCache } = await import("./js/geo.js");
    const { resetCaptureGpsPrefetch } = await import("./js/capture-gps-prefetch.js");
    resetCapturePositionCache();
    resetCaptureGpsPrefetch();
  });
  const beforeCount = await page.evaluate(async (vid) => {
    const { getAllMediaForVacation } = await import("./js/db.js");
    return (await getAllMediaForVacation(vid)).length;
  }, vacationId);
  const jpeg = await makeJpeg(page, 7);
  const filePayload = { name: "fallback.jpg", mimeType: "image/jpeg", buffer: jpeg };
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
  await page.locator('[data-footer-action="camera"]').click();
  const chooser = await chooserPromise;
  if (chooser) {
    await chooser.setFiles(filePayload);
  } else {
    await page.locator('[data-testid="capture-photo-input"]').setInputFiles(filePayload);
  }
  let mediaReady = false;
  for (let i = 0; i < 48; i++) {
    mediaReady = await page.evaluate(
      async ({ vid, beforeCount }) => {
        const { getAllMediaForVacation } = await import("./js/db.js");
        return (await getAllMediaForVacation(vid)).length > beforeCount;
      },
      { vid: vacationId, beforeCount }
    );
    if (mediaReady) break;
    await page.waitForTimeout(250);
  }
  if (!mediaReady) {
    throw new Error(`${label}: ohne GPS wurde kein Foto gespeichert`);
  }
  const outcome = await page.evaluate(async (vacationId) => {
    const { getAllMediaForVacation } = await import("./js/db.js");
    const all = await getAllMediaForVacation(vacationId);
    const sorted = all.sort((a, b) => a.ts - b.ts);
    const toast = document.querySelector('[data-testid="app-toast"]')?.textContent ?? "";
    return {
      placeId: sorted[sorted.length - 1]?.placeId,
      toast,
      warned: toast.includes("Standort nicht verfügbar"),
    };
  }, vacationId);
  if (outcome.placeId !== selectedId) {
    throw new Error(
      `${label}: ohne GPS soll zur ausgewählten Karte (${outcome.placeId} vs ${selectedId}, toast=${JSON.stringify(outcome.toast)})`
    );
  }
}

async function assertCaptureInputAttributes(page, label) {
  const attrs = await page.evaluate(() => {
    const photo = document.querySelector('[data-testid="capture-photo-input"]');
    const video = document.querySelector('[data-testid="capture-video-input"]');
    const gallery = document.querySelector('[data-role="gallery-input"]');
    return {
      photoAccept: photo?.getAttribute("accept"),
      photoCapture: photo?.getAttribute("capture"),
      videoAccept: video?.getAttribute("accept"),
      videoCapture: video?.getAttribute("capture"),
      galleryAccept: gallery?.getAttribute("accept"),
    };
  });
  if (attrs.photoAccept !== "image/*" || attrs.photoCapture !== "environment") {
    throw new Error(`${label}: Foto-Input falsch (${JSON.stringify(attrs)})`);
  }
  if (attrs.videoAccept !== "video/*" || attrs.videoCapture !== "environment") {
    throw new Error(`${label}: Video-Input falsch (${JSON.stringify(attrs)})`);
  }
  if (!attrs.galleryAccept?.includes("image") || !attrs.galleryAccept?.includes("video")) {
    throw new Error(`${label}: Mediathek-Input soll Bild+Video (${attrs.galleryAccept})`);
  }
}

async function assertPlaceCardCamera(page, label) {
  await page.evaluate(() => {
    window.__captureOpens = 0;
    document.querySelector('[data-role="capture-photo-input"]')?.addEventListener("click", () => {
      window.__captureOpens = (window.__captureOpens || 0) + 1;
    });
  });
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 3000 }).catch(() => null);
  await page.locator('.oc--selected [data-action="camera-place"]').click();
  const chooser = await chooserPromise;
  if (chooser) await chooser.setFiles([]);
  const opens = await page.evaluate(() => window.__captureOpens ?? 0);
  if (opens !== 1) {
    throw new Error(`${label}: Ortskarten-Kamera öffnete capture ${opens}x statt 1x`);
  }
  await page.waitForTimeout(900);
  const err = await page.evaluate(() => window.__lastError ?? null);
  if (err?.includes("openCameraSheet")) {
    throw new Error(`${label}: openCameraSheet ReferenceError`);
  }
}

async function assertMapFooterCamera(page, label, vacationId) {
  await page.waitForFunction(() => {
    const toast = document.querySelector('[data-testid="app-toast"]');
    return !toast || !toast.classList.contains("toast--visible");
  });
  await page.route("**/routing.openstreetmap.de/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"routes":[]}' })
  );
  await page.evaluate(async () => {
    const { setMapRoutesEnabled } = await import("./js/settings-store.js");
    await setMapRoutesEnabled(false);
  });
  await page.click('[data-action="map"]');
  await page.waitForSelector('[data-testid="map-screen"]');
  await page.evaluate(() => {
    window.__mapCaptureOpens = 0;
    const el =
      document.querySelector('[data-testid="map-capture-photo-input"]') ||
      document.querySelector('[data-role="capture-photo-input"]');
    el?.addEventListener("click", () => {
      window.__mapCaptureOpens = (window.__mapCaptureOpens || 0) + 1;
    });
  });
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 8000 }).catch(() => null);
  await page.locator('[data-testid="map-screen"] [data-footer-action="camera"]').click();
  const chooser = await chooserPromise;
  if (chooser) await chooser.setFiles([]);
  const opens = await page.evaluate(() => window.__mapCaptureOpens ?? 0);
  if (!chooser && opens < 1) {
    throw new Error(`${label}: Karten-Footer-Kamera öffnete capture ${opens}x, kein Filechooser`);
  }
}

async function assertMapDeepLinkBack(page, label, vacationId) {
  await page.goto(`./#/urlaub/${vacationId}/karte`);
  await page.waitForSelector('[data-testid="map-screen"]');
  await page.click('[data-testid="map-screen"] [data-action="back"]');
  await page.waitForFunction(
    (vid) => location.hash === `#/urlaub/${vid}`,
    vacationId,
    { timeout: 15000 }
  );
  await page.waitForSelector(".trip-header__title");
}

async function assertStaleNavOverviewFlag(page, label, vacationId) {
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.evaluate(() => {
    sessionStorage.setItem("vacrecap-nav-from-overview", "1");
  });
  await page.reload();
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.locator('.link-btn--back[data-action="back"]').click();
  await page.waitForFunction(() => location.hash.includes("/urlaube"), null, { timeout: 15000 });
  const title = await page.locator(".top-bar__title").textContent();
  if (title?.trim() !== "Reisen") {
    throw new Error(`${label}: ‹ Reisen nach Direktlink nicht zur Übersicht (${title})`);
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

  page.on("pageerror", (err) => {
    void page.evaluate((msg) => {
      window.__lastError = msg;
    }, String(err));
  });

  const vacationId = await seedTripWithPlace(page);
  await assertCaptureInputAttributes(page, "375x667");
  await assertPlaceCardCamera(page, "375x667");
  await assertFooterGpsNearPlace(page, "375x667", vacationId);
  await assertMapFooterCamera(page, "375x667", vacationId);
  await assertMapDeepLinkBack(page, "375x667", vacationId);
  await assertStaleNavOverviewFlag(page, "375x667", vacationId);
  await assertFooterGpsDenied(page, "375x667", vacationId);

  await ctx.close();
  await browser.close();
  server.close();
  console.log("Playwright 5e tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
