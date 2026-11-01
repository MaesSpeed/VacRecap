import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const USER = "11111111-1111-1111-1111-111111111111";

const PARIS = "trip-paris";
const DRAFTS = "trip-drafts";
const MIX = "trip-mix";
const BOTH = "trip-both";
const LONG = "trip-long";
const TAGS = "trip-tags";
const PLUS = "trip-plus";
const LEER = "trip-leer";
const NOW = "trip-now";
const FOREIGN = "trip-foreign";
const OTHER = "22222222-2222-2222-2222-222222222222";
const TRIPS = [PARIS, DRAFTS, MIX, BOTH, LONG, TAGS, PLUS, LEER, NOW, FOREIGN];
const LONG_TITLE = "Sonnige Rundreise entlang der Küste mit einem ausgesprochen langen Namen";

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

/** Dieselben partiellen Unique-Indizes wie in den Suiten 12a und 12b. */
function recapUniqueViolation(rows, candidate) {
  if (candidate.status !== "final" && candidate.status !== "notes") return false;
  return rows.some(
    (row) =>
      row.id !== candidate.id &&
      row.trip_id === candidate.trip_id &&
      row.kind === candidate.kind &&
      row.status === candidate.status
  );
}

function recapUniqueError(status) {
  const name = status === "notes" ? "trip_recaps_one_notes" : "trip_recaps_one_final";
  return {
    status: 409,
    json: {
      code: "23505",
      message: `duplicate key value violates unique constraint "${name}"`,
      details: "Key (trip_id, kind) already exists.",
    },
  };
}

