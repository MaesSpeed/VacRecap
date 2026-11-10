import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";
import {
  USER,
  createMockSupabaseState,
  installSupabaseMocks,
  startServer,
} from "./run-tests-12b-recap-video.mjs";
import { runIsolationRefreshTest } from "./isolation-refresh.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const TRIP = "trip-perf";

const LIMITS = {
  tripListNotesGets: 1,
  saveTotal: 25,
  saveAuth: 0,
  sheetOpen: 3,
  cardTap: 3,
};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function seedPerfTrip(state) {
  const days = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"];
  state.trips = [
    {
      id: TRIP,
      title: "Perf Gardasee",
      start_date: days[0],
      end_date: days[days.length - 1],
      created_at: `${days[0]}T00:00:00.000Z`,
      updated_at: `${days[days.length - 1]}T00:00:00.000Z`,
      created_by: USER,
      companions: [],
      companion_tags: [],
      cover_media_id: null,
      cover_preset: "stadt",
      deleted_at: null,
    },
  ];
  state.waypoints = [];
  state.notes = [];
  state.media = [];
  for (let i = 0; i < 40; i += 1) {
    const day = days[i % days.length];
    const id = `wp-${String(i).padStart(2, "0")}`;
    state.waypoints.push({
      id,
      trip_id: TRIP,
      day,
      visited_at: `${day}T${String(8 + (i % 10)).padStart(2, "0")}:00:00.000Z`,
      lat: 45.8,
      lng: 10.8,
      accuracy_m: 8,
      title: `Ort ${i + 1}`,
      is_soft: false,
      source: "manual",
      deleted_at: null,
      created_at: `${day}T08:00:00.000Z`,
      updated_at: `${day}T08:00:00.000Z`,
      created_by: USER,
    });
    state.media.push({
      id: `${id}-m0`,
      trip_id: TRIP,
      waypoint_id: id,
      day,
      taken_at: `${day}T09:00:00.000Z`,
      kind: "photo",
      storage_path: `orig/${id}.jpg`,
      thumb_path: `${id}.jpg`,
      mime: "image/jpeg",
      upload_status: "uploaded",
      deleted_at: null,
      created_at: `${day}T09:00:00.000Z`,
      updated_at: `${day}T09:00:00.000Z`,
      created_by: USER,
    });
    state.notes.push({
      id: `${id}-n0`,
      trip_id: TRIP,
      waypoint_id: id,
      day,
      body: `Notiz ${i + 1}`,
      deleted_at: null,
      created_at: `${day}T10:00:00.000Z`,
      updated_at: `${day}T10:00:00.000Z`,
      created_by: USER,
    });
  }
}

const DATA_TABLES = new Set(["trips", "waypoints", "notes", "media"]);

function createMeter(page) {
  const counts = { total: 0, api: 0, auth: 0, notesGets: 0, dataGets: 0 };
  const onRequest = (req) => {
    const href = req.url();
    if (!href || !href.includes(SUPABASE_HOST)) return;
    const url = new URL(href);
    counts.total += 1;
    if (href.includes("/auth/v1/user")) counts.auth += 1;
    else counts.api += 1;
    if (href.includes("/rest/v1/notes") && req.method() === "GET") counts.notesGets += 1;
    if (href.includes("/rest/v1/") && req.method() === "GET") {
      const table = url.pathname.split("/").filter(Boolean).pop();
      if (DATA_TABLES.has(table)) counts.dataGets += 1;
    }
  };
  page.on("request", onRequest);
  return {
    reset() {
      counts.total = 0;
      counts.api = 0;
      counts.auth = 0;
      counts.notesGets = 0;
      counts.dataGets = 0;
    },
    stop() {
      page.off("request", onRequest);
    },
    snapshot() {
      return { ...counts };
    },
  };
}

async function loginFast(page, baseUrl) {
  await page.goto(baseUrl);
  await page.waitForSelector('.screen--urlaube, [data-testid="login-screen"]', { timeout: 20_000 });
  if (await page.locator('[data-testid="login-screen"]').count()) {
    await page.evaluate(async () => {
      const { setRememberLocationOnOpen } = await import("./js/settings-store.js");
      await setRememberLocationOnOpen(false);
    });
    await page.fill('input[name="email"]', "test@example.com");
    await page.click('form[data-step="email"] button[type="submit"]');
    await page.waitForSelector('form[data-step="otp"]');
    await page.fill('input[name="otp"]', "123456");
    await page.click('form[data-step="otp"] button[type="submit"]');
    await page.waitForSelector(".screen--urlaube", { timeout: 20_000 });
  }
}

function patchMockRpc(state) {
  const rest = state.handleRest.bind(state);
  state.handleRest = async (url, method, body, headers) => {
    if (url.pathname.includes("list_trip_people")) return { status: 200, json: [] };
    if (url.pathname.endsWith("/rpc/list_my_trip_invites")) return { status: 200, json: [] };
    if (url.pathname.endsWith("/rpc/list_trip_presence")) return { status: 200, json: [] };
    const table = url.pathname.split("/").filter(Boolean).pop();
    if (table === "notes" && method === "PATCH") {
      const id = (url.searchParams.get("id") || "").replace(/^eq\./, "");
      const row = state.notes.find((note) => note.id === id);
      if (!row) return { status: 406, json: { message: "0 rows" } };
      Object.assign(row, JSON.parse(body || "{}"), { updated_at: new Date().toISOString() });
      return { status: 200, json: [row] };
    }
    if (table === "waypoints" && method === "PATCH") {
      const id = (url.searchParams.get("id") || "").replace(/^eq\./, "");
      const row = state.waypoints.find((wp) => wp.id === id);
      if (!row) return { status: 406, json: { message: "0 rows" } };
      const patch = JSON.parse(body || "{}");
      if (patch.title != null) patch.title = patch.title;
      if (patch.title == null && patch.name != null) patch.title = patch.name;
      Object.assign(row, patch, { updated_at: new Date().toISOString() });
      return { status: 200, json: [row] };
    }
    return rest(url, method, body, headers);
  };
}

