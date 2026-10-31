import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";
import { P, fmt, plan } from "../js/recap-duration.js";
import { buildVideoRecap } from "../js/recap-storyboard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const USER = "11111111-1111-1111-1111-111111111111";
const TRIP = "trip-garda";
const EMPTY = "trip-leer";

const PLACES = [
  ["p-navene", "Navene", "2025-06-16", 10, 2],
  ["p-hafen", "Hafen Malcesine", "2025-06-17", 12, 1],
  ["p-castello", "Castello Scaligero", "2025-06-17", 11, 1],
  ["p-limone", "Limone sul Garda", "2025-06-18", 9, 2],
  ["p-baldo", "Monte Baldo", "2025-06-18", 8, 1],
  ["p-torbole", "Torbole", "2025-06-19", 8, 2],
  ["p-burg", "Malcesine Burg", "2025-06-19", 7, 1],
  ["p-garda", "Garda", "2025-06-19", 7, 1],
  ["p-riva", "Riva del Garda", "2025-06-20", 14, 1],
];

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

const VIEWPORTS = [
  { width: 375, height: 667 },
  { width: 360, height: 740 },
  { width: 390, height: 844 },
];

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function runFormulaUnitTests() {
  const inputs = PLACES.map((row) => ({ photos: row[3], notes: row[4] }));
  assert(inputs.reduce((sum, item) => sum + item.photos, 0) === 86, "Gardasee-Fotos");
  assert(inputs.reduce((sum, item) => sum + item.notes, 0) === 12, "Gardasee-Notizen");
  const gardasee = plan(inputs);
  assert(gardasee.ok, "Gardasee ok");
  assert(gardasee.seconds === 78, `Gardasee Sekunden ${gardasee.seconds}`);
  assert(gardasee.label === "ca. 1:20 min", gardasee.label);
  assert(gardasee.photosUsed === 27, `Fotos im Video ${gardasee.photosUsed}`);
  assert(fmt(78) === "ca. 1:20 min", fmt(78));
  const small = plan([
    { photos: 5, notes: 1 },
    { photos: 3, notes: 0 },
  ]);
  assert(small.label === "ca. 0:30 min", `klein ${small.label}`);
  assert(small.photosUsed === 8, `klein Fotos ${small.photosUsed}`);
  assert(small.seconds === P.minS, `klein Sekunden ${small.seconds}`);
  const big = plan(Array.from({ length: 30 }, (_, i) => ({ photos: 13 + (i < 10 ? 1 : 0), notes: i < 10 ? 2 : 1 })));
  assert(big.photosPerPlace === 1, `groß Fotos je Ort ${big.photosPerPlace}`);
  assert(big.label === "ca. 2:30 min", big.label);
  assert(big.seconds === P.maxS, `groß Sekunden ${big.seconds}`);
  const few = plan([{ photos: 3, notes: 0 }]);
  assert(few.ok === false && few.reason === "too-few-photos", "zu wenig");
  const built = buildVideoRecap(materialFrom(PLACES));
  assert(built.ok && built.content.seconds === 78, "Storyboard 78");
  assert(built.content.counts.photos === 86 && built.content.counts.places === 9 && built.content.counts.notes === 12, "Zählung");
  assert(built.content.scenes.length === 11, "11 Szenen");
  assert(built.content.scenes[0].type === "title" && built.content.scenes[0].seconds === 3, "Titel");
  assert(built.content.scenes[1].seconds === 9 && built.content.scenes[1].note_ids.length === 2, "Navene");
  assert(built.content.scenes[2].seconds === 7.5 && built.content.scenes[2].media_ids.length === 3, "Hafen");
  assert(built.content.scenes.at(-1).type === "outro", "Schluss");
  assert(buildVideoRecap(materialFrom([["p", "Ort", "2025-06-16", 3, 0]])).ok === false, "Leerzustand");
  console.log("Dauerformel-Unit-Tests grün");
}

