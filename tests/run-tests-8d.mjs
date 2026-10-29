import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";
import { placeToWaypointRow } from "../js/cloud-mappers.js";
import {
  validateWaypointInsert,
  WAYPOINT_SOURCE_CHECK_MESSAGE,
} from "./waypoint-constraints.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const ALLOWED_SOURCES = ["manual", "gps", "photo", "import"];

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

function reproduceConstraint() {
  const ohneOrt = {
    trip_id: "22222222-2222-2222-2222-222222222222",
    day: "2026-11-06",
    visited_at: "2026-11-06T11:00:00.000Z",
    lat: null,
    lng: null,
    title: "Ohne Ort",
    is_soft: false,
    source: "ohne-ort",
  };
  const capture = {
    ...ohneOrt,
    day: "2026-11-07",
    lat: 48.8566,
    lng: 2.3522,
    title: "Ort 12:00",
    source: "capture",
  };
  const ohneErr = validateWaypointInsert(ohneOrt);
  const captureErr = validateWaypointInsert(capture);
  assert(ohneErr?.message === WAYPOINT_SOURCE_CHECK_MESSAGE, `Ohne Ort: ${ohneErr?.message}`);
  assert(captureErr?.message === WAYPOINT_SOURCE_CHECK_MESSAGE, `Kamera: ${captureErr?.message}`);
  assert(
    validateWaypointInsert({ ...ohneOrt, source: "manual" }) === null,
    "manual mit lat null muss den Check bestehen"
  );
  assert(
    validateWaypointInsert({ ...capture, source: "photo" }) === null,
    "photo mit Koordinaten muss den Check bestehen"
  );
  const latErr = validateWaypointInsert({ ...capture, source: "gps", lat: 120 });
  assert(
    latErr?.message === 'new row for relation "waypoints" violates check constraint "waypoints_lat_check"',
    `lat: ${latErr?.message}`
  );
  const titleErr = validateWaypointInsert({ ...ohneOrt, source: "manual", title: "x".repeat(201) });
  assert(
    titleErr?.message === 'new row for relation "waypoints" violates check constraint "waypoints_title_check"',
    `title: ${titleErr?.message}`
  );
  const nullErr = validateWaypointInsert({ ...ohneOrt, source: "manual", day: null });
  assert(
    nullErr?.message === 'null value in column "day" of relation "waypoints" violates not-null constraint',
    `day: ${nullErr?.message}`
  );

  const mappedOhne = placeToWaypointRow({
    vacationId: ohneOrt.trip_id,
    day: ohneOrt.day,
    ts: Date.parse(ohneOrt.visited_at),
    lat: null,
    lng: null,
    name: "Ohne Ort",
    soft: false,
    source: "ohne-ort",
  });
  const mappedCapture = placeToWaypointRow({
    vacationId: capture.trip_id,
    day: capture.day,
    ts: Date.parse("2026-11-07T12:00:00Z"),
    lat: 48.8566,
    lng: 2.3522,
    name: "Ort 12:00",
    soft: false,
    source: "capture",
  });
  const mappedOpen = placeToWaypointRow({
    vacationId: capture.trip_id,
    day: "2026-11-08",
    ts: Date.now(),
    lat: 48.1,
    lng: 2.2,
    name: "Weich",
    soft: true,
    source: "open",
  });
  assert(validateWaypointInsert(mappedOhne) === null, `Mapper Ohne Ort bleibt ungültig: ${mappedOhne.source}`);
  assert(mappedOhne.source === "manual", mappedOhne.source);
  assert(validateWaypointInsert(mappedCapture) === null, `Mapper Kamera bleibt ungültig: ${mappedCapture.source}`);
  assert(mappedCapture.source === "photo", mappedCapture.source);
  assert(validateWaypointInsert(mappedOpen) === null, `Mapper open bleibt ungültig: ${mappedOpen.source}`);
  assert(mappedOpen.source === "gps", mappedOpen.source);
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
  const rejected = [];

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
    rejected,
    setFailWaypointWrites(value) {
      failWaypointWrites = Boolean(value);
    },
    handleAuth(url, method, body) {
      const pathName = url.pathname;
      if (pathName.endsWith("/otp") && method === "POST") return { status: 200, json: {} };
      if (pathName.endsWith("/verify") && method === "POST") {
        const parsed = JSON.parse(body || "{}");
        if (parsed.token !== "123456") {
          return { status: 400, json: { message: "Invalid" } };
        }
        return { status: 200, json: session };
      }
      if (pathName.endsWith("/token") && method === "POST") return { status: 200, json: session };
      if (pathName.endsWith("/user") && method === "GET") return { status: 200, json: session.user };
      return { status: 404, json: {} };
    },
    handleStorage(url, method) {
      const p = url.pathname;
      if (p.includes("/object/sign/") && method === "POST") {
        return { status: 200, json: { signedURL: "/object/sign/mock?token=1" } };
      }
      if (p.includes("/object/") && (method === "POST" || method === "PUT")) {
        return { status: 200, json: { Key: "ok" } };
      }
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
        if (method === "POST") {
          const row = JSON.parse(body || "{}");
          return { status: 201, json: represent(upsert(trips, row), headers) };
        }
        if (method === "GET") return { status: 200, json: applyFilters(trips, url) };
      }
      if (table === "waypoints") {
        if (method === "GET") return { status: 200, json: applyFilters(waypoints, url) };
        if (method === "POST") {
          const row = JSON.parse(body || "{}");
          if (failWaypointWrites) {
            return {
              status: 400,
              json: { code: "23514", message: WAYPOINT_SOURCE_CHECK_MESSAGE, details: null, hint: null },
            };
          }
          const violation = validateWaypointInsert(row);
          if (violation) {
            rejected.push({ row, violation });
            return { status: 400, json: violation };
          }
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
        if (method === "POST") {
          const row = JSON.parse(body || "{}");
          return { status: 201, json: represent(upsert(notes, row), headers) };
        }
      }
      if (table === "media") {
        if (method === "GET") return { status: 200, json: applyFilters(media, url) };
        if (method === "POST") {
          const row = JSON.parse(body || "{}");
          return { status: 201, json: represent(upsert(media, row), headers) };
        }
        if (method === "PATCH") {
          const rows = applyFilters(media, url);
          const row = JSON.parse(body || "{}");
          if (!rows[0]) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
          Object.assign(rows[0], row, { updated_at: new Date().toISOString() });
          return { status: 200, json: represent(rows[0], headers) };
        }
      }
      if (table === "trip_members" && method === "GET") {
        return { status: 200, json: [{ role: "owner" }] };
      }
      return { status: 404, json: { message: "not found" } };
    },
  };
}