async function openTripDay(page, dayIso) {
  await page.locator(`[data-vacation-id="${TRIP}"]`).first().click({ timeout: 10_000 });
  await page.waitForSelector(".screen--trip", { timeout: 20_000 });
  await page.locator(`[data-day="${dayIso}"]`).click();
  await page.waitForSelector('[data-testid="place-list"] .oc', { timeout: 20_000 });
}

async function runPerfScenario() {
  await runIsolationRefreshTest();
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices["iPhone 8"], baseURL: baseUrl });
  const page = await ctx.newPage();
  const state = createMockSupabaseState();
  seedPerfTrip(state);
  patchMockRpc(state);
  await installSupabaseMocks(page, state);
  const meter = createMeter(page);

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await loginFast(page, baseUrl);

  meter.reset();
  await page.goto(`${baseUrl}#/urlaube`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(`[data-vacation-id="${TRIP}"]`, { timeout: 20_000 });
  const tripList = meter.snapshot();

  await openTripDay(page, "2026-10-30");
  await page.waitForTimeout(1200);

  const beforePick = await page.locator(".oc--selected").getAttribute("data-place-id");
  meter.reset();
  const target = page.locator('.oc[data-place-id]:not(.oc--selected)').first();
  const targetId = await target.getAttribute("data-place-id");
  assert(targetId && targetId !== beforePick, "need a different card to tap");
  await target.click();
  await page.waitForFunction(
    (id) => document.querySelector(".oc.oc--selected")?.dataset.placeId === id,
    targetId,
    { timeout: 10_000 }
  );
  await page.waitForTimeout(300);
  const cardTap = meter.snapshot();

  await page.waitForSelector('[data-footer-action="note"]', { timeout: 15_000 });
  meter.reset();
  await page.locator('[data-footer-action="note"]').click({ timeout: 10_000 });
  await page.waitForSelector('[data-testid="note-sheet"]', { timeout: 10_000 });
  await page.waitForTimeout(300);
  const sheetOpen = meter.snapshot();
  await page.locator('[data-testid="note-sheet"] [data-action="cancel"]').click();

  meter.reset();
  await page.locator('.oc--selected [data-action="edit-note"]').click({ timeout: 10_000 });
  await page.waitForSelector('[data-testid="note-sheet"]');
  const textarea = page.locator('[data-testid="note-sheet"] textarea');
  await textarea.fill(`${await textarea.inputValue()} (perf)`);
  await page.locator('[data-testid="note-sheet"] [data-action="save"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]', { state: "detached", timeout: 15_000 });
  await page.waitForTimeout(400);
  const save = meter.snapshot();

  const RENAMED = "Perf Renamed Ort";
  await page.locator('.oc--selected [data-action="edit-place"]').click();
  await page.waitForSelector(".sheet--place-edit");
  await page.locator('.sheet--place-edit [data-role="name"]').fill(RENAMED);
  await page.locator('.sheet--place-edit [data-action="save"]').click();
  await page.waitForSelector(".sheet--place-edit", { state: "detached", timeout: 15_000 });
  const cardTitle = (await page.locator(".oc--selected .oc__title span").first().textContent()) || "";
  assert(cardTitle.includes(RENAMED), `card still shows «${cardTitle.trim()}» after save`);
  await page.locator('.oc--selected [data-action="edit-place"]').click();
  await page.waitForSelector(".sheet--place-edit");
  const sheetName = await page.locator('.sheet--place-edit [data-role="name"]').inputValue();
  assert(sheetName === RENAMED, `sheet name «${sheetName}»`);
  await page.locator('.sheet--place-edit [data-action="cancel"]').click();

  assert(errors.length === 0, `page errors: ${errors.join(" | ")}`);
  assert(
    tripList.notesGets <= LIMITS.tripListNotesGets,
    `trip list notes GETs ${tripList.notesGets} > ${LIMITS.tripListNotesGets}`
  );
  assert(save.total <= LIMITS.saveTotal, `save requests ${save.total} > ${LIMITS.saveTotal}`);
  assert(save.auth <= LIMITS.saveAuth, `save auth/user ${save.auth} > ${LIMITS.saveAuth}`);
  assert(sheetOpen.dataGets <= LIMITS.sheetOpen, `sheet open data GETs ${sheetOpen.dataGets} > ${LIMITS.sheetOpen}`);
  assert(cardTap.dataGets <= LIMITS.cardTap, `card tap data GETs ${cardTap.dataGets} > ${LIMITS.cardTap}`);

  console.log(
    JSON.stringify(
      {
        tripList,
        cardTap,
        sheetOpen,
        save,
        limits: LIMITS,
      },
      null,
      2
    )
  );
  console.log("Perf P1 request-budget test grün");

  meter.stop();
  await ctx.close();
  await browser.close();
  server.close();
}

runPerfScenario().catch((err) => {
  console.error(err);
  process.exit(1);
});
