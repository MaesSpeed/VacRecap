import { chromium, devices } from "playwright";
import {
  USER,
  createMockSupabaseState,
  installSupabaseMocks,
  startServer,
} from "./run-tests-12b-recap-video.mjs";

const TRIP = "trip-p3";
const DAY1 = "2026-10-01";
const DAY2 = "2026-10-02";
const DAY3 = "2026-10-03";
const OTHER = "22222222-2222-2222-2222-222222222222";
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const CUR = "[data-page='current']";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function placeRow(id, title, day, time, author = USER) {
  return {
    id,
    trip_id: TRIP,
    day,
    visited_at: `${day}T${time}.000Z`,
    lat: 45.8,
    lng: 10.8,
    accuracy_m: 8,
    title,
    is_soft: false,
    source: "manual",
    deleted_at: null,
    created_at: `${day}T${time}.000Z`,
    updated_at: `${day}T${time}.000Z`,
    created_by: author,
  };
}

function noteRow(id, placeId, day, body, author = USER) {
  return {
    id,
    trip_id: TRIP,
    waypoint_id: placeId,
    day,
    body,
    deleted_at: null,
    created_at: `${day}T10:00:00.000Z`,
    updated_at: `${day}T10:00:00.000Z`,
    created_by: author,
  };
}

function photoRow(id, placeId, day, author = USER, caption = null) {
  return {
    id,
    trip_id: TRIP,
    waypoint_id: placeId,
    day,
    taken_at: `${day}T12:00:00.000Z`,
    kind: "photo",
    storage_path: `orig/${id}.jpg`,
    thumb_path: `${id}.jpg`,
    mime: "image/jpeg",
    upload_status: "uploaded",
    caption,
    deleted_at: null,
    created_at: `${day}T12:00:00.000Z`,
    updated_at: `${day}T12:00:00.000Z`,
    created_by: author,
  };
}

function seedTrip(state) {
  state.trips.push({
    id: TRIP,
    title: "Perf Paket 3",
    start_date: DAY1,
    end_date: DAY3,
    created_at: `${DAY1}T00:00:00.000Z`,
    updated_at: `${DAY3}T00:00:00.000Z`,
    created_by: USER,
    companions: [],
    companion_tags: [],
    cover_media_id: null,
    cover_preset: "stadt",
    deleted_at: null,
  });
  state.waypoints.push(
    placeRow("p-alpha", "Alpha Ort", DAY1, "08:00:00"),
    placeRow("p-beta", "Beta Ort", DAY1, "18:00:00"),
    placeRow("p-gamma", "Gamma Ort", DAY2, "09:00:00"),
    placeRow("p-delta", "Delta Ort", DAY3, "09:00:00", OTHER)
  );
  state.notes.push(
    noteRow("n-alpha", "p-alpha", DAY1, "Alpha Notiz"),
    noteRow("n-beta", "p-beta", DAY1, "Beta Notiz"),
    noteRow("n-free", null, DAY1, "Freie Zeile"),
    noteRow("n-gamma", "p-gamma", DAY2, "Gamma Notiz"),
    noteRow("n-delta", "p-delta", DAY3, "Fremde Notiz", OTHER)
  );
  state.media.push(
    photoRow("m-alpha", "p-alpha", DAY1, USER, null),
    photoRow("m-beta", "p-beta", DAY1, USER, "Beta Bild"),
    photoRow("m-delta", "p-delta", DAY3, OTHER, "Fremdes Bild")
  );
}

function listOf(state, table) {
  if (table === "notes") return state.notes;
  if (table === "media") return state.media;
  if (table === "waypoints") return state.waypoints;
  return null;
}

function matchRows(list, url) {
  let out = list.slice();
  for (const [key, value] of url.searchParams.entries()) {
    if (["select", "order", "offset", "limit", "on_conflict"].includes(key)) continue;
    if (value === "is.null") out = out.filter((row) => row[key] == null);
    else if (value === "not.is.null") out = out.filter((row) => row[key] != null);
    else if (value.startsWith("eq.")) out = out.filter((row) => String(row[key]) === value.slice(3));
    else if (value.startsWith("in.(") && value.endsWith(")")) {
      const set = new Set(value.slice(4, -1).split(","));
      out = out.filter((row) => set.has(String(row[key])));
    }
  }
  return out;
}

function represent(row, headers) {
  const accept = headers.accept || "";
  if (accept.includes("application/vnd.pgrst.object+json")) return row;
  return [row];
}