function assertUniqueIndexHelpers() {
  const final = { id: "a", trip_id: "t", kind: "diary", status: "final" };
  assert(recapUniqueViolation([final], { id: "b", trip_id: "t", kind: "diary", status: "final" }), "final kollidiert");
  assert(!recapUniqueViolation([final], { id: "b", trip_id: "t", kind: "diary", status: "draft" }), "Entwurf frei");
  assert(!recapUniqueViolation([final], { id: "b", trip_id: "t", kind: "video", status: "final" }), "andere Art frei");
  const notes = { id: "n", trip_id: "t", kind: "diary", status: "notes" };
  assert(recapUniqueViolation([notes], { id: "n2", trip_id: "t", kind: "diary", status: "notes" }), "notes kollidiert");
  assert(recapUniqueError("final").json.message.includes("trip_recaps_one_final"), "Index final");
  assert(recapUniqueError("notes").json.message.includes("trip_recaps_one_notes"), "Index notes");
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

function tripRow(id, title, start, end, tags = [], names = [], createdBy = USER) {
  return {
    id,
    title,
    start_date: start,
    end_date: end,
    created_at: `${start}T00:00:00.000Z`,
    updated_at: `${end}T00:00:00.000Z`,
    created_by: createdBy,
    companions: names,
    companion_tags: tags,
    cover_media_id: null,
    cover_preset: "stadt",
    deleted_at: null,
  };
}

function recap(row) {
  return {
    id: row.id,
    trip_id: row.trip_id,
    kind: row.kind,
    status: row.status,
    version: row.version || 1,
    content: row.content || {},
    feedback: row.feedback || [],
    source_text: row.source_text || null,
    created_by: USER,
    created_at: row.created_at,
    updated_at: row.updated_at || row.created_at,
    finalized_at: row.status === "final" ? row.updated_at || row.created_at : null,
    deleted_at: row.deleted_at || null,
    based_on: null,
  };
}

function day(date, text) {
  return { date, text, waypoint_ids: [], media_ids: [] };
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
    role: "owner",
    recapMissing: false,
    holdCardQuery: null,
    membersDown: false,
    recapGets: [],
    memberGets: [],
    trips: [
      tripRow(PARIS, "Paris", "2026-12-12", "2026-12-15", [], ["Dana"]),
      tripRow(DRAFTS, "Gardasee 2025", "2025-06-16", "2025-06-20", [], ["Dana Reis", "Sami Reis"]),
      tripRow(MIX, "Mixreise", "2025-07-01", "2025-07-05"),
      tripRow(BOTH, "Beides", "2025-08-01", "2025-08-04"),
      tripRow(LONG, LONG_TITLE, "2025-09-01", "2025-09-03"),
      tripRow(TAGS, "Drei Tags", "2025-05-01", "2025-05-04", ["partner", "familie", "freunde"]),
      tripRow(PLUS, "Tagebuch plus", "2025-04-01", "2025-04-04"),
      tripRow(LEER, "Leer", "2024-03-01", "2024-03-03"),
      tripRow(NOW, "Unterwegs", "2026-10-30", "2026-11-02"),
      tripRow(FOREIGN, "Fremd", "2024-02-01", "2024-02-03", [], [], OTHER),
    ],
    recaps: [
      recap({
        id: "d-v1",
        trip_id: DRAFTS,
        kind: "diary",
        status: "draft",
        version: 1,
        content: { days: [day("2025-06-16", "TEXT-EINS")] },
        feedback: [],
        created_at: "2025-06-21T08:00:00.000Z",
      }),
      recap({
        id: "d-v2",
        trip_id: DRAFTS,
        kind: "diary",
        status: "draft",
        version: 2,
        content: { days: [day("2025-06-17", "TEXT-ZWEI")] },
        feedback: [{ text: "kürzer" }, { text: "ruhiger" }],
        created_at: "2025-06-22T08:00:00.000Z",
      }),
      recap({
        id: "d-notes",
        trip_id: DRAFTS,
        kind: "diary",
        status: "notes",
        version: 1,
        source_text: "Montag\nNotizen",
        created_at: "2025-06-20T08:00:00.000Z",
      }),
      recap({
        id: "d-deleted",
        trip_id: DRAFTS,
        kind: "diary",
        status: "draft",
        version: 8,
        content: { days: [day("2025-06-18", "WEG")] },
        deleted_at: "2025-06-23T08:00:00.000Z",
        created_at: "2025-06-18T08:00:00.000Z",
      }),
      recap({
        id: "mix-video",
        trip_id: MIX,
        kind: "video",
        status: "draft",
        version: 1,
        content: { scenes: [], formula: {}, counts: { photos: 0, places: 0, notes: 0 }, seconds: 0 },
        feedback: [{ text: "langsamer" }],
        created_at: "2025-07-06T08:00:00.000Z",
      }),
      recap({
        id: "mix-diary",
        trip_id: MIX,
        kind: "diary",
        status: "final",
        version: 3,
        content: { days: [day("2025-07-01", "FINAL-TEXT")] },
        created_at: "2025-07-06T09:00:00.000Z",
      }),
      recap({
        id: "both-video",
        trip_id: BOTH,
        kind: "video",
        status: "final",
        version: 2,
        content: { scenes: [], seconds: 0 },
        created_at: "2025-08-05T08:00:00.000Z",
      }),
      recap({
        id: "both-diary",
        trip_id: BOTH,
        kind: "diary",
        status: "final",
        version: 2,
        content: { days: [day("2025-08-01", "BEIDES-TEXT")] },
        created_at: "2025-08-05T09:00:00.000Z",
      }),
      recap({
        id: "long-video",
        trip_id: LONG,
        kind: "video",
        status: "final",
        version: 1,
        content: { scenes: [], seconds: 0 },
        created_at: "2025-09-04T08:00:00.000Z",
      }),
      recap({
        id: "tags-video",
        trip_id: TAGS,
        kind: "video",
        status: "final",
        version: 1,
        content: { scenes: [], seconds: 0 },
        created_at: "2025-05-05T08:00:00.000Z",
      }),
      recap({
        id: "plus-final",
        trip_id: PLUS,
        kind: "diary",
        status: "final",
        version: 4,
        content: { days: [day("2025-04-01", "PLUS-FINAL")] },
        created_at: "2025-04-05T08:00:00.000Z",
      }),
      recap({
        id: "plus-d1",
        trip_id: PLUS,
        kind: "diary",
        status: "draft",
        version: 5,
        content: { days: [day("2025-04-02", "PLUS-ENTWURF")] },
        created_at: "2025-04-06T08:00:00.000Z",
      }),
      recap({
        id: "now-video",
        trip_id: NOW,
        kind: "video",
        status: "final",
        version: 1,
        content: { scenes: [], seconds: 0 },
        created_at: "2026-10-30T08:00:00.000Z",
      }),
      recap({
        id: "foreign-diary",
        trip_id: FOREIGN,
        kind: "diary",
        status: "draft",
        version: 1,
        content: { days: [day("2024-02-01", "FREMD-TEXT")] },
        created_at: "2024-02-04T08:00:00.000Z",
      }),
      recap({
        id: "plus-d2",
        trip_id: PLUS,
        kind: "diary",
        status: "draft",
        version: 6,
        content: { days: [day("2025-04-03", "PLUS-NEU")] },
        feedback: [{ text: "a" }],
        created_at: "2025-04-07T08:00:00.000Z",
      }),
    ],
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
      else if (value.startsWith("in.(") && value.endsWith(")")) {
        const set = new Set();
        const inner = value.slice(4, -1);
        const re = /"([^"]*)"|([^,]+)/g;
        let match;
        while ((match = re.exec(inner))) set.add(match[1] ?? match[2]);
        out = out.filter((row) => set.has(String(row[key])));
      }
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
  state.handleRest = async (url, method, body, headers) => {
    const table = url.pathname.split("/").filter(Boolean).pop();
    if (table === "trip_members" && method === "GET") {
      state.memberGets.push(url.searchParams.toString());
      if (state.membersDown) return { status: 500, json: { message: "Rolle nicht geladen" } };
      const filter = url.searchParams.get("trip_id") || "";
      let ids = [BOTH];
      if (filter.startsWith("eq.")) ids = [filter.slice(3)];
      else if (filter.startsWith("in.(") && filter.endsWith(")")) {
        ids = filter
          .slice(4, -1)
          .split(",")
          .map((part) => part.replace(/^"|"$/g, ""))
          .filter(Boolean);
      }
      return sendRows(ids.map((id) => ({ role: state.role, trip_id: id, user_id: USER })), headers);
    }
    if (table === "trips" && method === "GET") return sendRows(applyFilters(state.trips, url), headers);
    if (table === "waypoints" && method === "GET") return sendRows([], headers);
    if (table === "notes" && method === "GET") return sendRows([], headers);
    if (table === "media" && method === "GET") return sendRows([], headers);
    if (table === "trip_recaps") {
      if (method === "GET") {
        state.recapGets.push(url.searchParams.toString());
        if (url.searchParams.get("select") === "trip_id,kind,status,version,deleted_at" && state.holdCardQuery) {
          await state.holdCardQuery;
        }
      }
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
          content: {},
          ...row,
        };
        if (recapUniqueViolation(state.recaps, full)) return recapUniqueError(full.status);
        state.recaps.push(full);
        return { status: 201, json: represent(full, headers) };
      }
      if (method === "PATCH") {
        const rows = applyFilters(state.recaps, url);
        if (!rows[0]) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
        const patch = JSON.parse(body || "{}");
        const next = { ...rows[0], ...patch };
        if (recapUniqueViolation(state.recaps, next)) return recapUniqueError(next.status);
        Object.assign(rows[0], patch, { updated_at: new Date().toISOString() });
        return { status: 200, json: represent(rows[0], headers) };
      }
    }
    return { status: 404, json: { message: `not found ${table}` } };
  };
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
    else if (url.pathname.includes("/rest/v1/")) result = await state.handleRest(url, req.method(), req.postData(), req.headers());
    else result = { status: 404, json: {} };
    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      headers: corsHeaders(req),
      body: result.json == null ? "" : JSON.stringify(result.json),
    });
  });
}