function materialFrom(rows) {
  const places = [];
  const photos = [];
  const notes = [];
  rows.forEach((row, index) => {
    const [id, name, day, photoCount, noteCount] = row;
    places.push({ id, name, day, ts: Date.parse(`${day}T08:00:00.000Z`) + index * 1000, soft: false });
    for (let n = 0; n < photoCount; n += 1) {
      photos.push({
        id: `${id}-m${n}`,
        placeId: id,
        ts: Date.parse(`${day}T09:00:00.000Z`) + n * 60000,
        type: "photo",
        uploadStatus: "uploaded",
      });
    }
    for (let n = 0; n < noteCount; n += 1) {
      notes.push({ id: `${id}-n${n}`, placeId: id, createdAt: n + 1 });
    }
  });
  return { places, photos, notes };
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

function tripRow(id, title, start, end) {
  return {
    id,
    title,
    start_date: start,
    end_date: end,
    created_at: `${start}T00:00:00.000Z`,
    updated_at: `${end}T00:00:00.000Z`,
    created_by: USER,
    companions: [],
    companion_tags: [],
    cover_media_id: null,
    cover_preset: "stadt",
    deleted_at: null,
  };
}

function seedGardasee(state) {
  state.trips.push(tripRow(TRIP, "Gardasee 2025", "2025-06-16", "2025-06-20"));
  state.trips.push(tripRow(EMPTY, "Kurzurlaub", "2026-10-01", "2026-10-02"));
  PLACES.forEach((row, index) => {
    const [id, title, day] = row;
    state.waypoints.push({
      id,
      trip_id: TRIP,
      day,
      visited_at: `${day}T${String(8 + index).padStart(2, "0")}:00:00.000Z`,
      lat: 45.8 + index * 0.01,
      lng: 10.8,
      accuracy_m: 8,
      title,
      is_soft: false,
      source: "manual",
      deleted_at: null,
      created_at: `${day}T08:00:00.000Z`,
      updated_at: `${day}T08:00:00.000Z`,
      created_by: USER,
    });
  });
  PLACES.forEach((row) => {
    const [id, , day, photoCount, noteCount] = row;
    for (let n = 0; n < photoCount; n += 1) {
      const minute = String(n).padStart(2, "0");
      state.media.push({
        id: `${id}-m${n}`,
        trip_id: TRIP,
        waypoint_id: id,
        day,
        taken_at: `${day}T09:${minute}:00.000Z`,
        kind: "photo",
        storage_path: `orig/${id}-${n}.jpg`,
        thumb_path: `${id}-${n}.jpg`,
        mime: "image/jpeg",
        upload_status: "uploaded",
        deleted_at: null,
        created_at: `${day}T09:${minute}:00.000Z`,
        updated_at: `${day}T09:${minute}:00.000Z`,
        created_by: USER,
      });
    }
    for (let n = 0; n < noteCount; n += 1) {
      state.notes.push({
        id: `${id}-n${n}`,
        trip_id: TRIP,
        waypoint_id: id,
        day,
        body: `Notiz ${n + 1}`,
        deleted_at: null,
        created_at: `${day}T10:0${n}:00.000Z`,
        updated_at: `${day}T10:0${n}:00.000Z`,
        created_by: USER,
      });
    }
  });
  state.waypoints.push({
    id: "p-leer",
    trip_id: EMPTY,
    day: "2026-10-01",
    visited_at: "2026-10-01T09:00:00.000Z",
    lat: 45.5,
    lng: 10.5,
    accuracy_m: 8,
    title: "Steg",
    is_soft: false,
    source: "manual",
    deleted_at: null,
    created_at: "2026-10-01T09:00:00.000Z",
    updated_at: "2026-10-01T09:00:00.000Z",
    created_by: USER,
  });
  for (let n = 0; n < 3; n += 1) {
    state.media.push({
      id: `leer-m${n}`,
      trip_id: EMPTY,
      waypoint_id: "p-leer",
      day: "2026-10-01",
      taken_at: `2026-10-01T09:0${n}:00.000Z`,
      kind: "photo",
      storage_path: `orig/leer-${n}.jpg`,
      thumb_path: `leer-${n}.jpg`,
      mime: "image/jpeg",
      upload_status: "uploaded",
      deleted_at: null,
      created_at: `2026-10-01T09:0${n}:00.000Z`,
      updated_at: `2026-10-01T09:0${n}:00.000Z`,
      created_by: USER,
    });
  }
}

function createMockSupabaseState() {
  const session = {
    access_token: "test-access",
    refresh_token: "test-refresh",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: { id: USER, aud: "authenticated", role: "authenticated", email: "test@example.com" },
  };
  const state = {
    trips: [],
    waypoints: [],
    notes: [],
    media: [],
    recaps: [],
    role: "owner",
    roleError: false,
    recapMissing: false,
    failNextRecapPatch: false,
    recapOps: [],
    recapInsertGate: Promise.resolve(),
  };
  function represent(row, headers) {
    const accept = headers.accept || "";
    if (accept.includes("application/vnd.pgrst.object+json")) return row;
    return [row];
  }
  function sendRows(rows, headers) {
    const accept = headers.accept || "";
    if (accept.includes("application/vnd.pgrst.object+json")) {
      if (!rows.length) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
      return { status: 200, json: rows[0] };
    }
    return { status: 200, json: rows };
  }
  function applyFilters(rows, url) {
    let out = rows.slice();
    for (const [key, value] of url.searchParams.entries()) {
      if (["select", "order", "offset", "limit", "on_conflict"].includes(key)) continue;
      if (value === "is.null") out = out.filter((row) => row[key] == null);
      else if (value === "not.is.null") out = out.filter((row) => row[key] != null);
      else if (value.startsWith("eq.")) out = out.filter((row) => String(row[key]) === value.slice(3));
      else if (value.startsWith("neq.")) out = out.filter((row) => String(row[key]) !== value.slice(4));
    }
    return out;
  }
  function canWrite() {
    return state.role === "owner" || state.role === "editor";
  }
  state.handleAuth = (url, method) => {
    const pathName = url.pathname;
    if (pathName.endsWith("/otp") && method === "POST") return { status: 200, json: {} };
    if (pathName.endsWith("/verify") && method === "POST") return { status: 200, json: session };
    if (pathName.endsWith("/token") && method === "POST") return { status: 200, json: session };
    if (pathName.endsWith("/user") && method === "GET") return { status: 200, json: session.user };
    return { status: 404, json: {} };
  };
  state.handleStorage = (url, method, body) => {
    const pathName = url.pathname;
    if (pathName.includes("/object/sign/") && method === "POST") {
      let payload = {};
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        payload = {};
      }
      const paths = Array.isArray(payload.paths) ? payload.paths : [];
      if (paths.length) {
        return {
          status: 200,
          json: paths.map((one) => ({
            error: null,
            path: one,
            signedURL: `/object/sign/mock?token=${encodeURIComponent(one)}`,
          })),
        };
      }
      return { status: 200, json: { signedURL: "/object/sign/mock?token=1" } };
    }
    if (pathName.includes("/object/sign/mock") && method === "GET") {
      return { status: 200, raw: TINY_PNG, contentType: "image/png" };
    }
    return { status: 404, json: {} };
  };
  state.handleRest = async (url, method, body, headers) => {
    const table = url.pathname.split("/").filter(Boolean).pop();
    if (table === "trip_members" && method === "GET") {
      if (state.roleError) return { status: 500, json: { message: "Rolle nicht geladen" } };
      return sendRows([{ role: state.role, trip_id: TRIP, user_id: USER }], headers);
    }
    if (table === "trips" && method === "GET") return sendRows(applyFilters(state.trips, url), headers);
    if (table === "waypoints" && method === "GET") return sendRows(applyFilters(state.waypoints, url), headers);
    if (table === "notes" && method === "GET") return sendRows(applyFilters(state.notes, url), headers);
    if (table === "media" && method === "GET") return sendRows(applyFilters(state.media, url), headers);
    if (table === "trip_recaps") {
      if (state.recapMissing) {
        return {
          status: 404,
          json: { code: "PGRST205", message: "Could not find the table 'public.trip_recaps' in the schema cache" },
        };
      }
      if (!canWrite() && method !== "GET") {
        return { status: 401, json: { code: "42501", message: "new row violates row-level security policy" } };
      }
      if (method === "GET") {
        let rows = applyFilters(state.recaps, url);
        if (!canWrite()) rows = rows.filter((row) => row.status === "final");
        return sendRows(rows, headers);
      }
      if (method === "POST") {
        await state.recapInsertGate;
        state.recapOps.push("insert");
        const row = JSON.parse(body || "{}");
        const full = {
          id: crypto.randomUUID(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null,
          finalized_at: null,
          feedback: [],
          version: 1,
          source_text: null,
          ...row,
        };
        state.recaps.push(full);
        return { status: 201, json: represent(full, headers) };
      }
      if (method === "PATCH") {
        if (state.failNextRecapPatch) {
          state.failNextRecapPatch = false;
          state.recapOps.push("update-fail");
          return { status: 500, json: { message: "Speichern fehlgeschlagen." } };
        }
        state.recapOps.push("update");
        const rows = applyFilters(state.recaps, url);
        if (!rows[0]) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
        Object.assign(rows[0], JSON.parse(body || "{}"), { updated_at: new Date().toISOString() });
        return { status: 200, json: represent(rows[0], headers) };
      }
      if (method === "DELETE") {
        state.recapOps.push("delete");
        const rows = applyFilters(state.recaps, url);
        const ids = new Set(rows.map((row) => row.id));
        state.recaps = state.recaps.filter((row) => !ids.has(row.id));
        return { status: 204, json: null };
      }
    }
    return { status: 404, json: { message: `not found ${table}` } };
  };
  seedGardasee(state);
  return state;
}

function corsHeaders(req) {
  const origin = req.headers()["origin"] || "http://127.0.0.1";
  const requested = req.headers()["access-control-request-headers"];
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": requested || "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    vary: "Origin",
  };
}