function allowWrites(state) {
  const rest = state.handleRest.bind(state);
  state.handleRest = async (url, method, body, headers) => {
    const table = url.pathname.split("/").filter(Boolean).pop();
    if (table === "trip_members" && method === "GET") {
      return {
        status: 200,
        json: { role: state.role, trip_id: TRIP, user_id: USER },
      };
    }
    const list = listOf(state, table);
    if (list && (method === "POST" || method === "PATCH")) {
      const patch = JSON.parse(body || "{}");
      if (method === "POST") {
        const id = patch.id || crypto.randomUUID();
        let row = list.find((item) => item.id === id);
        if (!row) {
          row = {
            id,
            created_by: USER,
            created_at: new Date().toISOString(),
            deleted_at: null,
          };
          list.push(row);
        }
        Object.assign(row, patch, { id, updated_at: new Date().toISOString() });
        return { status: 201, json: represent(row, headers) };
      }
      let rows = matchRows(list, url);
      if (!rows.length && table === "notes") {
        const id = (url.searchParams.get("id") || "").replace(/^eq\./, "");
        rows = list.filter((item) => item.id === id);
      }
      const now = new Date().toISOString();
      for (const row of rows) Object.assign(row, patch, { updated_at: now });
      const accept = headers.accept || "";
      if (accept.includes("application/vnd.pgrst.object+json")) {
        if (!rows.length) return { status: 406, json: { message: "0 rows" } };
        return { status: 200, json: rows[0] };
      }
      return { status: 200, json: rows };
    }
    return rest(url, method, body, headers);
  };
}

function createMeter(page) {
  const counts = { notes: 0, media: 0, waypoints: 0, total: 0 };
  const onRequest = (req) => {
    const href = req.url();
    if (!href.includes(SUPABASE_HOST)) return;
    counts.total += 1;
    const url = new URL(href);
    if (req.method() !== "GET" || !url.pathname.includes("/rest/v1/") || url.pathname.includes("/rpc/")) return;
    const table = url.pathname.split("/").filter(Boolean).pop();
    if (table === "notes" || table === "media" || table === "waypoints") counts[table] += 1;
  };
  page.on("request", onRequest);
  return {
    reset() {
      counts.notes = 0;
      counts.media = 0;
      counts.waypoints = 0;
      counts.total = 0;
    },
    snapshot() {
      return { ...counts, data: counts.notes + counts.media + counts.waypoints };
    },
  };
}

async function login(page, baseUrl) {
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

function installSwipe(page) {
  return page.addInitScript(() => {
    function fireTouch(el, phase, x, y) {
      const touchType = phase === "start" ? "touchstart" : phase === "move" ? "touchmove" : "touchend";
      const ended = phase === "end";
      const touch = new Touch({
        identifier: 1,
        target: el,
        clientX: x,
        clientY: y,
        pageX: x,
        pageY: y,
        radiusX: 2,
        radiusY: 2,
        rotationAngle: 0,
        force: 0.5,
      });
      const list = ended ? [] : [touch];
      el.dispatchEvent(
        new TouchEvent(touchType, {
          bubbles: true,
          cancelable: true,
          touches: list,
          targetTouches: list,
          changedTouches: [touch],
        })
      );
    }
    window.__swipeDay = (dx) => {
      const el = document.querySelector('[data-testid="trip-content"]');
      const rect = el.getBoundingClientRect();
      const x0 = rect.left + rect.width / 2;
      const y0 = rect.top + Math.min(140, Math.max(36, rect.height / 2));
      const steps = 5;
      fireTouch(el, "start", x0, y0);
      for (let i = 1; i <= steps; i += 1) fireTouch(el, "move", x0 + (dx * i) / steps, y0);
      fireTouch(el, "end", x0 + dx, y0);
    };
  });
}

async function openTrip(page, day = DAY1) {
  await page.locator(`[data-vacation-id="${TRIP}"]`).first().click();
  await page.waitForSelector(`${CUR} .oc--selected`, { timeout: 20_000 });
  await page.waitForFunction(
    (iso) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === iso,
    day
  );
}

async function goToDay(page, iso) {
  const current = await page.locator('[data-testid="trip-content"]').getAttribute("data-active-day");
  if (current === iso) return;
  await page.locator(`.day-chip[data-day="${iso}"]`).click();
  await page.waitForFunction(
    (day) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === day,
    iso
  );
  await page.waitForSelector(`${CUR} .oc`, { timeout: 15_000 });
}

async function swipeTo(page, iso, dx) {
  await page.evaluate((delta) => window.__swipeDay(delta), dx);
  await page.waitForFunction(
    (day) => {
      const root = document.querySelector('[data-testid="trip-content"]');
      return root?.dataset.activeDay === day && root.dataset.swipeLock !== "1" && root.dataset.gesture !== "1";
    },
    iso,
    { timeout: 15_000 }
  );
  await page.waitForSelector(`${CUR} .oc`, { timeout: 15_000 });
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="trip-content"]');
    if (root) root.dataset.suppressClick = "0";
  });
}

