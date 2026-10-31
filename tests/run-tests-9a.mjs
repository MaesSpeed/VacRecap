import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";
import { parseExifTiff } from "../js/exif-taken-at.js";
import { validateWaypointInsert } from "./waypoint-constraints.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const TODAY = "2026-10-29";
const OTHER_DAY = "2026-10-28";
const EMPTY_DAY = "2026-10-31";
const HAFEN = { lat: 48.8566, lng: 2.3522 };

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function entry(tag, type, count, value) {
  return Buffer.concat([u16(tag), u16(type), u32(count), u32(value >>> 0)]);
}
function rational(n) {
  const den = 100000;
  const num = Math.round(Number(n) * den);
  return Buffer.concat([u32(num), u32(den)]);
}
function dms(dd) {
  const abs = Math.abs(dd);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  return [deg, min, sec];
}

export function buildTiff({ lat, lng, date }) {
  const dateStr = Buffer.from(`${date}\0`, "ascii");
  if (dateStr.length !== 20) throw new Error(`EXIF-Datum muss 19 Zeichen sein (${date})`);
  const [latD, latM, latS] = dms(lat);
  const [lngD, lngM, lngS] = dms(lng);
  const latRef = lat < 0 ? "S".charCodeAt(0) : "N".charCodeAt(0);
  const lngRef = lng < 0 ? "W".charCodeAt(0) : "E".charCodeAt(0);
  const tiff = Buffer.concat([
    Buffer.from([0x49, 0x49]),
    u16(0x2a),
    u32(8),
    u16(2),
    entry(0x8769, 4, 1, 38),
    entry(0x8825, 4, 1, 76),
    u32(0),
    u16(1),
    entry(0x9003, 2, 20, 56),
    u32(0),
    dateStr,
    u16(4),
    entry(1, 2, 2, latRef),
    entry(2, 5, 3, 130),
    entry(3, 2, 2, lngRef),
    entry(4, 5, 3, 154),
    u32(0),
    rational(latD),
    rational(latM),
    rational(latS),
    rational(lngD),
    rational(lngM),
    rational(lngS),
  ]);
  return tiff;
}

function jpegWithExif(baseJpeg, meta) {
  const tiff = buildTiff(meta);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const size = Buffer.alloc(2);
  size.writeUInt16BE(payload.length + 2);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), size, payload]);
  if (baseJpeg[0] !== 0xff || baseJpeg[1] !== 0xd8) throw new Error("kein JPEG");
  return Buffer.concat([baseJpeg.subarray(0, 2), app1, baseJpeg.subarray(2)]);
}

function heicWithExif(meta) {
  return Buffer.concat([
    Buffer.from("ftypheic"),
    Buffer.from("Exif\0\0", "ascii"),
    buildTiff(meta),
    Buffer.from("mdat"),
  ]);
}

function selfCheckExif() {
  const tiff = buildTiff({ lat: 45.5, lng: -9.25, date: "2026:10:28 15:12:00" });
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const parsed = parseExifTiff(view, 0);
  assert(Math.abs(parsed.latitude - 45.5) < 0.0002, `lat ${parsed.latitude}`);
  assert(Math.abs(parsed.longitude - -9.25) < 0.0002, `lng ${parsed.longitude}`);
  const d = new Date(parsed.takenAt);
  assert(d.getFullYear() === 2026 && d.getMonth() === 9 && d.getDate() === 28, "EXIF-Tag");
  assert(d.getHours() === 15 && d.getMinutes() === 12, "EXIF-Zeit");
}

function north(lat, meters) {
  return lat + meters / 111320;
}

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
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
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