async function installSupabaseMocks(page, state) {
  await page.context().route(`**/${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    let result;
    if (url.pathname.includes("/auth/v1/")) result = state.handleAuth(url, req.method(), req.postData());
    else if (url.pathname.includes("/storage/v1/")) result = state.handleStorage(url, req.method());
    else if (url.pathname.includes("/rest/v1/")) {
      result = state.handleRest(url, req.method(), req.postData(), req.headers());
    } else result = { status: 404, json: {} };
    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      body: result.json == null ? "" : JSON.stringify(result.json),
    });
  });
  await page.context().route("**/nominatim.openstreetmap.org/**", (route) => route.abort());
}

async function loginAndCreateTrip(page) {
  await page.waitForSelector('[data-testid="login-screen"]');
  await page.fill('input[name="email"]', "test@example.com");
  await page.click('form[data-step="email"] button[type="submit"]');
  await page.waitForSelector('form[data-step="otp"]');
  await page.fill('input[name="otp"]', "123456");
  await page.click('form[data-step="otp"] button[type="submit"]');
  await page.waitForSelector(".screen--urlaube", { timeout: 15_000 });
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', "Leerer Tag");
  await page.click('[data-action="pick-dates"]');
  await page.click('.calendar-day[data-date="2026-11-06"]');
  await page.click('.calendar-day[data-date="2026-11-09"]');
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2026-11-06",
    null,
    { timeout: 15_000 }
  );
  return page.locator(".screen--trip").getAttribute("data-vacation-id");
}

async function waitUploadDone(page) {
  await page.waitForSelector('[data-testid="photo-upload-sheet"]', { timeout: 15_000 });
  await page.waitForFunction(
    () => {
      const items = document.querySelectorAll(".photo-upload-item__status");
      return items.length >= 1 && [...items].every((el) => el.textContent?.includes("✓"));
    },
    null,
    { timeout: 30_000 }
  );
}

async function closeUpload(page) {
  await page.click('[data-testid="photo-upload-sheet"] [data-action="close"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden, null, { timeout: 10_000 });
}

function png(name) {
  return { name, mimeType: "image/png", buffer: TINY_PNG };
}

async function runSuite(browserType, baseUrl, label) {
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({
    ...devices["iPhone 8"],
    baseURL: baseUrl,
    geolocation: { latitude: 48.8566, longitude: 2.3522 },
    permissions: ["geolocation"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const state = createMockSupabaseState();
  await installSupabaseMocks(page, state);
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.goto(baseUrl);
  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  assert(Number(build) === 52, `${label}: Build ${build}, erwartet 52`);

  state.setFailWaypointWrites(true);
  await loginAndCreateTrip(page);
  await page.setInputFiles('[data-testid="gallery-input"]', png("galerie-leer.png"));
  const heldState = await page.waitForFunction(() => {
    const sheet = document.querySelector('[data-testid="photo-upload-sheet"]');
    const item = sheet?.querySelector(".photo-upload-item");
    if (!item) return null;
    const toast = document.querySelector('[data-testid="app-toast"]')?.innerText || "";
    const held = item.innerText || "";
    if (!held.includes("Foto bleibt erhalten")) return null;
    return { held, toast };
  });
  const { held, toast } = await heldState.jsonValue();
  assert(held.includes("galerie-leer.png"), `${label}: Foto fehlt im Sheet (${held})`);
  assert(!held.includes("new row for relation"), `${label}: Postgres-Text im Sheet (${held})`);
  assert(toast.includes("Foto bleibt erhalten"), `${label}: Toast nicht deutsch (${toast})`);
  assert(!toast.includes("new row for relation"), `${label}: Postgres-Text im Toast (${toast})`);
  assert(state.waypoints.length === 0, `${label}: Wegpunkt trotz Fehler angelegt`);
  assert(state.media.length === 0, `${label}: Foto-Zeile ohne Ort`);

  state.setFailWaypointWrites(false);
  await page.click('[data-testid="photo-upload-sheet"] [data-action="retry"]');
  await waitUploadDone(page);
  const galleryPlace = state.waypoints.find((w) => w.day === "2026-11-06");
  assert(galleryPlace, `${label}: Galerie hat keinen Ort angelegt`);
  assert(galleryPlace.source === "manual", `${label}: Galerie-source ${galleryPlace.source}`);
  assert(galleryPlace.title === "Ohne Ort", `${label}: Galerie-Titel ${galleryPlace.title}`);
  assert(galleryPlace.lat == null && galleryPlace.lng == null, `${label}: Ohne Ort hat Koordinaten`);
  assert(state.media.some((m) => m.waypoint_id === galleryPlace.id && m.upload_status === "uploaded"), `${label}: Galerie-Foto nicht hochgeladen`);
  await closeUpload(page);

  await page.click('[data-day="2026-11-07"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2026-11-07"
  );
  await page.setInputFiles('[data-testid="capture-photo-input"]', png("kamera-leer.png"));
  await waitUploadDone(page);
  const cameraPlace = state.waypoints.find((w) => w.day === "2026-11-07");
  assert(cameraPlace, `${label}: Kamera hat keinen Ort angelegt`);
  assert(cameraPlace.lat != null && cameraPlace.lng != null, `${label}: Kamera ohne GPS`);
  assert(cameraPlace.source === "photo", `${label}: Kamera-source ${cameraPlace.source}`);
  assert(ALLOWED_SOURCES.includes(cameraPlace.source), cameraPlace.source);
  assert(state.media.some((m) => m.waypoint_id === cameraPlace.id), `${label}: Kamera-Foto fehlt`);
  await closeUpload(page);

  await page.click('[data-day="2026-11-08"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2026-11-08"
  );
  await page.locator('[data-footer-action="gallery"]').click();
  await page.waitForFunction(() => {
    const lib = document.querySelector('[data-testid="trip-library"]');
    return lib && !lib.querySelector('[data-testid="library-loading"]');
  });
  const thumbsBefore = await page.locator(".library-thumb").count();
  await page.setInputFiles('[data-testid="library-gallery-input"]', png("mediathek-leer.png"));
  await waitUploadDone(page);
  const libraryPlace = state.waypoints.find((w) => w.day === "2026-11-08");
  assert(libraryPlace, `${label}: Mediathek hat keinen Ort angelegt`);
  assert(libraryPlace.source === "manual" && libraryPlace.title === "Ohne Ort", `${label}: Mediathek-Ort ${libraryPlace.source}/${libraryPlace.title}`);
  await closeUpload(page);
  await page.waitForFunction(
    (before) => document.querySelectorAll(".library-thumb").length > before,
    thumbsBefore,
    { timeout: 15_000 }
  );
  const libraryText = await page.locator('[data-testid="trip-library"]').innerText();
  assert(libraryText.includes("Ohne Ort"), `${label}: Mediathek zeigt den neuen Ort nicht`);

  await page.locator('[data-testid="library-back"]').click();
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.click('[data-day="2026-11-09"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2026-11-09"
  );
  state.setFailWaypointWrites(true);
  await page.locator('[data-footer-action="note"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.fill('[data-testid="note-sheet"] textarea', "Erste Notiz");
  await page.locator('[data-testid="note-sheet"] [data-action="save"]').click();
  await page.waitForFunction(
    () => {
      const text = document.querySelector('[data-testid="app-toast"]')?.textContent || "";
      return text.includes("Notiz bleibt erhalten");
    },
    null,
    { timeout: 10_000 }
  );
  const noteToast = await page.locator('[data-testid="app-toast"]').innerText();
  assert(!noteToast.includes("new row for relation"), `${label}: Notiz zeigt Postgres (${noteToast})`);
  const still = await page.locator('[data-testid="note-sheet"] textarea').inputValue();
  assert(still === "Erste Notiz", `${label}: Notiztext weg (${still})`);
  assert(!state.notes.length, `${label}: Notiz trotz Ortsfehler gespeichert`);
  assert(!state.waypoints.some((w) => w.day === "2026-11-09"), `${label}: Notiz-Tag hat einen Wegpunkt trotz Fehler`);

  state.setFailWaypointWrites(false);
  await page.locator('[data-testid="note-sheet"] [data-action="save"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]', { state: "detached", timeout: 15_000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="trip-content"]')?.innerText?.includes("Erste Notiz"),
    null,
    { timeout: 15_000 }
  );
  const notePlace = state.waypoints.find((w) => w.day === "2026-11-09");
  assert(notePlace, `${label}: Notiz ohne Ort`);
  assert(ALLOWED_SOURCES.includes(notePlace.source), `${label}: Notiz-source ${notePlace.source}`);
  assert(notePlace.lat != null, `${label}: Notiz-Ort ohne GPS`);
  assert(notePlace.source === "photo", `${label}: Notiz-source ${notePlace.source}`);
  assert(state.notes.some((n) => n.body === "Erste Notiz" && n.waypoint_id === notePlace.id), `${label}: Notiz nicht am Ort`);

  const bad = state.waypoints.filter((w) => !ALLOWED_SOURCES.includes(w.source));
  assert(!bad.length, `${label}: unerlaubte source ${bad.map((w) => w.source).join(",")}`);
  assert(!state.rejected.length, `${label}: Client sendet weiter ungültige Wegpunkte ${JSON.stringify(state.rejected)}`);
  assert(!pageErrors.length, `${label}: Seitenfehler ${pageErrors.join(" | ")}`);

  await browser.close();
}

async function main() {
  reproduceConstraint();
  const { server, baseUrl } = await startServer();
  try {
    await runSuite(chromium, baseUrl, "Chromium");
    await runSuite(webkit, baseUrl, "WebKit");
  } finally {
    server.close();
  }
  console.log("Playwright 8d tests OK (Build 52)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