function cardQueries(state) {
  return state.recapGets
    .map((search) => new URLSearchParams(search))
    .filter((params) => params.get("select") === "trip_id,kind,status,version,deleted_at");
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

async function reloadHome(page) {
  const home = page.url().split("#")[0];
  await page.goto(home);
  await page.waitForSelector(".screen--urlaube, [data-testid='login-screen']");
  if (await page.locator('[data-testid="login-screen"]').count()) await login(page, home);
  await page.waitForSelector("[data-card-symbols='done']");
  await page.waitForSelector(".screen--urlaube");
}

async function backToOverview(page) {
  await page.evaluate(() => {
    document.getElementById("app")?.removeAttribute("data-card-symbols");
    location.hash = "#/urlaube";
  });
  await page.waitForSelector(".screen--urlaube");
  await page.waitForSelector("[data-card-symbols='done']");
}

function symbol(page, tripId, kind) {
  return page.locator(`[data-vacation-id="${tripId}"] [data-testid="card-symbol"][data-kind="${kind}"]`);
}

function recapBtn(page, tripId, kind) {
  return page.locator(`[data-vacation-id="${tripId}"] [data-testid="card-recap-btn"][data-kind="${kind}"]`);
}

async function waitFor(fn, message, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(message);
}

async function runFlows(page, state, label) {
  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  assert(Number(build) === 65, `${label}: Build ${build}`);

  await page.waitForSelector(`[data-vacation-id="${PARIS}"] .card-compact__title`);
  await waitFor(() => cardQueries(state).length >= 1, `${label}: Kartenabfrage fehlt`);
  assert((await page.locator("[data-testid='card-symbol']").count()) === 0, `${label}: Symbole vor der Abfrage`);
  const held = cardQueries(state);
  assert(held.length === 1, `${label}: ${held.length} Kartenabfragen vor dem Laden`);
  const params = held[0];
  assert(params.get("deleted_at") === "is.null", `${label}: deleted_at ${params.get("deleted_at")}`);
  const listed = params.get("trip_id") || "";
  for (const id of TRIPS) assert(listed.includes(id), `${label}: Abfrage ohne ${id}`);
  assert(!params.get("select").includes("*"), `${label}: select *`);
  state.holdCardQuery = null;
  state.releaseHold?.();

  await page.waitForSelector("[data-card-symbols='done']");
  assert(cardQueries(state).length === 1, `${label}: weitere Kartenabfrage ${cardQueries(state).length}`);
  assert(state.recapGets.length === 1, `${label}: zusätzliche trip_recaps-Abfrage ${state.recapGets.length}`);
  assert(state.memberGets.length === 1, `${label}: Rollenabfragen ${state.memberGets.length}`);
  const memberFilter = new URLSearchParams(state.memberGets[0]).get("trip_id") || "";
  assert(memberFilter.startsWith("in.("), `${label}: Rolle pro Karte «${memberFilter}»`);
  assert(memberFilter.includes(DRAFTS) && memberFilter.includes(LEER), `${label}: vergangene Reisen fehlen in der Rolle`);
  assert(!memberFilter.includes(PARIS) && !memberFilter.includes(NOW), `${label}: laufende oder künftige Reise in der Rolle`);

  assert((await symbol(page, PARIS, "video").count()) === 0, `${label}: Paris Video`);
  assert((await symbol(page, PARIS, "diary").count()) === 0, `${label}: Paris Tagebuch`);
  assert((await page.locator(`[data-vacation-id="${PARIS}"] [data-testid="card-symbol-hint"]`).count()) === 0 || (await page.locator(`[data-vacation-id="${PARIS}"] [data-testid="card-symbol-hint"]`).isHidden()), `${label}: Hinweis ohne Symbol`);

  const draftsDiary = symbol(page, DRAFTS, "diary");
  assert((await draftsDiary.count()) === 1, `${label}: Zustand 2 Symbol`);
  assert((await symbol(page, DRAFTS, "video").count()) === 0, `${label}: Zustand 2 ohne Video`);
  assert((await draftsDiary.getAttribute("data-state")) === "draft", `${label}: Zustand 2 nicht grau`);
  assert((await draftsDiary.getAttribute("data-drafts")) === "2", `${label}: Zahl ${(await draftsDiary.getAttribute("data-drafts"))}`);
  assert((await draftsDiary.locator(".card-sym__count").innerText()) === "2", `${label}: Plakette`);
  assert((await draftsDiary.locator(".card-sym__play").count()) === 0, `${label}: Entwurf mit Play`);
  const draftStyle = await draftsDiary.evaluate((el) => getComputedStyle(el).borderStyle);
  assert(draftStyle === "dashed", `${label}: Rand ${draftStyle}`);

  const mixVideo = symbol(page, MIX, "video");
  const mixDiary = symbol(page, MIX, "diary");
  assert((await mixVideo.getAttribute("data-state")) === "draft", `${label}: Zustand 3 Video`);
  assert((await mixVideo.getAttribute("data-drafts")) === "1", `${label}: Zustand 3 Zahl`);
  assert((await mixDiary.getAttribute("data-state")) === "final", `${label}: Zustand 3 Tagebuch`);
  assert((await mixDiary.getAttribute("data-drafts")) === "0", `${label}: Zustand 3 Tagebuch Entwürfe`);
  assert((await mixDiary.locator(".card-sym__play").count()) === 1, `${label}: Zustand 3 Play`);
  assert((await mixVideo.locator(".card-sym__play").count()) === 0, `${label}: Entwurf-Play`);
  const diaryBg = await mixDiary.evaluate((el) => getComputedStyle(el).backgroundColor);
  assert(diaryBg === "rgb(217, 137, 43)", `${label}: Tagebuchfarbe ${diaryBg}`);

  const bothVideo = symbol(page, BOTH, "video");
  const bothDiary = symbol(page, BOTH, "diary");
  assert((await bothVideo.getAttribute("data-state")) === "final", `${label}: Zustand 4 Video`);
  assert((await bothDiary.getAttribute("data-state")) === "final", `${label}: Zustand 4 Tagebuch`);
  assert((await bothVideo.locator(".card-sym__play").count()) === 1, `${label}: Video-Play`);
  assert((await bothDiary.locator(".card-sym__play").count()) === 1, `${label}: Tagebuch-Play`);
  const videoBg = await bothVideo.evaluate((el) => getComputedStyle(el).backgroundColor);
  assert(videoBg === "rgb(0, 102, 179)", `${label}: Videofarbe ${videoBg}`);

  const plus = symbol(page, PLUS, "diary");
  assert((await plus.getAttribute("data-state")) === "final", `${label}: Final mit Entwürfen`);
  assert((await plus.getAttribute("data-drafts")) === "2", `${label}: Plakette am farbigen Symbol`);
  assert((await plus.locator(".card-sym__play").count()) === 1, `${label}: Play am Final`);
  assert((await symbol(page, PLUS, "video").count()) === 0, `${label}: Plus ohne Video`);

  const hit = await draftsDiary.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const before = getComputedStyle(el, "::before");
    return { w: Math.round(box.width), h: Math.round(box.height), hitW: before.width, hitH: before.height };
  });
  assert(hit.w === 30 && hit.h === 30, `${label}: sichtbar ${hit.w}x${hit.h}`);
  assert(hit.hitW === "44px" && hit.hitH === "44px", `${label}: Tippfläche ${hit.hitW}x${hit.hitH}`);

  const hintDrafts = await page.locator(`[data-vacation-id="${DRAFTS}"] [data-testid="card-symbol-hint"]`).innerText();
  const hintMix = await page.locator(`[data-vacation-id="${MIX}"] [data-testid="card-symbol-hint"]`).innerText();
  const hintBoth = await page.locator(`[data-vacation-id="${BOTH}"] [data-testid="card-symbol-hint"]`).innerText();
  assert(hintDrafts.includes("Tipp aufs Symbol öffnet die Entwürfe"), `${label}: Hinweis 2 «${hintDrafts}»`);
  assert(hintMix.includes("Tipp aufs Symbol öffnet Tagebuch bzw. Entwurf"), `${label}: Hinweis 3 «${hintMix}»`);
  assert(hintBoth.includes("Tipp aufs Symbol öffnet Recap bzw. Tagebuch"), `${label}: Hinweis 4 «${hintBoth}»`);

  const titleBox = await page.locator(`[data-vacation-id="${LONG}"]`).evaluate((card) => {
    const title = card.querySelector(".card-compact__title");
    const sym = card.querySelector(".card-sym");
    const titleBox = title.getBoundingClientRect();
    const symBox = sym.getBoundingClientRect();
    const style = getComputedStyle(title);
    return {
      text: title.textContent,
      overlap: titleBox.right > symBox.left + 1,
      ellipsis: style.textOverflow,
      nowrap: style.whiteSpace,
    };
  });
  assert(titleBox.text === LONG_TITLE, `${label}: Titel gekürzt im Text`);
  assert(!titleBox.overlap, `${label}: Titel läuft unter das Symbol`);
  assert(titleBox.ellipsis === "ellipsis" && titleBox.nowrap === "nowrap", `${label}: Ellipsis ${titleBox.ellipsis}/${titleBox.nowrap}`);

  const tags = await page.locator(`[data-vacation-id="${TAGS}"] [data-testid="companion-tags"]`).evaluate((el) => {
    const pills = [...el.querySelectorAll(".companion-pill")].filter((pill) => !pill.hidden);
    const tops = pills.map((pill) => Math.round(pill.getBoundingClientRect().top));
    return {
      attr: el.dataset.tags,
      oneLine: tops.length > 0 && tops.every((top) => top === tops[0]),
      height: el.getBoundingClientRect().height,
      text: el.innerText.replace(/\s+/g, " ").trim(),
    };
  });
  assert(tags.attr === "partner familie freunde", `${label}: Tags ${tags.attr}`);
  assert(tags.oneLine && tags.height < 32, `${label}: Tags umbrochen h=${tags.height} «${tags.text}»`);
  const shown = ["Partner:in", "Familie", "Freunde"].filter((name) => tags.text.includes(name));
  if (shown.length < 3) {
    const more = tags.text.match(/\+(\d+)/);
    assert(more && Number(more[1]) === 3 - shown.length, `${label}: Überlauf «${tags.text}»`);
  }
  const tagFit = await page.locator(`[data-vacation-id="${TAGS}"]`).evaluate((card) => {
    const line = card.querySelector("[data-testid='companion-tags']");
    const cardBox = card.getBoundingClientRect();
    const pills = [...line.querySelectorAll(".companion-pill")];
    const hidden = pills.filter((pill) => pill.hidden);
    const visible = pills.filter((pill) => !pill.hidden);
    return {
      hiddenDisplay: hidden.every((pill) => getComputedStyle(pill).display === "none"),
      inside: visible.every((pill) => {
        const box = pill.getBoundingClientRect();
        return box.left >= cardBox.left - 1 && box.right <= cardBox.right + 1 && box.width > 8;
      }),
      fits: line.scrollWidth <= line.clientWidth + 1,
      visibleText: visible.map((pill) => pill.textContent).join(" "),
    };
  });
  assert(tagFit.hiddenDisplay, `${label}: versteckte Tags bleiben sichtbar`);
  assert(tagFit.inside && tagFit.fits, `${label}: Tags abgeschnitten «${tagFit.visibleText}»`);

  const stack = await page.locator(`[data-vacation-id="${DRAFTS}"]`).evaluate((card) => {
    const sym = card.querySelector(".card-sym").getBoundingClientRect();
    const avatar = card.querySelector(".avatar").getBoundingClientRect();
    return sym.bottom <= avatar.top + 1;
  });
  assert(stack, `${label}: Symbol sitzt nicht über den Avataren`);

  assert((await page.locator('.screen--urlaube [data-testid="recap-create"]').count()) === 0, `${label}: Button auf der Übersicht`);

  const leerSection = await page.locator(`[data-vacation-id="${LEER}"]`).evaluate((el) => el.closest("section")?.querySelector("h2")?.textContent || "");
  const nowSection = await page.locator(`[data-vacation-id="${NOW}"]`).evaluate((el) => el.closest("section")?.querySelector("h2")?.textContent || "");
  assert(leerSection === "Vergangen", `${label}: Leer steht in «${leerSection}»`);
  assert(nowSection === "Läuft jetzt", `${label}: Unterwegs steht in «${nowSection}»`);
  assert((await recapBtn(page, PARIS, "video").count()) === 0, `${label}: Button auf künftiger Reise`);
  assert((await recapBtn(page, NOW, "video").count()) === 0 && (await recapBtn(page, NOW, "diary").count()) === 0, `${label}: Button auf laufender Reise`);
  const dateHit = await page.locator(`[data-vacation-id="${NOW}"]`).evaluate((card) => {
    const sym = card.querySelector(".card-sym");
    const dates = card.querySelector(".card--hero__dates");
    if (!sym || !dates) return null;
    const symBox = sym.getBoundingClientRect();
    const dateBox = dates.getBoundingClientRect();
    const hitBottom = symBox.top + symBox.height / 2 + 22;
    return { overlap: hitBottom > dateBox.top + 0.5, gap: dateBox.top - (symBox.top + symBox.height / 2 + 22) };
  });
  assert(dateHit && !dateHit.overlap, `${label}: Tippfläche trifft das Datum (${dateHit?.gap})`);
  assert((await symbol(page, LEER, "video").count()) === 0 && (await symbol(page, LEER, "diary").count()) === 0, `${label}: C1 Symbole`);
  assert((await recapBtn(page, LEER, "video").getAttribute("data-state")) === "open", `${label}: C1 Video`);
  assert((await recapBtn(page, LEER, "diary").getAttribute("data-state")) === "open", `${label}: C1 Tagebuch`);
  const diaryIcon = await recapBtn(page, LEER, "diary").locator("svg").innerHTML();
  assert(diaryIcon.includes("M9 7h6"), `${label}: Tagebuch-Button ohne Buch`);
  assert(!diaryIcon.includes("M14 3H7"), `${label}: Tagebuch-Button nutzt das Dokument`);
  assert((await recapBtn(page, LEER, "video").locator("svg").count()) === 1, `${label}: C1 ohne Film-Symbol`);
  const leerHint = page.locator(`[data-vacation-id="${LEER}"] [data-testid="card-symbol-hint"]`);
  assert((await leerHint.count()) === 0 || (await leerHint.isHidden()), `${label}: C1 Hinweis`);
  assert((await recapBtn(page, DRAFTS, "video").getAttribute("data-state")) === "open", `${label}: C2 Video`);
  assert((await recapBtn(page, DRAFTS, "diary").getAttribute("data-state")) === "open", `${label}: C2 Tagebuch grün`);
  assert((await recapBtn(page, DRAFTS, "diary").getAttribute("data-drafts")) === "2", `${label}: C2 Entwurfszahl`);
  assert((await recapBtn(page, MIX, "video").getAttribute("data-state")) === "open", `${label}: C3 Video`);
  assert((await recapBtn(page, MIX, "video").getAttribute("data-drafts")) === "1", `${label}: C3 Video-Entwürfe`);
  assert((await recapBtn(page, MIX, "diary").getAttribute("data-state")) === "final", `${label}: C3 Tagebuch`);
  assert(await recapBtn(page, MIX, "diary").evaluate((el) => el.classList.contains("card-recap-btn--done")), `${label}: C3 ohne Haken`);
  assert((await recapBtn(page, BOTH, "video").getAttribute("data-state")) === "final", `${label}: C4 Video`);
  assert((await recapBtn(page, BOTH, "diary").getAttribute("data-state")) === "final", `${label}: C4 Tagebuch`);
  const doneBg = await recapBtn(page, BOTH, "diary").evaluate((el) => getComputedStyle(el).backgroundColor);
  const openBg = await recapBtn(page, LEER, "video").evaluate((el) => getComputedStyle(el).backgroundColor);
  assert(doneBg === "rgb(229, 245, 234)", `${label}: Grün ${doneBg}`);
  assert(openBg === "rgb(231, 243, 251)", `${label}: Blau ${openBg}`);
  const buttonOrder = await page.locator(`[data-vacation-id="${DRAFTS}"]`).evaluate((card) => {
    const meta = card.querySelector(".card-compact__meta").getBoundingClientRect();
    const button = card.querySelector("[data-testid='card-recap-btn']").getBoundingClientRect();
    const hint = card.querySelector("[data-testid='card-symbol-hint']").getBoundingClientRect();
    return meta.bottom <= button.top + 1 && button.bottom <= hint.top + 1;
  });
  assert(buttonOrder, `${label}: Buttons sitzen nicht unter den Metadaten`);

  await draftsDiary.click();
  await page.waitForSelector("[data-testid='card-draft-item']");
  const sheetText = await page.locator("[data-testid='card-drafts-sheet']").innerText();
  assert(sheetText.includes("Gardasee 2025"), `${label}: Reise im Sheet`);
  assert(sheetText.includes("Reisetagebuch"), `${label}: Art im Sheet`);
  assert(sheetText.includes("Version 1") && sheetText.includes("Version 2"), `${label}: Versionen «${sheetText}»`);
  assert(!sheetText.includes("Version 8"), `${label}: gelöschter Entwurf`);
  assert(!sheetText.includes("Notizen"), `${label}: Notizen im Sheet`);
  assert(sheetText.includes("2 Feedback-Einträge"), `${label}: Feedback «${sheetText}»`);
  assert(sheetText.includes("0 Feedback-Einträge"), `${label}: leeres Feedback`);
  assert(sheetText.includes("22.06.2025") && sheetText.includes("21.06.2025"), `${label}: Datum «${sheetText}»`);
  assert((await page.locator("[data-testid='card-symbol-hint']:visible").count()) === 0, `${label}: Hinweis nach dem Öffnen`);
  assert((await page.evaluate(() => localStorage.getItem("vacrecap-card-symbol-hint"))) === "1", `${label}: localStorage`);

  await page.locator("[data-testid='card-draft-item'][data-version='1']").click();
  await page.waitForSelector("[data-testid='diary-kicker']");
  const oldKicker = await page.locator("[data-testid='diary-kicker']").innerText();
  const oldText = await page.locator("[data-testid='diary-day-text']").innerText();
  assert(oldKicker.includes("Entwurf 1"), `${label}: Kicker «${oldKicker}»`);
  assert(!oldKicker.includes("Entwurf 2"), `${label}: neuester Entwurf statt Version 1`);
  assert(oldText.includes("TEXT-EINS") && !oldText.includes("TEXT-ZWEI"), `${label}: Text «${oldText}»`);
  const queriesAfterDraft = cardQueries(state).length;
  await backToOverview(page);
  assert(cardQueries(state).length === queriesAfterDraft + 1, `${label}: Rückkehr löst ${cardQueries(state).length - queriesAfterDraft} Kartenabfragen aus`);
  assert((await page.locator("[data-testid='card-symbol-hint']:visible").count()) === 0, `${label}: Hinweis bleibt weg`);

  await mixDiary.click();
  await page.waitForSelector("[data-testid='diary-kicker']");
  assert((await page.locator("[data-testid='card-drafts-sheet']").count()) === 0, `${label}: Final öffnet das Sheet`);
  const finalKicker = await page.locator("[data-testid='diary-kicker']").innerText();
  const finalText = await page.locator("[data-testid='diary-day-text']").innerText();
  assert(finalKicker.trim() === "Final", `${label}: Final-Kicker «${finalKicker}»`);
  assert(finalText.includes("FINAL-TEXT"), `${label}: Finaltext «${finalText}»`);
  await backToOverview(page);

  await mixVideo.click();
  await page.waitForSelector("[data-testid='card-draft-item']");
  const videoSheet = await page.locator("[data-testid='card-drafts-sheet']").innerText();
  assert(videoSheet.includes("Recap-Video"), `${label}: Video-Art`);
  assert(videoSheet.includes("1 Feedback-Eintrag"), `${label}: ein Feedback «${videoSheet}»`);
  await page.locator("[data-testid='card-draft-item']").click();
  await page.waitForSelector("[data-testid='recap-kicker']");
  const videoKicker = await page.locator("[data-testid='recap-kicker']").innerText();
  assert(videoKicker.includes("Entwurf 1"), `${label}: Video-Entwurf «${videoKicker}»`);
  await backToOverview(page);

  await plus.click();
  await page.waitForSelector("[data-testid='diary-kicker']");
  assert((await page.locator("[data-testid='card-drafts-sheet']").count()) === 0, `${label}: farbiges Symbol öffnet Entwürfe`);
  assert((await page.locator("[data-testid='diary-kicker']").innerText()).trim() === "Final", `${label}: Plus nicht Final`);
  assert((await page.locator("[data-testid='diary-day-text']").innerText()).includes("PLUS-FINAL"), `${label}: Plus-Text`);
  await backToOverview(page);

  const queriesBeforeButton = cardQueries(state).length;
  await recapBtn(page, DRAFTS, "diary").click();
  await page.waitForSelector("[data-testid='diary-kicker']");
  assert((await page.locator("[data-testid='card-drafts-sheet']").count()) === 0, `${label}: Tagebuch-Button öffnet das Sheet`);
  const buttonKicker = await page.locator("[data-testid='diary-kicker']").innerText();
  const buttonText = await page.locator("[data-testid='diary-day-text']").innerText();
  assert(buttonKicker.includes("Entwurf 2"), `${label}: Button öffnet nicht den neuesten Entwurf «${buttonKicker}»`);
  assert(buttonText.includes("TEXT-ZWEI"), `${label}: Button-Text «${buttonText}»`);
  assert(cardQueries(state).length === queriesBeforeButton, `${label}: Button löst eine Kartenabfrage aus`);
  await backToOverview(page);

  await recapBtn(page, MIX, "video").click();
  await page.waitForSelector("[data-testid='recap-kicker']");
  assert((await page.locator("[data-testid='card-drafts-sheet']").count()) === 0, `${label}: Video-Button öffnet das Sheet`);
  assert((await page.locator("[data-testid='recap-kicker']").innerText()).includes("Entwurf 1"), `${label}: Video-Button`);
  await backToOverview(page);

  await recapBtn(page, BOTH, "video").click();
  await page.waitForSelector("[data-testid='recap-kicker']");
  assert((await page.locator("[data-testid='recap-kicker']").innerText()).trim() === "Final", `${label}: C4 Button`);
  await backToOverview(page);

  await recapBtn(page, LEER, "video").click();
  await page.waitForSelector("[data-testid='recap-empty'], [data-testid='recap-storyboard']");
  assert((await page.locator("[data-testid='recap-empty']").count()) === 1, `${label}: C1 erzeugt kein leeres Video`);
  await backToOverview(page);

  await page.locator(`[data-vacation-id="${BOTH}"] .card-compact__title`).click();
  await page.waitForSelector("[data-testid='trip-content']");
  await page.locator('[data-day="2025-08-04"]').click();
  await page.waitForSelector("[data-testid='recap-create']");
  await page.waitForSelector("[data-testid='recap-diary']");
  const videoBtn = await page.locator("[data-testid='recap-create']").innerText();
  const diaryBtn = await page.locator("[data-testid='recap-diary']").innerText();
  assert(videoBtn.includes("Recap-Video") && diaryBtn.includes("Reisetagebuch"), `${label}: Buttons «${videoBtn}» «${diaryBtn}»`);
  await backToOverview(page);

  const conflict = await page.evaluate(async () => {
    const url = "https://hgboqdovlfeuqfhfeykn.supabase.co/rest/v1/trip_recaps";
    const headers = {
      apikey: "test",
      Authorization: "Bearer test",
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    const finalRes = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ trip_id: "trip-both", kind: "video", status: "final", version: 9, content: {} }),
    });
    const notesRes = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ trip_id: "trip-drafts", kind: "diary", status: "notes", version: 1, source_text: "x" }),
    });
    return {
      finalStatus: finalRes.status,
      finalMessage: (await finalRes.json()).message,
      notesStatus: notesRes.status,
      notesMessage: (await notesRes.json()).message,
    };
  });
  assert(conflict.finalStatus === 409 && conflict.finalMessage.includes("trip_recaps_one_final"), `${label}: ${conflict.finalMessage}`);
  assert(conflict.notesStatus === 409 && conflict.notesMessage.includes("trip_recaps_one_notes"), `${label}: ${conflict.notesMessage}`);

  state.role = "editor";
  await reloadHome(page);
  assert((await symbol(page, DRAFTS, "diary").getAttribute("data-drafts")) === "2", `${label}: Mitbearbeiter ohne Entwürfe`);
  assert((await symbol(page, BOTH, "video").getAttribute("data-state")) === "final", `${label}: Mitbearbeiter ohne Final`);
  assert((await recapBtn(page, LEER, "video").getAttribute("data-state")) === "open", `${label}: Mitbearbeiter ohne C1`);
  assert((await recapBtn(page, DRAFTS, "diary").getAttribute("data-drafts")) === "2", `${label}: Mitbearbeiter-Button`);
  assert((await recapBtn(page, NOW, "video").count()) === 0, `${label}: Mitbearbeiter auf laufender Reise`);

  for (const role of ["viewer", "contributor"]) {
    state.role = role;
    await reloadHome(page);
    assert((await symbol(page, DRAFTS, "diary").count()) === 0, `${label}: ${role} sieht Entwürfe`);
    assert((await symbol(page, DRAFTS, "video").count()) === 0, `${label}: ${role} Video`);
    assert((await symbol(page, MIX, "video").count()) === 0, `${label}: ${role} sieht den Video-Entwurf`);
    assert((await symbol(page, MIX, "diary").getAttribute("data-state")) === "final", `${label}: ${role} ohne farbiges Tagebuch`);
    assert((await symbol(page, MIX, "diary").getAttribute("data-drafts")) === "0", `${label}: ${role} Plakette`);
    assert((await symbol(page, PLUS, "diary").getAttribute("data-state")) === "final", `${label}: ${role} Plus`);
    assert((await symbol(page, PLUS, "diary").getAttribute("data-drafts")) === "0", `${label}: ${role} sieht Plus-Entwürfe`);
    assert((await symbol(page, PLUS, "diary").locator(".card-sym__count").count()) === 0, `${label}: ${role} Zahl-Plakette`);
    assert((await symbol(page, BOTH, "video").getAttribute("data-state")) === "final", `${label}: ${role} Video-Final`);
    assert((await symbol(page, BOTH, "diary").getAttribute("data-state")) === "final", `${label}: ${role} Tagebuch-Final`);
    assert((await recapBtn(page, LEER, "video").count()) === 0, `${label}: ${role} sieht C1`);
    assert((await recapBtn(page, DRAFTS, "diary").count()) === 0, `${label}: ${role} sieht Entwurfs-Button`);
    assert((await recapBtn(page, MIX, "video").count()) === 0, `${label}: ${role} Video-Button`);
    assert((await recapBtn(page, MIX, "diary").getAttribute("data-state")) === "final", `${label}: ${role} Tagebuch-Button`);
    assert((await recapBtn(page, BOTH, "video").getAttribute("data-state")) === "final", `${label}: ${role} C4 Video`);
    assert((await recapBtn(page, BOTH, "diary").getAttribute("data-state")) === "final", `${label}: ${role} C4 Tagebuch`);
    assert((await page.locator("[data-testid='card-symbol-hint']:visible").count()) === 0, `${label}: ${role} Hinweis zurück`);
  }

  state.role = "owner";
  state.membersDown = true;
  await reloadHome(page);
  assert((await page.locator("[data-testid='card-symbol']").count()) === 0, `${label}: Symbole trotz Rollenfehler`);
  assert((await page.locator("[data-testid='app-toast']").count()) === 0, `${label}: Dialog beim Rollenfehler`);
  assert((await page.locator("[role='alertdialog']").count()) === 0, `${label}: Dialog beim Laden`);
  assert((await recapBtn(page, DRAFTS, "diary").count()) === 1, `${label}: eigene Reise ohne Button`);
  assert((await recapBtn(page, FOREIGN, "video").count()) === 1 && (await recapBtn(page, FOREIGN, "diary").count()) === 1, `${label}: unbekannte Rolle ohne Buttons`);
  await recapBtn(page, DRAFTS, "diary").click();
  await page.waitForSelector("[data-testid='diary-unavailable']");
  const ownedMsg = await page.locator("[data-testid='diary-unavailable']").innerText();
  assert(ownedMsg.includes("Rolle konnte nicht geladen werden"), `${label}: Besitzer «${ownedMsg}»`);
  assert(!ownedMsg.includes("Noch kein"), `${label}: Besitzer gilt als Gast «${ownedMsg}»`);
  assert(!ownedMsg.includes("TEXT-ZWEI"), `${label}: Entwurf trotz Rollenfehler`);
  await backToOverview(page);
  await recapBtn(page, FOREIGN, "diary").click();
  await page.waitForSelector("[data-testid='diary-unavailable']");
  const roleMsg = await page.locator("[data-testid='diary-unavailable']").innerText();
  assert(roleMsg.includes("Rolle konnte nicht geladen werden"), `${label}: «${roleMsg}»`);
  assert(!roleMsg.includes("Noch kein"), `${label}: unbekannte Rolle als Gast «${roleMsg}»`);
  assert(!roleMsg.includes("FREMD-TEXT"), `${label}: fremder Entwurf sichtbar`);
  await backToOverview(page);
  state.membersDown = false;

  state.role = "editor";
  state.recapMissing = true;
  await reloadHome(page);
  assert((await page.locator("[data-testid='card-symbol']").count()) === 0, `${label}: Symbole trotz fehlender Tabelle`);
  assert((await recapBtn(page, LEER, "video").count()) === 1 && (await recapBtn(page, LEER, "diary").count()) === 1, `${label}: Mitbearbeiter ohne Buttons`);
  assert((await page.locator("[data-testid='app-toast']").count()) === 0, `${label}: Fehlerdialog`);

  state.role = "viewer";
  await reloadHome(page);
  assert((await recapBtn(page, LEER, "video").count()) === 0, `${label}: Gast-Button ohne Tabelle`);
  assert((await recapBtn(page, BOTH, "diary").count()) === 0, `${label}: Gast-Final ohne Tabelle`);

  state.role = "owner";
  const beforeMissing = state.recapGets.length;
  await reloadHome(page);
  assert(state.recapGets.length > beforeMissing, `${label}: fehlende Tabelle ohne Abfrage`);
  assert(cardQueries(state).length === state.recapGets.filter((search) => new URLSearchParams(search).get("select") === "trip_id,kind,status,version,deleted_at").length, `${label}: fehlende Tabelle vervielfacht die Abfrage`);
  assert((await page.locator("[data-testid='card-symbol']").count()) === 0, `${label}: Besitzer-Symbole ohne Tabelle`);
  assert((await recapBtn(page, LEER, "video").getAttribute("data-state")) === "open", `${label}: Besitzer ohne Video-Button`);
  assert((await recapBtn(page, BOTH, "diary").getAttribute("data-state")) === "open", `${label}: Besitzer-Button bleibt grün`);
  assert((await page.locator(`[data-vacation-id="${BOTH}"] .card-compact__title`).innerText()) === "Beides", `${label}: Übersicht weg`);
  assert((await page.locator("[data-testid='app-toast']").count()) === 0, `${label}: Fehlerdialog beim Laden`);
  assert((await page.locator("[data-testid='cloud-load-error']").count()) === 0, `${label}: Cloud-Fehler`);
  assert((await page.locator("[role='alertdialog']").count()) === 0, `${label}: Dialog`);
  const getsBeforeTap = state.recapGets.length;
  await recapBtn(page, LEER, "video").click();
  await page.waitForSelector("[data-testid='recap-unavailable']");
  const missingVideo = await page.locator("[data-testid='recap-unavailable']").innerText();
  assert(missingVideo.includes("Recap-Video ist noch nicht verfügbar."), `${label}: «${missingVideo}»`);
  assert(state.recapGets.length <= getsBeforeTap + 1, `${label}: Tipp fragt pro Karte`);
  await backToOverview(page);
  await recapBtn(page, LEER, "diary").click();
  await page.waitForSelector("[data-testid='diary-unavailable']");
  const missingDiary = await page.locator("[data-testid='diary-unavailable']").innerText();
  assert(missingDiary.includes("Reisetagebuch ist noch nicht verfügbar."), `${label}: «${missingDiary}»`);
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
  page.setDefaultTimeout(60_000);
  const state = createMockSupabaseState();
  let releaseHold;
  state.holdCardQuery = new Promise((resolve) => {
    releaseHold = resolve;
  });
  state.releaseHold = releaseHold;
  await installSupabaseMocks(page, state);
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  const where = `${label} ${viewport.width}x${viewport.height}`;
  try {
    await login(page, baseUrl);
    await runFlows(page, state, where);
    const errors = pageErrors.filter((entry) => !/access control checks/i.test(entry));
    assert(errors.length === 0, `${where}: ${errors.join(" | ")}`);
    console.log(`Playwright 7 Karten-Symbole OK (${where}, Build 65)`);
  } finally {
    await browser.close();
  }
}

assertUniqueIndexHelpers();
const source = await readFile(path.join(root, "js/ui-card-symbols.js"), "utf8");
for (const word of ["Mitbearbeiter", "Besitzer", "Beitragender", "Beitragende"]) {
  assert(!source.includes(word), `gegenderter Text ${word}`);
}

const { server, baseUrl } = await startServer();
try {
  for (const viewport of VIEWPORTS) {
    await runSuite(chromium, baseUrl, "Chromium", viewport);
    await runSuite(webkit, baseUrl, "WebKit", viewport);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
console.log("Playwright 7 Karten-Symbole OK (Build 65)");