function createMockSupabaseState() {
  const userId = "11111111-1111-1111-1111-111111111111";
  const session = {
    access_token: "test-access",
    refresh_token: "test-refresh",
    user: { id: userId, email: "test@example.com" },
  };
  const trips = [];
  const waypoints = [];
  const notes = [];
  const media = [];
  let failWaypointWrites = false;
  let mediaError = null;

  function represent(row, headers) {
    const accept = headers.accept || "";
    if (accept.includes("application/vnd.pgrst.object+json")) return row;
    return [row];
  }
  function applyFilters(rows, url) {
    let out = rows.slice();
    for (const [key, value] of url.searchParams.entries()) {
      if (["select", "order", "offset", "limit", "on_conflict"].includes(key)) continue;
      if (value === "is.null") out = out.filter((row) => row[key] == null);
      else if (value.startsWith("eq.")) out = out.filter((row) => String(row[key]) === value.slice(3));
      else if (value.startsWith("not.is.")) out = out.filter((row) => row[key] != null);
    }
    return out;
  }
  return {
    trips,
    waypoints,
    notes,
    media,
    setFailWaypointWrites(value) {
      failWaypointWrites = Boolean(value);
    },
    setMediaError(value) {
      mediaError = value;
    },
    liveWaypoints() {
      return waypoints.filter((w) => !w.deleted_at);
    },
    handleAuth(url, method, body) {
      const pathName = url.pathname;
      if (pathName.endsWith("/otp") && method === "POST") return { status: 200, json: {} };
      if (pathName.endsWith("/verify") && method === "POST") {
        const parsed = JSON.parse(body || "{}");
        if (parsed.token !== "123456") return { status: 400, json: { message: "Invalid" } };
        return { status: 200, json: session };
      }
      if (pathName.endsWith("/token") && method === "POST") return { status: 200, json: session };
      if (pathName.endsWith("/user") && method === "GET") return { status: 200, json: session.user };
      return { status: 404, json: {} };
    },
    handleStorage(url, method, body) {
      const p = url.pathname;
      if (p.includes("/object/sign/") && method === "POST") {
        let payload = {};
        try {
          payload = JSON.parse(body || "{}");
        } catch {
          payload = {};
        }
        if (Array.isArray(payload.paths)) {
          return {
            status: 200,
            json: payload.paths.map((one) => ({
              error: null,
              path: one,
              signedURL: `/object/sign/mock?token=${encodeURIComponent(one)}`,
            })),
          };
        }
        return { status: 200, json: { signedURL: "/object/sign/mock?token=1" } };
      }
      if (p.includes("/object/") && (method === "POST" || method === "PUT")) return { status: 200, json: { Key: "ok" } };
      return { status: 404, json: {} };
    },
    handleRest(url, method, body, headers) {
      const table = url.pathname.split("/").filter(Boolean).pop();
      const upsert = (list, row) => {
        const id = row.id || crypto.randomUUID();
        const hit = list.find((item) => item.id === id);
        const full = {
          created_by: userId,
          created_at: hit?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null,
          ...row,
          id,
        };
        if (hit) Object.assign(hit, full);
        else list.push(full);
        return full;
      };
      if (table === "trips") {
        if (method === "POST") return { status: 201, json: represent(upsert(trips, JSON.parse(body || "{}")), headers) };
        if (method === "GET") return { status: 200, json: applyFilters(trips, url) };
      }
      if (table === "waypoints") {
        if (method === "GET") return { status: 200, json: applyFilters(waypoints, url) };
        if (method === "POST") {
          const row = JSON.parse(body || "{}");
          if (failWaypointWrites) {
            return { status: 400, json: { code: "23514", message: 'new row for relation "waypoints" violates check constraint "waypoints_source_check"' } };
          }
          const violation = validateWaypointInsert(row);
          if (violation) return { status: 400, json: violation };
          return { status: 201, json: represent(upsert(waypoints, row), headers) };
        }
        if (method === "PATCH") {
          const rows = applyFilters(waypoints, url);
          const row = JSON.parse(body || "{}");
          if (!rows[0]) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
          Object.assign(rows[0], row, { updated_at: new Date().toISOString() });
          return { status: 200, json: represent(rows[0], headers) };
        }
      }
      if (table === "notes") {
        if (method === "GET") return { status: 200, json: applyFilters(notes, url) };
        if (method === "POST") return { status: 201, json: represent(upsert(notes, JSON.parse(body || "{}")), headers) };
      }
      if (table === "media") {
        if (method === "GET") return { status: 200, json: applyFilters(media, url) };
        if (method === "POST") {
          if (mediaError) return { status: 400, json: { message: mediaError } };
          return { status: 201, json: represent(upsert(media, JSON.parse(body || "{}")), headers) };
        }
        if (method === "PATCH") {
          const rows = applyFilters(media, url);
          const row = JSON.parse(body || "{}");
          if (!rows[0]) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
          Object.assign(rows[0], row, { updated_at: new Date().toISOString() });
          return { status: 200, json: represent(rows[0], headers) };
        }
      }
      if (table === "trip_members" && method === "GET") return { status: 200, json: [{ role: "owner" }] };
      return { status: 404, json: { message: "not found" } };
    },
  };
}