async function installSupabaseMocks(page, state) {
  await page.context().route(`**/${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders(req) });
      return;
    }
    const url = new URL(req.url());
    let result;
    if (url.pathname.includes("/auth/v1/")) result = state.handleAuth(url, req.method());
    else if (url.pathname.includes("/storage/v1/")) result = state.handleStorage(url, req.method(), req.postData());
    else if (url.pathname.includes("/rest/v1/")) result = await state.handleRest(url, req.method(), req.postData(), req.headers());
    else result = { status: 404, json: {} };
    if (result.raw) {
      await route.fulfill({
        status: result.status,
        contentType: result.contentType,
        headers: corsHeaders(req),
        body: result.raw,
      });
      return;
    }
    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      headers: corsHeaders(req),
      body: result.json == null ? "" : JSON.stringify(result.json),
    });
  });
}

async function login(page, baseUrl) {
  await page.goto(baseUrl);
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
}

async function openTrip(page, id) {
  await page.locator(`[data-vacation-id="${id}"]`).click();
  await page.waitForSelector('[data-testid="trip-content"]');
}

async function reloadHome(page) {
  const home = page.url().split("#")[0];
  await page.goto(home);
  await page.waitForSelector(".screen--urlaube, [data-testid='login-screen']");
  if (await page.locator('[data-testid="login-screen"]').count()) await login(page, home);
  await page.waitForSelector(".screen--urlaube");
}

function realErrors(list) {
  return list.filter((entry) => !/access control checks/i.test(entry));
}

async function runFlows(page, state, label) {
  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  assert(Number(build) === 61, `${label}: Build ${build}`);

  let releaseInsert;
  state.recapInsertGate = new Promise((resolve) => {
    releaseInsert = resolve;
  });
  await openTrip(page, TRIP);
  await page.click('[data-action="settings"]');
  await page.waitForSelector('[data-testid="settings-recap-video"]');
  const settingsLabel = await page.locator('[data-testid="settings-recap-video"]').innerText();
  assert(settingsLabel.includes("Recap-Video erstellen"), `${label}: Zahnrad «${settingsLabel}»`);
  await page.click('[data-action="back"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.locator('[data-day="2025-06-20"]').click();
  await page.waitForSelector('[data-testid="recap-entry"]');
  assert(await page.locator('[data-testid="recap-diary-soon"]').isDisabled(), `${label}: Tagebuch nicht deaktiviert`);
  const diaryLabel = await page.locator('[data-testid="recap-diary-soon"]').innerText();
  assert(diaryLabel.toLowerCase().includes("bald"), `${label}: Tagebuch ohne «bald» (${diaryLabel})`);
  await page.locator('[data-testid="recap-create"]').click();
  await page.waitForSelector('[data-testid="recap-working"]');
  const working = await page.locator('[data-testid="recap-working"]').innerText();
  assert(working.includes("in Bearbeitung"), `${label}: ${working}`);
  releaseInsert();
  state.recapInsertGate = Promise.resolve();
  await page.waitForSelector('[data-testid="recap-storyboard"]');
  const duration = await page.locator('[data-testid="recap-duration-label"]').innerText();
  const counts = await page.locator('[data-testid="recap-counts"]').innerText();
  const formula = await page.locator('[data-testid="recap-formula-line"]').innerText();
  const kicker = await page.locator('[data-testid="recap-kicker"]').innerText();
  const startwert = await page.locator('[data-testid="recap-startwert"]').innerText();
  assert(duration.includes("ca. 1:20 min"), `${label}: Dauer «${duration}»`);
  assert(startwert.includes("Startwert"), `${label}: Etikett fehlt`);
  assert(counts.includes("86 Fotos") && counts.includes("9 Orten") && counts.includes("12 Notizen"), `${label}: ${counts}`);
  assert(formula.includes("27 Fotos im Video") && formula.includes("1,5 s je Foto"), `${label}: ${formula}`);
  assert(kicker.includes("Entwurf 1") && kicker.includes("11 Szenen"), `${label}: ${kicker}`);
  const scenes = await page.locator('[data-testid="recap-scene"]').allInnerTexts();
  assert(scenes.length === 5, `${label}: ${scenes.length} Szenen sichtbar`);
  assert(scenes[1].includes("Navene") && scenes[1].includes("9 s") && scenes[1].includes("2 Notizen"), `${label}: ${scenes[1]}`);
  assert(scenes[2].includes("Hafen Malcesine") && scenes[2].includes("7,5 s"), `${label}: ${scenes[2]}`);
  const more = await page.locator('[data-testid="recap-more"]').innerText();
  assert(more.includes("Monte Baldo") && more.includes("Riva del Garda") && more.includes("Schluss"), `${label}: ${more}`);
  const draft = state.recaps.find((row) => row.status === "draft" && row.trip_id === TRIP);
  assert(draft, `${label}: kein Entwurf gespeichert`);
  assert(draft.kind === "video" && draft.content.seconds === 78, `${label}: Inhalt ${draft.content?.seconds}`);
  assert(draft.content.counts.photos === 86 && draft.content.scenes.length === 11, `${label}: gespeicherte Szenen`);
  assert(draft.content.scenes[1].waypoint_id === "p-navene", `${label}: erste Ortsszene`);
  assert(draft.content.scenes[1].media_ids.length === 3, `${label}: Navene ohne 3 Fotos`);
  assert(!state.recaps.some((row) => row.status === "final"), `${label}: erste Fassung ist schon final`);

  await page.click('[data-testid="recap-preview"]');
  await page.waitForSelector('[data-testid="recap-slideshow"]');
  const slide = await page.locator('[data-testid="recap-slide"]').innerText();
  assert(slide.includes("Gardasee"), `${label}: Vorschau «${slide}»`);
  const loadedPhotos = (await page.locator('[data-testid="recap-slideshow"]').getAttribute("data-loaded-photos")) || "";
  assert(loadedPhotos.includes("p-navene-m0"), `${label}: erstes Foto fehlt (${loadedPhotos})`);
  assert(loadedPhotos.includes("p-navene-m1"), `${label}: zweites Foto fehlt (${loadedPhotos})`);
  assert(loadedPhotos.includes("p-navene-m2"), `${label}: drittes Foto fehlt (${loadedPhotos})`);
  await page.click('[data-testid="recap-slideshow-close"]');
  await page.waitForSelector('[data-testid="recap-slideshow"]', { state: "detached" });

  await page.fill('[data-testid="recap-feedback-input"]', "Bitte langsamer");
  await page.click('[data-testid="recap-feedback-send"]');
  await page.waitForSelector('[data-testid="app-toast"]');
  const feedback = draft.feedback || [];
  assert(feedback.length === 1 && feedback[0].text === "Bitte langsamer", `${label}: Feedback ${JSON.stringify(feedback)}`);
  assert(feedback[0].status === "open" && feedback[0].by === USER && feedback[0].version === 1, `${label}: Feedback-Felder`);

  state.failNextRecapPatch = true;
  const opsAtFail = state.recapOps.length;
  await page.click('[data-testid="recap-adopt"]');
  await page.waitForFunction(() => /fehlgeschlagen/i.test(document.querySelector('[data-testid="app-toast"]')?.textContent || ""));
  const failToast = await page.locator('[data-testid="app-toast"]').innerText();
  assert(/fehlgeschlagen/i.test(failToast), `${label}: Fehlermeldung «${failToast}»`);
  assert(draft.status === "draft" && !draft.finalized_at, `${label}: fehlgeschlagenes Übernehmen hat den Entwurf verändert`);
  assert(!state.recaps.some((row) => row.status === "final" && row.trip_id === TRIP), `${label}: Fehler hat eine finale Fassung erzeugt`);
  assert(!state.recapOps.slice(opsAtFail).includes("delete"), `${label}: Fehler löscht trotzdem (${state.recapOps.slice(opsAtFail)})`);

  await page.click('[data-testid="recap-adopt"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="recap-kicker"]')?.textContent?.trim() === "Final");
  assert((await page.locator('[data-testid="recap-discard"]').count()) === 0, `${label}: finale Fassung noch verwerfbar`);
  assert((await page.locator('[data-testid="recap-new-draft"]').count()) === 1, `${label}: Neuer Entwurf fehlt`);
  assert(draft.status === "final" && draft.finalized_at, `${label}: Entwurf nicht final`);
  assert(draft.feedback[0].text === "Bitte langsamer", `${label}: Feedback beim Übernehmen verloren`);
  const adoptOps = state.recapOps.slice(opsAtFail);
  const updateAt = adoptOps.lastIndexOf("update");
  const deleteAt = adoptOps.lastIndexOf("delete");
  assert(updateAt >= 0 && deleteAt > updateAt, `${label}: Reihenfolge ${adoptOps}`);

  const insertsBeforeReopen = state.recapOps.filter((op) => op === "insert").length;
  await page.click('[data-action="back"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  await reloadHome(page);
  await openTrip(page, TRIP);
  await page.locator('[data-day="2025-06-20"]').click();
  await page.click('[data-testid="recap-create"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="recap-kicker"]')?.textContent?.trim() === "Final");
  assert(
    state.recapOps.filter((op) => op === "insert").length === insertsBeforeReopen,
    `${label}: Öffnen legt einen neuen Entwurf an`
  );
  assert((await page.locator('[data-testid="recap-feedback-input"]').count()) === 0, `${label}: Final ist bearbeitbar`);
  assert((await page.locator('[data-testid="recap-new-draft"]').innerText()).includes("Neuer Entwurf"), `${label}: Button fehlt`);

  await page.click('[data-testid="recap-new-draft"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="recap-kicker"]')?.textContent?.includes("Entwurf 2"));
  const second = state.recaps.find((row) => row.status === "draft" && row.trip_id === TRIP);
  assert(second && second.version === 2 && second.based_on === draft.id, `${label}: Version ${second?.version}`);
  assert(state.recaps.filter((row) => row.trip_id === TRIP && row.status === "final").length === 1, `${label}: Final beim neuen Entwurf weg`);

  state.failNextRecapPatch = true;
  const opsBeforeSecondFail = state.recapOps.length;
  await page.click('[data-testid="recap-adopt"]');
  await page.waitForFunction(() => /fehlgeschlagen/i.test(document.querySelector('[data-testid="app-toast"]')?.textContent || ""));
  assert(second.status === "draft", `${label}: zweiter Entwurf wurde trotz Fehler final`);
  assert(state.recaps.some((row) => row.id === draft.id && row.status === "final"), `${label}: alte finale Fassung ist weg`);
  assert(!state.recapOps.slice(opsBeforeSecondFail).includes("delete"), `${label}: Fehler löscht das Final`);

  await page.click('[data-testid="recap-adopt"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="recap-kicker"]')?.textContent?.trim() === "Final");
  assert(!state.recaps.some((row) => row.id === draft.id), `${label}: alte finale Fassung bleibt nach Erfolg`);
  assert(second.status === "final", `${label}: neuer Entwurf nicht übernommen`);

  await page.click('[data-testid="recap-new-draft"]');
  await page.waitForSelector('[data-testid="recap-discard"]');
  const third = state.recaps.find((row) => row.status === "draft" && row.trip_id === TRIP);
  assert(third && third.version === 3, `${label}: dritte Version ${third?.version}`);
  await page.click('[data-testid="recap-discard"]');
  await page.waitForSelector('[data-testid="recap-discard-confirm"]');
  await page.click('[data-testid="recap-discard-confirm"] [data-action="confirm"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  assert(!state.recaps.some((row) => row.id === third.id), `${label}: Verwerfen löscht nicht`);
  assert(state.recaps.some((row) => row.id === second.id && row.status === "final"), `${label}: finale Fassung mitverworfen`);

  state.role = "editor";
  await reloadHome(page);
  await openTrip(page, TRIP);
  await page.click('[data-action="settings"]');
  assert((await page.locator('[data-testid="settings-recap-video"]').innerText()).includes("erstellen"), `${label}: Mitbearbeiter ohne Aktion`);
  const insertsBeforeEditor = state.recapOps.filter((op) => op === "insert").length;
  await page.click('[data-testid="settings-recap-video"]');
  await page.waitForSelector('[data-testid="recap-new-draft"]');
  assert(state.recapOps.filter((op) => op === "insert").length === insertsBeforeEditor, `${label}: Mitbearbeiter-Öffnen schreibt`);
  await page.click('[data-testid="recap-new-draft"]');
  await page.waitForSelector('[data-testid="recap-feedback-input"]');
  await page.fill('[data-testid="recap-feedback-input"]', "noch ruhiger");
  await page.click('[data-testid="recap-feedback-send"]');
  await page.waitForSelector('[data-testid="app-toast"]');
  const editorDraft = state.recaps.find((row) => row.status === "draft" && row.trip_id === TRIP);
  assert(editorDraft?.version === 3, `${label}: Mitbearbeiter-Version ${editorDraft?.version}`);
  assert(editorDraft?.feedback?.some((item) => item.text === "noch ruhiger"), `${label}: Mitbearbeiter speichert kein Feedback`);

  for (const role of ["viewer", "contributor"]) {
    state.role = role;
    await reloadHome(page);
    await openTrip(page, TRIP);
    await page.locator('[data-day="2025-06-20"]').click();
    await page.waitForSelector('[data-testid="recap-open-final"]');
    assert((await page.locator('[data-testid="recap-create"]').count()) === 0, `${label}: ${role} darf erstellen`);
    await page.click('[data-action="settings"]');
    const seen = await page.locator('[data-testid="settings-recap-video"]').innerText();
    assert(seen.includes("ansehen"), `${label}: ${role} Menü «${seen}»`);
    await page.click('[data-testid="settings-recap-video"]');
    await page.waitForSelector('[data-testid="recap-storyboard"]');
    const text = await page.locator('[data-testid="recap-screen"]').innerText();
    assert(text.includes("Final"), `${label}: ${role} sieht keine finale Fassung`);
    assert(!text.includes("noch ruhiger"), `${label}: ${role} sieht den Entwurf`);
    assert((await page.locator('[data-testid="recap-new-draft"]').count()) === 0, `${label}: ${role} legt Entwürfe an`);
    assert((await page.locator('[data-testid="recap-feedback-input"]').count()) === 0, `${label}: ${role} kann Feedback`);
    assert((await page.locator('[data-testid="recap-discard"]').count()) === 0, `${label}: ${role} kann verwerfen`);
    assert((await page.locator('[data-testid="recap-adopt"]').count()) === 0, `${label}: ${role} kann übernehmen`);
  }

  state.role = "owner";
  state.roleError = true;
  const insertsBeforeRole = state.recapOps.filter((op) => op === "insert").length;
  await reloadHome(page);
  await openTrip(page, TRIP);
  await page.locator('[data-day="2025-06-20"]').click();
  await page.waitForSelector('[data-testid="recap-open-final"]');
  assert((await page.locator('[data-testid="recap-create"]').count()) === 0, `${label}: Rollenfehler behandelt als Besitzer`);
  await page.click('[data-testid="recap-open-final"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="recap-kicker"]')?.textContent?.trim() === "Final");
  assert((await page.locator('[data-testid="recap-new-draft"]').count()) === 0, `${label}: Rollenfehler legt Entwürfe an`);
  assert(state.recapOps.filter((op) => op === "insert").length === insertsBeforeRole, `${label}: Rollenfehler schreibt eine Zeile`);
  state.roleError = false;

  state.role = "owner";
  await reloadHome(page);
  await openTrip(page, EMPTY);
  await page.locator('[data-day="2026-10-02"]').click();
  await page.waitForSelector('[data-testid="recap-entry"]');
  await page.click('[data-testid="recap-create"]');
  await page.waitForSelector('[data-testid="recap-empty"]');
  const emptyText = await page.locator('[data-testid="recap-empty"]').innerText();
  assert(emptyText.includes("Noch zu wenig für ein Video"), `${label}: Leerzustand «${emptyText}»`);
  assert(emptyText.includes("3 von 6"), `${label}: Fotoleiste «${emptyText}»`);
  assert(emptyText.includes("1 von 1"), `${label}: Orte «${emptyText}»`);
  assert(emptyText.includes("0 · optional") || emptyText.includes("0 · optional".replace("·", "·")), `${label}: Notizen «${emptyText}»`);
  assert((await page.locator('[data-testid="recap-diary-hint"]').innerText()).includes("Reisetagebuch geht schon"), `${label}: Hinweis fehlt`);
  assert(await page.locator('[data-testid="recap-diary-soon"]').isDisabled(), `${label}: Tagebuch im Leerzustand aktiv`);
  assert(!state.recaps.some((row) => row.trip_id === EMPTY), `${label}: Leerzustand speichert einen Entwurf`);
  await page.click('[data-testid="recap-open-library"]');
  await page.waitForSelector('[data-testid="trip-library"], [data-testid="library-empty"], [data-testid="library-back"]');

  state.recapMissing = true;
  await reloadHome(page);
  await openTrip(page, TRIP);
  await page.click('[data-action="settings"]');
  await page.click('[data-testid="settings-recap-video"]');
  await page.waitForSelector('[data-testid="recap-unavailable"]');
  const missing = await page.locator('[data-testid="recap-unavailable"]').innerText();
  assert(missing.includes("noch nicht verfügbar"), `${label}: Fallback «${missing}»`);
}

async function runSuite(browserType, baseUrl, label, viewport) {
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({
    ...devices["iPhone 8"],
    viewport,
    baseURL: baseUrl,
    permissions: ["geolocation"],
  });
  await context.setGeolocation({ latitude: 45.88, longitude: 10.84 });
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);
  const state = createMockSupabaseState();
  await installSupabaseMocks(page, state);
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  const where = `${label} ${viewport.width}x${viewport.height}`;
  try {
    await login(page, baseUrl);
    await runFlows(page, state, where);
    const errors = realErrors(pageErrors);
    assert(errors.length === 0, `${where}: ${errors.join(" | ")}`);
    console.log(`Playwright 12b tests OK (${where}, Build 61)`);
  } finally {
    await browser.close();
  }
}

runFormulaUnitTests();

const { server, baseUrl } = await startServer();
try {
  for (const viewport of VIEWPORTS) {
    await runSuite(chromium, baseUrl, "Chromium", viewport);
    await runSuite(webkit, baseUrl, "WebKit", viewport);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
console.log("Playwright 12b recap-video tests OK (Build 61)");