async function openSelected(page, action, sheet) {
  await page.locator(`${CUR} .oc--selected ${action}`).first().click();
  await page.waitForSelector(sheet);
}

async function cancelSheet(page, sheet, cancel) {
  await page.locator(cancel).click();
  await page.waitForSelector(sheet, { state: "detached" });
}

async function run() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices["iPhone 8"], baseURL: baseUrl });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await installSwipe(page);
  const state = createMockSupabaseState();
  seedTrip(state);
  allowWrites(state);
  await installSupabaseMocks(page, state);
  const meter = createMeter(page);

  await login(page, baseUrl);
  await openTrip(page);
  await page.waitForTimeout(700);

  const before = {};

  meter.reset();
  await openSelected(page, '[data-action="edit-place"]', ".sheet--place-edit");
  const placeName = await page.locator('.sheet--place-edit [data-role="name"]').inputValue();
  assert(placeName === "Beta Ort", `Ort-Sheet zeigt «${placeName}»`);
  await cancelSheet(page, ".sheet--place-edit", '.sheet--place-edit [data-action="cancel"]');
  await openSelected(page, '[data-action="edit-place"]', ".sheet--place-edit");
  await cancelSheet(page, ".sheet--place-edit", '.sheet--place-edit [data-action="cancel"]');
  before.placeSheet = meter.snapshot();

  meter.reset();
  await openSelected(page, '[data-action="edit-note"]', '[data-testid="note-sheet"]');
  const noteText = await page.locator('[data-testid="note-sheet"] textarea').inputValue();
  assert(noteText === "Beta Notiz", `Notiz-Sheet zeigt «${noteText}»`);
  await cancelSheet(page, '[data-testid="note-sheet"]', '[data-testid="note-sheet"] [data-action="cancel"]');
  await openSelected(page, '[data-action="edit-note"]', '[data-testid="note-sheet"]');
  await cancelSheet(page, '[data-testid="note-sheet"]', '[data-testid="note-sheet"] [data-action="cancel"]');
  before.noteSheet = meter.snapshot();

  meter.reset();
  await page.locator(`${CUR} [data-testid="free-notes"] [data-action="edit-free-note"]`).click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  const freeText = await page.locator('[data-testid="note-sheet"] textarea').inputValue();
  assert(freeText === "Freie Zeile", `Freie Notiz zeigt «${freeText}»`);
  await cancelSheet(page, '[data-testid="note-sheet"]', '[data-testid="note-sheet"] [data-action="cancel"]');
  before.freeSheet = meter.snapshot();

  meter.reset();
  await openSelected(page, '[data-testid="photo-caption-edit"]', '[data-testid="photo-caption-sheet"]');
  const caption = await page.locator('[data-testid="photo-caption-text"]').inputValue();
  assert(caption === "Beta Bild", `Foto-Sheet zeigt «${caption}»`);
  await cancelSheet(page, '[data-testid="photo-caption-sheet"]', '[data-testid="photo-caption-cancel"]');
  await openSelected(page, '[data-testid="photo-caption-edit"]', '[data-testid="photo-caption-sheet"]');
  await cancelSheet(page, '[data-testid="photo-caption-sheet"]', '[data-testid="photo-caption-cancel"]');
  before.photoSheet = meter.snapshot();

  meter.reset();
  const otherId = await page.locator(`${CUR} .oc[data-place-id]:not(.oc--selected)`).first().getAttribute("data-place-id");
  await page.locator(`${CUR} .oc[data-place-id="${otherId}"] .oc__title`).click();
  await page.waitForFunction(
    (id) => document.querySelector("[data-page='current'] .oc--selected")?.dataset.placeId === id,
    otherId
  );
  await page.waitForTimeout(250);
  before.cardTap = meter.snapshot();
  await page.locator(`${CUR} .oc[data-place-id="p-beta"] .oc__title`).click();
  await page.waitForFunction(
    () => document.querySelector("[data-page='current'] .oc--selected")?.dataset.placeId === "p-beta"
  );

  await swipeTo(page, DAY2, -180);
  await openSelected(page, '[data-action="edit-note"]', '[data-testid="note-sheet"]');
  await page.locator('[data-testid="note-sheet"] textarea').fill("Gamma neu");
  await page.locator('[data-testid="note-sheet"] [data-action="save"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]', { state: "detached" });
  await page.waitForFunction(
    () => document.querySelector("[data-page='current'] .oc--selected")?.textContent?.includes("Gamma neu")
  );
  await swipeTo(page, DAY1, 180);
  await page.locator(`${CUR} .oc[data-place-id="p-alpha"] .oc__title`).click();
  await page.waitForFunction(
    () => document.querySelector("[data-page='current'] .oc--selected")?.dataset.placeId === "p-alpha"
  );
  await openSelected(page, '[data-action="edit-note"]', '[data-testid="note-sheet"]');
  const alphaAfter = await page.locator('[data-testid="note-sheet"] textarea').inputValue();
  assert(alphaAfter === "Alpha Notiz", `Tag 1 ist veraltet («${alphaAfter}»)`);
  await cancelSheet(page, '[data-testid="note-sheet"]', '[data-testid="note-sheet"] [data-action="cancel"]');
  await swipeTo(page, DAY2, -180);
  await openSelected(page, '[data-action="edit-note"]', '[data-testid="note-sheet"]');
  const gammaAfter = await page.locator('[data-testid="note-sheet"] textarea').inputValue();
  assert(gammaAfter === "Gamma neu", `Tag 2 zeigt noch «${gammaAfter}»`);
  await cancelSheet(page, '[data-testid="note-sheet"]', '[data-testid="note-sheet"] [data-action="cancel"]');
  await swipeTo(page, DAY1, 180);

  await page.locator(`${CUR} .oc[data-place-id="p-beta"] .oc__title`).click();
  await page.waitForFunction(
    () => document.querySelector("[data-page='current'] .oc--selected")?.dataset.placeId === "p-beta"
  );
  await page.locator(`${CUR} .oc--selected [data-action="edit-place"]`).click();
  await page.waitForSelector('[data-testid="place-note-row"]');
  await page.locator('[data-testid="place-note-row"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.locator('[data-testid="note-sheet"] textarea').fill("Frisch notiert");
  await page.locator('[data-testid="note-sheet"] [data-action="save"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]', { state: "detached" });
  await page.waitForFunction(() =>
    document.querySelector("[data-page='current'] .oc[data-place-id=\"p-beta\"]")?.textContent?.includes("Frisch notiert")
  );
  meter.reset();
  await page.locator(`${CUR} .oc--selected [data-action="edit-note"]`, { hasText: "Frisch notiert" }).click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  const fresh = await page.locator('[data-testid="note-sheet"] textarea').inputValue();
  assert(fresh === "Frisch notiert", `Neue Notiz im Sheet «${fresh}»`);
  const freshOpen = meter.snapshot();
  await page.locator('[data-testid="note-sheet"] [data-action="delete"]').click();
  await page.locator('[data-testid="confirm-delete-note"] [data-action="confirm"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]', { state: "detached" });
  await page.waitForFunction(
    () => !document.querySelector("[data-page='current'] .oc[data-place-id=\"p-beta\"]")?.textContent?.includes("Frisch notiert")
  );
  await swipeTo(page, DAY2, -180);
  await swipeTo(page, DAY1, 180);
  assert(
    !(await page.locator(`${CUR} .oc[data-place-id="p-beta"]`).innerText()).includes("Frisch notiert"),
    "Gelöschte Notiz ist nach dem Wischen wieder da"
  );

  await page.locator(`${CUR} .oc[data-place-id="p-beta"] .oc__title`).click();
  await page.waitForFunction(
    () => document.querySelector("[data-page='current'] .oc--selected")?.dataset.placeId === "p-beta"
  );
  await page.locator(`${CUR} .oc--selected [data-action="edit-note"]`, { hasText: "Beta Notiz" }).click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.locator('[data-testid="note-sheet"] [data-action="change-place"]').click();
  await page.waitForSelector('[data-testid="note-place-sheet"]');
  await page.locator('[data-testid="note-place-sheet"] button', { hasText: "Alpha Ort" }).click();
  await page.locator('[data-testid="note-sheet"] [data-action="save"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]', { state: "detached" });
  await page.waitForFunction(() =>
    document.querySelector("[data-page='current'] .oc[data-place-id=\"p-alpha\"]")?.textContent?.includes("Beta Notiz")
  );
  await page.locator(`${CUR} .oc[data-place-id="p-alpha"] .oc__title`).click();
  await page.waitForFunction(
    () => document.querySelector("[data-page='current'] .oc--selected")?.dataset.placeId === "p-alpha"
  );
  await page.locator(`${CUR} .oc--selected [data-action="edit-note"]`, { hasText: "Beta Notiz" }).click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  assert(
    (await page.locator('[data-testid="note-sheet"] textarea').inputValue()) === "Beta Notiz",
    "Verschobene Notiz fehlt im Sheet"
  );
  await cancelSheet(page, '[data-testid="note-sheet"]', '[data-testid="note-sheet"] [data-action="cancel"]');
  await swipeTo(page, DAY2, -180);
  await swipeTo(page, DAY1, 180);
  assert(
    (await page.locator(`${CUR} .oc[data-place-id="p-alpha"]`).innerText()).includes("Beta Notiz"),
    "Verschobene Notiz fehlt nach dem Wischen"
  );

  await page.locator(`${CUR} .oc[data-place-id="p-beta"] .oc__title`).click();
  await page.waitForFunction(
    () => document.querySelector("[data-page='current'] .oc--selected")?.dataset.placeId === "p-beta"
  );
  await page.locator(`${CUR} .oc--selected [data-testid="photo-row-check"]`).first().click();
  await page.locator('[data-testid="photo-move"]').click();
  await page.waitForSelector('[data-testid="photo-move-sheet"]');
  await page.locator('[data-testid="photo-move-day"]').nth(1).click();
  await page.locator('[data-testid="photo-move-place"]:not([disabled])').click();
  await page.waitForFunction(
    () => !document.querySelector("[data-page='current'] .oc[data-place-id=\"p-beta\"] [data-testid=\"place-photo\"]")
  );
  await swipeTo(page, DAY2, -180);
  await page.waitForSelector(`${CUR} .oc[data-place-id="p-gamma"] [data-testid="place-photo"]`);
  meter.reset();
  await page.locator(`${CUR} .oc[data-place-id="p-gamma"] .oc__title`).click();
  await page.waitForFunction(
    () => document.querySelector("[data-page='current'] .oc--selected")?.dataset.placeId === "p-gamma"
  );
  const movedCaption = page.locator(`${CUR} .oc--selected [data-testid="photo-caption-edit"], ${CUR} .oc--selected [data-testid="photo-caption-row"]`);
  await movedCaption.first().click();
  await page.waitForSelector('[data-testid="photo-caption-sheet"], [data-testid="media-viewer"]');
  const movedOpen = meter.snapshot();
  if (await page.locator('[data-testid="photo-caption-sheet"]').count()) {
    const movedText = await page.locator('[data-testid="photo-caption-text"]').inputValue();
    assert(movedText === "Beta Bild", `Verschobenes Foto zeigt «${movedText}»`);
    await cancelSheet(page, '[data-testid="photo-caption-sheet"]', '[data-testid="photo-caption-cancel"]');
  } else {
    await page.locator('[data-testid="media-viewer-close"]').click();
    await page.waitForSelector('[data-testid="media-viewer"]', { state: "detached" });
  }
  await swipeTo(page, DAY1, 180);
  assert(
    (await page.locator(`${CUR} .oc[data-place-id="p-beta"] [data-testid="place-photo"]`).count()) === 0,
    "Verschobenes Foto liegt nach dem Zurückwischen noch am alten Ort"
  );

  await goToDay(page, DAY1);
  await goToDay(page, DAY2);
  await goToDay(page, DAY3);
  await page.waitForTimeout(600);
  meter.reset();
  await page.locator('[data-action="map"]').click();
  await page.waitForSelector('[data-testid="map-screen"]', { timeout: 20_000 });
  await page.waitForTimeout(500);
  const mapOpen = meter.snapshot();

  meter.reset();
  const dup = await page.evaluate(
    async ({ trip, day }) => {
      const { dropTripPlaceMemory, loadDayPlacesEnriched } = await import("./js/ui-place-list.js");
      dropTripPlaceMemory(trip);
      const [a, b] = await Promise.all([
        loadDayPlacesEnriched(trip, day, null),
        loadDayPlacesEnriched(trip, day, null),
      ]);
      const grouped = a.every((item) =>
        (item.notes || []).every((note) => !note.placeId || note.placeId === item.place.id)
      );
      const beta = a.find((item) => item.place.id === "p-beta");
      return {
        same: a === b,
        grouped,
        betaNotes: (beta?.notes || []).map((note) => note.text),
        count: a.length,
      };
    },
    { trip: TRIP, day: DAY1 }
  );
  const dedupe = meter.snapshot();

  state.role = "viewer";
  await login(page, baseUrl);
  await openTrip(page, DAY3);
  await page.waitForTimeout(400);
  const banner = await page.locator('[data-testid="role-banner"]').innerText();
  assert(banner.includes("Beitragender"), `Hinweis fehlt («${banner}»)`);
  await goToDay(page, DAY3);
  assert(
    (await page.locator(`${CUR} .oc[data-place-id="p-delta"] [data-action="edit-place"]`).count()) === 0,
    "Beitragender bearbeitet einen fremden Ort"
  );
  assert(
    (await page.locator(`${CUR} .oc[data-place-id="p-delta"] [data-action="edit-note"]`).count()) === 0,
    "Beitragender bearbeitet eine fremde Notiz"
  );
  await goToDay(page, DAY1);
  await page.locator(`${CUR} .oc[data-place-id="p-alpha"] .oc__title`).click();
  await page.waitForFunction(
    () => document.querySelector("[data-page='current'] .oc--selected")?.dataset.placeId === "p-alpha"
  );
  assert(
    (await page.locator(`${CUR} .oc--selected [data-action="edit-place"]`).count()) === 1,
    "Beitragender sieht den eigenen Ort nicht"
  );
  meter.reset();
  await page.locator(`${CUR} .oc--selected [data-action="edit-note"]`, { hasText: "Alpha Notiz" }).click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  assert(
    (await page.locator('[data-testid="note-sheet"] textarea').inputValue()) === "Alpha Notiz",
    "Eigene Notiz fehlt im Sheet des Beitragenden"
  );
  const viewerOpen = meter.snapshot();
  await cancelSheet(page, '[data-testid="note-sheet"]', '[data-testid="note-sheet"] [data-action="cancel"]');

  assert(errors.length === 0, `Seitenfehler: ${errors.join(" | ")}`);
  assert(before.placeSheet.data === 0, `Ort-Sheet lädt Daten (${before.placeSheet.data})`);
  assert(before.noteSheet.data === 0, `Notiz-Sheet lädt Daten (${before.noteSheet.data})`);
  assert(before.freeSheet.data === 0, `Freie Notiz lädt Daten (${before.freeSheet.data})`);
  assert(before.photoSheet.data === 0, `Foto-Sheet lädt Daten (${before.photoSheet.data})`);
  assert(before.cardTap.data === 0, `Kartentipp lädt Daten (${before.cardTap.data})`);
  assert(freshOpen.data === 0, `Erneutes Notiz-Sheet lädt Daten (${freshOpen.data})`);
  assert(movedOpen.data === 0, `Verschobenes Foto lädt den Tag neu (${movedOpen.data})`);
  assert(mapOpen.notes === 0 && mapOpen.media === 0 && mapOpen.waypoints === 0, `Karte lädt die Liste neu (${JSON.stringify(mapOpen)})`);
  assert(dup.same && dup.grouped && dup.count >= 2, `Tagesgruppierung stimmt nicht (${JSON.stringify(dup)})`);
  assert(
    dedupe.notes <= 1 && dedupe.media <= 1 && dedupe.waypoints <= 1,
    `Parallele Tagesladung ist nicht zusammengefasst (${JSON.stringify(dedupe)})`
  );
  assert(viewerOpen.data === 0, `Beitragender lädt das Notiz-Sheet neu (${viewerOpen.data})`);

  console.log(
    JSON.stringify(
      {
        before,
        freshOpen,
        movedOpen,
        mapOpen,
        dedupe,
        dup,
        viewerOpen,
      },
      null,
      2
    )
  );
  console.log("Perf P3 Sheets-Cache grün");

  await ctx.close();
  await browser.close();
  server.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