async function installSupabaseMocks(page, state, geocode) {
  await page.context().route(`**/${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    let result;
    if (url.pathname.includes("/auth/v1/")) result = state.handleAuth(url, req.method(), req.postData());
    else if (url.pathname.includes("/storage/v1/")) result = state.handleStorage(url, req.method(), req.postData());
    else if (url.pathname.includes("/rest/v1/")) result = state.handleRest(url, req.method(), req.postData(), req.headers());
    else result = { status: 404, json: {} };
    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      body: result.json == null ? "" : JSON.stringify(result.json),
    });
  });
  await page.context().route("**/nominatim.openstreetmap.org/**", async (route) => {
    if (geocode.delay) await new Promise((r) => setTimeout(r, geocode.delay));
    if (geocode.abort) return route.abort();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ name: geocode.name || "Spiaggia Baia" }),
    });
  });
}

async function resetGps(page) {
  await page.evaluate(async () => {
    const { resetCapturePositionCache } = await import("./js/geo.js");
    const { resetCaptureGpsPrefetch } = await import("./js/capture-gps-prefetch.js");
    resetCapturePositionCache();
    resetCaptureGpsPrefetch();
  });
}

async function closeOverlay(page) {
  const open = await page.locator("#overlay-root:not([hidden]) .sheet").count();
  if (!open) return;
  const close = page.locator('[data-testid="photo-upload-sheet"] [data-action="close"]');
  if (await close.count()) {
    await close.click();
  } else {
    const keep = page.locator('[data-testid="photo-assign-keep"]');
    if (await keep.count()) await keep.click();
  }
  await page.waitForFunction(() => {
    const root = document.getElementById("overlay-root");
    return !root || root.hidden;
  });
}

async function waitLiveCount(page, state, count) {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (state.liveWaypoints().length === count) return;
    await page.waitForTimeout(40);
  }
  throw new Error(`Orte ${state.liveWaypoints().length} statt ${count}: ${state.liveWaypoints().map((w) => w.title).join(", ")}`);
}

async function waitUploadDone(page) {
  await page.waitForSelector('[data-testid="photo-upload-sheet"]', { timeout: 15000 });
  await page.waitForFunction(() => {
    const items = [...document.querySelectorAll(".photo-upload-item__status")];
    return items.length >= 1 && items.every((el) => el.textContent?.includes("✓"));
  });
}

function png(name) {
  return { name, mimeType: "image/png", buffer: TINY_PNG };
}

async function loginAndCreateTrip(page) {
  await page.waitForSelector('[data-testid="login-screen"]');
  await page.evaluate(async () => {
    const { setRememberLocationOnOpen } = await import("./js/settings-store.js");
    await setRememberLocationOnOpen(false);
  });
  await page.fill('input[name="email"]', "test@example.com");
  await page.click('form[data-step="email"] button[type="submit"]');
  await page.waitForSelector('form[data-step="otp"]');
  await page.fill('input[name="otp"]', "123456");
  await page.click('form[data-step="otp"] button[type="submit"]');
  await page.waitForSelector(".screen--urlaube");
  await page.click('[data-action="new"]');
  const titleInput = page.locator('input[name="title"]');
  assert((await titleInput.getAttribute("maxlength")) === "200", "Titel-maxlength fehlt");
  await titleInput.fill("A".repeat(250));
  await titleInput.dispatchEvent("input");
  const len = (await titleInput.inputValue()).length;
  assert(len === 200, `Titel nicht auf 200 begrenzt (${len})`);
  await titleInput.fill("Gardasee");
  await page.click('[data-action="pick-dates"]');
  await page.click('.calendar-day[data-date="2026-10-27"]');
  await page.click('.calendar-day[data-date="2026-10-31"]');
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2026-10-29"
  );
  return page.locator(".screen--trip").getAttribute("data-vacation-id");
}

async function seedPlace(page, { vacationId, day, name, lat, lng, ts }) {
  return page.evaluate(
    async ({ vacationId, day, name, lat, lng, ts }) => {
      const { createPlace } = await import("./js/places.js");
      const { putPlace } = await import("./js/db.js");
      const place = createPlace({
        vacationId,
        day,
        ts: ts || Date.parse(`${day}T09:20:00`),
        lat,
        lng,
        name,
        source: "manual",
      });
      const saved = await putPlace(place);
      return saved.id;
    },
    { vacationId, day, name, lat, lng, ts }
  );
}

async function selectPlace(page, placeId) {
  const card = page.locator(`.oc[data-place-id="${placeId}"]`);
  await card.waitFor();
  if (!(await card.evaluate((el) => el.classList.contains("oc--selected")))) {
    await card.click();
    await page.waitForSelector(`.oc--selected[data-place-id="${placeId}"]`);
  }
}

async function shoot(page, file, { card = false } = {}) {
  await resetGps(page);
  if (!card) {
    await page.locator('[data-testid="capture-photo-input"]').setInputFiles(file);
    return;
  }
  const chooser = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
  await page.locator('.oc--selected [data-action="camera-place"]').click();
  const ch = await chooser;
  if (ch) await ch.setFiles(file);
  else await page.locator('[data-testid="capture-photo-input"]').setInputFiles(file);
}

async function runSuite(browserType, baseUrl, label) {
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({
    ...devices["iPhone 8"],
    viewport: { width: 375, height: 667 },
    baseURL: baseUrl,
    geolocation: { latitude: HAFEN.lat, longitude: HAFEN.lng, accuracy: 10 },
    permissions: ["geolocation"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(25_000);
  const state = createMockSupabaseState();
  const geocode = { delay: 0, name: "Spiaggia Baia", abort: false };
  await installSupabaseMocks(page, state, geocode);
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  // Feste Test-Uhr: «heute» bleibt der 29.10.2026, Timer laufen weiter echt.
  await page.addInitScript(() => {
    const RealDate = Date;
    const fixed = new RealDate(2026, 9, 29, 12, 0, 0, 0).getTime();
    function TestDate(...args) {
      if (!new.target) return new RealDate(fixed).toString();
      if (args.length === 0) return new RealDate(fixed);
      return new RealDate(...args);
    }
    TestDate.prototype = RealDate.prototype;
    TestDate.now = () => fixed;
    TestDate.parse = RealDate.parse.bind(RealDate);
    TestDate.UTC = RealDate.UTC.bind(RealDate);
    window.Date = TestDate;
  });
  await page.addInitScript(() => {
    const geo = navigator.geolocation;
    if (!geo || geo.__vacWrapped) return;
    const orig = geo.getCurrentPosition.bind(geo);
    geo.getCurrentPosition = function (ok, err, opts) {
      if (window.__denyGps) {
        err?.({ code: 1, PERMISSION_DENIED: 1, message: "denied" });
        return;
      }
      return orig(ok, err, opts);
    };
    geo.__vacWrapped = true;
  });

  await page.goto(baseUrl);
  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  assert(Number(build) === 56, `${label}: Build ${build}`);

  const heicBytes = [...heicWithExif({ lat: 45.5, lng: 10.25, date: "2026:10:28 15:12:00" })];
  const heic = await page.evaluate(async (bytes) => {
    const file = new File([new Uint8Array(bytes)], "strand.heic", { type: "image/heic" });
    const { readPhotoExif } = await import("./js/exif-taken-at.js");
    return readPhotoExif(file);
  }, heicBytes);
  assert(Math.abs(heic.latitude - 45.5) < 0.0002, `${label}: HEIC-Lat ${heic.latitude}`);
  assert(Math.abs(heic.longitude - 10.25) < 0.0002, `${label}: HEIC-Lng ${heic.longitude}`);

  const radius = await page.evaluate(async () => {
    const { getSamePlaceRadiusM, samePlaceRadiusOptions } = await import("./js/settings-store.js");
    return { value: await getSamePlaceRadiusM(), options: samePlaceRadiusOptions() };
  });
  assert(radius.value === 250, `${label}: Standardradius ${radius.value}`);
  assert(radius.options.includes(250), `${label}: 250 m fehlt in den Optionen`);

  const vacationId = await loginAndCreateTrip(page);
  await page.click('[data-action="settings"]');
  await page.waitForSelector('[data-radius="250"].settings-segment--active');
  const segments = await page.locator(".settings-segment").count();
  assert(segments === 6, `${label}: Radius-Segmente ${segments}`);
  await page.click('[data-action="back"]');
  await page.waitForSelector('[data-testid="trip-content"]');

  const hafenId = await seedPlace(page, {
    vacationId,
    day: TODAY,
    name: "Hafen Malcesine",
    lat: HAFEN.lat,
    lng: HAFEN.lng,
    ts: Date.parse(`${TODAY}T11:40:00`),
  });
  await page.waitForSelector(`.oc[data-place-id="${hafenId}"]`);
  await selectPlace(page, hafenId);

  const jpegBase = Buffer.from(
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 80;
      canvas.height = 60;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#3d7ea6";
      ctx.fillRect(0, 0, 80, 60);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
      return [...new Uint8Array(await blob.arrayBuffer())];
    })
  );

  function exifFile(name, meta) {
    return { name, mimeType: "image/jpeg", buffer: jpegWithExif(jpegBase, meta) };
  }

  await shoot(page, png("passt.png"));
  await waitUploadDone(page);
  assert(
    state.media.some((m) => m.waypoint_id === hafenId),
    `${label}: passendes Foto nicht auf Hafen`
  );
  assert(state.liveWaypoints().length === 1, `${label}: passendes Foto hat eine Karte angelegt`);
  await closeOverlay(page);

  await context.setGeolocation({ latitude: north(HAFEN.lat, 200), longitude: HAFEN.lng, accuracy: 10 });
  await shoot(page, png("zweihundert.png"));
  await waitUploadDone(page);
  assert(state.liveWaypoints().length === 1, `${label}: 200 m bei Standard 250 m sollte passen`);
  await closeOverlay(page);

  await page.evaluate(async () => {
    const { setSamePlaceRadiusM } = await import("./js/settings-store.js");
    await setSamePlaceRadiusM(100);
  });
  await context.setGeolocation({ latitude: north(HAFEN.lat, 180), longitude: HAFEN.lng, accuracy: 95 });
  await shoot(page, png("ungenau-nah.png"));
  await waitUploadDone(page);
  assert(state.liveWaypoints().length === 1, `${label}: 180 m bei 2× Genauigkeit sollte auf der Karte bleiben`);
  await closeOverlay(page);

  await context.setGeolocation({ latitude: north(HAFEN.lat, 180), longitude: HAFEN.lng, accuracy: 20 });
  const beforeFar = state.liveWaypoints().length;
  await shoot(page, png("radius-eng.png"));
  await page.waitForFunction(() => document.querySelector('[data-testid="app-toast"]')?.textContent?.includes("Neue Karte"));
  await page.click('[data-testid="app-toast"] [data-action="undo"]');
  await waitLiveCount(page, state, beforeFar);
  await waitUploadDone(page);
  assert(state.media.filter((m) => m.waypoint_id === hafenId).length >= 3, `${label}: Rückgängig nach engem Radius`);
  assert(
    state.liveWaypoints().length === beforeFar,
    `${label}: enger Radius lässt die neue Karte stehen live=${JSON.stringify(state.waypoints.map((w) => ({ t: w.title, del: Boolean(w.deleted_at), day: w.day })))} media=${JSON.stringify(state.media.map((m) => ({ wp: m.waypoint_id, day: m.day, st: m.upload_status })))}`
  );
  await closeOverlay(page);
  await page.evaluate(async () => {
    const { setSamePlaceRadiusM } = await import("./js/settings-store.js");
    await setSamePlaceRadiusM(250);
  });

  await context.setGeolocation({ latitude: north(HAFEN.lat, 600), longitude: HAFEN.lng, accuracy: 8 });
  await shoot(page, png("weit.png"));
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="app-toast"]')?.textContent || "";
    return t.includes("Neue Karte") && t.includes("Spiaggia Baia") && t.includes("Rückgängig");
  });
  const toast = await page.locator('[data-testid="app-toast"]').innerText();
  assert(/ca\.\s*\d+\s*m entfernt/.test(toast), `${label}: Distanz fehlt (${toast})`);
  await page.waitForSelector('[data-testid="place-new-badge"]');
  await page.click('[data-testid="app-toast"] [data-action="undo"]');
  await waitLiveCount(page, state, 1);
  await waitUploadDone(page);
  assert(
    state.media.every((m) => m.waypoint_id === hafenId),
    `${label}: Undo lässt das Foto auf der neuen Karte`
  );
  assert(state.liveWaypoints().every((w) => w.id === hafenId || w.title === "Hafen Malcesine"), `${label}: neue Karte nach Undo noch da`);
  assert(state.liveWaypoints().length === 1, `${label}: Undo löscht die leere Karte nicht (${state.liveWaypoints().map((w) => w.title).join(",")})`);
  await closeOverlay(page);

  await selectPlace(page, hafenId);
  await context.setGeolocation({ latitude: north(HAFEN.lat, 700), longitude: HAFEN.lng, accuracy: 8 });
  await shoot(page, png("karten-kamera.png"), { card: true });
  await page.waitForFunction(() => document.querySelector('[data-testid="app-toast"]')?.textContent?.includes("Neue Karte"));
  await page.click('[data-testid="app-toast"] [data-action="undo"]');
  await waitLiveCount(page, state, 1);
  await waitUploadDone(page);
  assert(state.liveWaypoints().length === 1, `${label}: Karten-Kamera legt dauerhaft eine Karte an`);
  await closeOverlay(page);

  const viaId = await seedPlace(page, {
    vacationId,
    day: TODAY,
    name: "Via Forneletti",
    lat: north(HAFEN.lat, 200),
    lng: HAFEN.lng,
    ts: Date.parse(`${TODAY}T09:20:00`),
  });
  await page.waitForSelector(`.oc[data-place-id="${viaId}"]`);
  await selectPlace(page, hafenId);
  await context.setGeolocation({ latitude: north(HAFEN.lat, 350), longitude: HAFEN.lng, accuracy: 10 });
  await shoot(page, png("nachbar.png"));
  await waitUploadDone(page);
  assert(state.media.some((m) => m.waypoint_id === viaId), `${label}: Nachbarkarte innerhalb 250 m wurde nicht genutzt`);
  assert(state.liveWaypoints().length === 2, `${label}: Nachbarfall legt eine neue Karte an`);
  await closeOverlay(page);

  await selectPlace(page, hafenId);
  await context.setGeolocation({ latitude: north(HAFEN.lat, 800), longitude: HAFEN.lng, accuracy: 400 });
  await shoot(page, png("unscharf.png"));
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="app-toast"]')?.textContent || "";
    return t.includes("Standort ungenau") && t.includes("Ändern");
  });
  assert(!state.liveWaypoints().some((w) => w.title === "Spiaggia Baia"), `${label}: ungenaues GPS legt eine Karte an`);
  await page.click('[data-testid="app-toast"] [data-action="undo"]');
  await page.waitForSelector('[data-testid="photo-target-sheet"]');
  await page.click('[data-testid="photo-target-sheet"] [data-action="cancel"]');
  await waitUploadDone(page);
  assert(state.media.some((m) => m.waypoint_id === hafenId && m.day === TODAY), `${label}: ungenaues Foto nicht auf Hafen`);
  await closeOverlay(page);

  await page.evaluate(() => {
    window.__denyGps = true;
  });
  await shoot(page, png("ohne-gps.png"));
  await page.waitForFunction(() => document.querySelector('[data-testid="app-toast"]')?.textContent?.includes("Standort ungenau"));
  await waitUploadDone(page);
  await closeOverlay(page);
  await page.evaluate(() => {
    window.__denyGps = false;
  });
  await context.setGeolocation({ latitude: HAFEN.lat, longitude: HAFEN.lng, accuracy: 10 });

  const near = exifFile("nah.jpg", { lat: HAFEN.lat, lng: HAFEN.lng, date: "2026:10:29 11:40:00" });
  const farA = exifFile("fern-a.jpg", { lat: north(HAFEN.lat, 650), lng: HAFEN.lng, date: "2026:10:29 15:12:00" });
  const farA2 = exifFile("fern-a2.jpg", { lat: north(HAFEN.lat, 680), lng: HAFEN.lng, date: "2026:10:29 15:13:00" });
  const farB = exifFile("fern-b.jpg", { lat: north(HAFEN.lat, 1400), lng: HAFEN.lng, date: "2026:10:29 16:00:00" });
  const noGps = png("ohne.jpg");
  await page.evaluate(
    async ({ vacationId, placeId }) => {
      const { saveTripSelection } = await import("./js/trip-selection-store.js");
      await saveTripSelection(vacationId, {
        activeDay: "2026-10-29",
        selectedByDay: { "2026-10-29": placeId },
      });
    },
    { vacationId, placeId: hafenId }
  );
  await page.locator('[data-footer-action="gallery"]').click();
  await page.waitForSelector('[data-testid="trip-library"]');
  await page.setInputFiles('[data-testid="library-gallery-input"]', [near, farA, farA2, farB, noGps]);
  await page.waitForSelector('[data-testid="photo-assign-sheet"]');
  const assignText = await page.locator('[data-testid="photo-assign-sheet"]').innerText();
  assert(assignText.includes("5 Fotos zuordnen"), `${label}: Zuordnungstitel (${assignText})`);
  assert(assignText.includes("Hafen Malcesine"), `${label}: ausgewählte Karte fehlt`);
  assert(assignText.includes("Neue Karte"), `${label}: Cluster fehlt`);
  assert(assignText.includes("Foto ohne Standort") || assignText.includes("ohne GPS"), `${label}: Foto ohne GPS fehlt`);
  assert((await page.locator('[data-testid="photo-assign-group"]').count()) >= 3, `${label}: zu wenige Gruppen`);
  const keepLabel = await page.locator('[data-testid="photo-assign-keep"]').innerText();
  assert(keepLabel.includes("Alle auf") && keepLabel.includes("Hafen Malcesine") && keepLabel.includes("ablegen"), keepLabel);
  const box = await page.locator('[data-testid="photo-assign-sheet"]').boundingBox();
  assert(box && box.y + box.height <= 667 + 2, `${label}: Zuordnungs-Sheet ragt aus dem iPhone-8 (${JSON.stringify(box)})`);
  await page.locator('[data-testid="photo-assign-keep"]').click();
  await waitUploadDone(page);
  const kept = state.media.filter((m) => m.day === TODAY && m.waypoint_id === hafenId);
  assert(kept.length >= 5, `${label}: Ablegen auf der Karte hat Fotos verworfen (${kept.length})`);
  assert(!state.liveWaypoints().some((w) => w.title === "Spiaggia Baia"), `${label}: Ablegen hat trotzdem eine Karte angelegt`);
  await closeOverlay(page);
  await page.locator('[data-testid="library-back"]').click();
  await page.waitForSelector('[data-testid="trip-content"]');

  await selectPlace(page, hafenId);
  await page.setInputFiles('[data-testid="gallery-input"]', [
    exifFile("passt-1.jpg", { lat: HAFEN.lat + 0.0001, lng: HAFEN.lng, date: "2026:10:29 11:41:00" }),
    exifFile("passt-2.jpg", { lat: HAFEN.lat + 0.00015, lng: HAFEN.lng, date: "2026:10:29 11:42:00" }),
  ]);
  await page.waitForSelector('[data-testid="photo-upload-sheet"]');
  assert((await page.locator('[data-testid="photo-assign-sheet"]').count()) === 0, `${label}: Sheet obwohl alle Fotos passen`);
  await waitUploadDone(page);
  await closeOverlay(page);

  await page.setInputFiles('[data-testid="gallery-input"]', [
    exifFile("gruppe-fern.jpg", { lat: north(HAFEN.lat, 900), lng: HAFEN.lng, date: "2026:10:29 15:12:00" }),
    exifFile("gruppe-nah.jpg", { lat: HAFEN.lat, lng: HAFEN.lng, date: "2026:10:29 11:45:00" }),
  ]);
  await page.waitForSelector('[data-testid="photo-assign-sheet"]');
  const newGroup = page.locator('[data-testid="photo-assign-group"]').filter({ hasText: "Neue Karte" });
  await newGroup.locator('[data-action="change"]').click();
  await page.waitForSelector('[data-testid="photo-target-sheet"]');
  const targetText = await page.locator('[data-testid="photo-target-sheet"]').innerText();
  assert(targetText.includes("Ziel für"), `${label}: Ziel-Sheet (${targetText})`);
  assert(targetText.includes("Hafen Malcesine"), `${label}: Ziel ohne ausgewählte Karte`);
  assert(targetText.includes("Ohne Ort"), `${label}: Ohne Ort fehlt im Ziel`);
  await page.locator('[data-testid="photo-target-option"]').filter({ hasText: "Hafen Malcesine" }).click();
  await page.locator('[data-testid="photo-assign-upload"]').click();
  await waitUploadDone(page);
  assert(!state.liveWaypoints().some((w) => /Spiaggia|Ort \d{2}:\d{2}/.test(w.title) && w.day === TODAY && w.id !== hafenId && w.id !== viaId), `${label}: Umstellen hat eine neue Karte angelegt`);
  await closeOverlay(page);

  await page.setInputFiles('[data-testid="gallery-input"]', [
    exifFile("gestern.jpg", { lat: north(HAFEN.lat, 500), lng: HAFEN.lng, date: "2026:10:28 10:00:00" }),
  ]);
  await page.waitForSelector('[data-testid="photo-assign-other-day"]');
  const dayNote = await page.locator('[data-testid="photo-assign-other-day"]').innerText();
  assert(dayNote.includes("28"), `${label}: anderer Aufnahmetag nicht sichtbar (${dayNote})`);
  await page.locator('[data-testid="photo-assign-upload"]').click();
  await waitUploadDone(page);
  assert(state.media.some((m) => m.day === OTHER_DAY), `${label}: Foto nicht auf dem Aufnahmetag`);
  assert(state.liveWaypoints().some((w) => w.day === OTHER_DAY), `${label}: keine Karte am Aufnahmetag`);
  await closeOverlay(page);

  const outsideBefore = state.media.length;
  await page.setInputFiles('[data-testid="gallery-input"]', [
    exifFile("ausserhalb.jpg", { lat: HAFEN.lat, lng: HAFEN.lng, date: "2020:01:01 08:00:00" }),
  ]);
  await page.waitForSelector('[data-testid="photo-upload-sheet"]');
  assert((await page.locator('[data-testid="photo-assign-sheet"]').count()) === 0, `${label}: Tag außerhalb öffnet das Sheet`);
  await waitUploadDone(page);
  const outside = state.media.slice(outsideBefore);
  assert(outside.some((m) => m.day === TODAY && m.waypoint_id === hafenId), `${label}: Tag außerhalb verlässt den gewählten Tag`);
  await closeOverlay(page);

  await page.click(`[data-day="${EMPTY_DAY}"]`);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2026-10-31"
  );
  state.setFailWaypointWrites(true);
  await page.setInputFiles('[data-testid="gallery-input"]', [png("m1.png"), png("m2.png"), png("m3.png")]);
  await page.waitForSelector('[data-testid="photo-upload-sheet"] [data-action="retry"]');
  const retries = await page.locator('[data-action="retry"]').count();
  assert(retries === 3, `${label}: Retry-Buttons ${retries}`);
  state.setFailWaypointWrites(false);
  await page.locator('[data-action="retry"]').first().click();
  await waitUploadDone(page);
  const emptyPlaces = state.liveWaypoints().filter((w) => w.day === EMPTY_DAY);
  assert(emptyPlaces.length === 1, `${label}: Mutex erzeugt ${emptyPlaces.length} Orte`);
  assert(emptyPlaces[0].title === "Ohne Ort", `${label}: Mutex-Ort ${emptyPlaces[0].title}`);
  assert(state.media.filter((m) => m.waypoint_id === emptyPlaces[0].id && m.upload_status === "uploaded").length === 3, `${label}: wartende Fotos nicht alle hochgeladen`);
  await closeOverlay(page);

  const longError = "Die Verbindung zum Cloud-Speicher ist zwischendurch abgebrochen und das Bild wurde nur halb übertragen";
  assert(longError.length > 80, "Testfehler zu kurz");
  state.setMediaError(longError);
  await page.setInputFiles('[data-testid="gallery-input"]', png("fehler.png"));
  await page.waitForFunction(() =>
    (document.querySelector(".photo-upload-item__status")?.textContent || "").includes("halb übertragen")
  );
  const status = await page.locator(".photo-upload-item__status").innerText();
  assert(status.includes("halb übertragen"), `${label}: Fehler abgeschnitten (${status})`);
  assert(!status.includes(longError.slice(0, 80)) || status.length > 80, `${label}: Fehler nur 80 Zeichen`);
  state.setMediaError(null);
  await closeOverlay(page);

  geocode.delay = 3000;
  await page.click(`[data-day="${TODAY}"]`);
  await page.waitForFunction(() => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2026-10-29");
  await selectPlace(page, hafenId);
  const beforeLate = state.liveWaypoints().length;
  await context.setGeolocation({ latitude: north(HAFEN.lat, 620), longitude: HAFEN.lng, accuracy: 5 });
  await shoot(page, png("spaet.png"));
  await page.waitForFunction(() => /Neue Karte «Ort \d{2}:\d{2}»/.test(document.querySelector('[data-testid="app-toast"]')?.textContent || ""));
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Spiaggia Baia"),
    null,
    { timeout: 8000 }
  );
  await page.click('[data-testid="app-toast"] [data-action="undo"]');
  await waitLiveCount(page, state, beforeLate);
  await waitUploadDone(page);
  await closeOverlay(page);
  geocode.delay = 0;

  assert(!pageErrors.length, `${label}: Seitenfehler ${pageErrors.join(" | ")}`);
  await browser.close();
}

async function main() {
  selfCheckExif();
  const { server, baseUrl } = await startServer();
  try {
    await runSuite(chromium, baseUrl, "Chromium");
    await runSuite(webkit, baseUrl, "WebKit");
  } finally {
    server.close();
  }
  console.log("Playwright 9a tests OK (Build 56)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
