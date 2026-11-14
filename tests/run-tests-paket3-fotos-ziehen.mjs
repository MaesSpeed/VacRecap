import { chromium, webkit } from "playwright";
import { buildVideoRecap } from "../js/recap-storyboard.js";
import {
  USER,
  createMockSupabaseState,
  installSupabaseMocks,
  startServer,
} from "./run-tests-12b-recap-video.mjs";

const TRIP = "trip-paket3";
const OTHER = "22222222-2222-2222-2222-222222222222";
const DAYS = ["2026-10-26", "2026-10-27", "2026-10-28"];
const HINT =
  "Den Tag können hier nur Besitzer oder Mitbearbeiter ändern, weil Fotos oder Notizen anderer dabei sind.";
const VIEWPORTS = [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];
const CUSTOM = ["m1", "m2", "m3", "m4", "m5", "m6"];
const BY_TIME = ["m6", "m5", "m4", "m3", "m2", "m1"];
const report = [];

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function placeRow(id, title, day, time, author = USER) {
  const iso = `${day}T${time}.000Z`;
  return {
    id,
    trip_id: TRIP,
    day,
    visited_at: iso,
    lat: 45.6,
    lng: 10.75,
    accuracy_m: 8,
    title,
    is_soft: false,
    source: "manual",
    deleted_at: null,
    created_at: iso,
    updated_at: iso,
    created_by: author,
  };
}

function photoRow(id, placeId, day, time, author, caption, sortOrder = null) {
  const iso = `${day}T${time}.000Z`;
  return {
    id,
    trip_id: TRIP,
    waypoint_id: placeId,
    day,
    taken_at: iso,
    kind: "photo",
    storage_path: `orig/${id}.jpg`,
    thumb_path: `${id}.jpg`,
    mime: "image/jpeg",
    upload_status: "uploaded",
    caption,
    sort_order: sortOrder,
    deleted_at: null,
    created_at: iso,
    updated_at: iso,
    created_by: author,
  };
}

function noteRow(id, placeId, day, body) {
  const iso = `${day}T18:${String(id).padStart(2, "0")}:00.000Z`;
  return {
    id: `n-${id}`,
    trip_id: TRIP,
    waypoint_id: placeId,
    day,
    body,
    deleted_at: null,
    created_at: iso,
    updated_at: iso,
    created_by: USER,
  };
}

function parkPhotos({ sorted = false } = {}) {
  return CUSTOM.map((id, index) => ({
    id,
    placeId: "p-park",
    ts: Date.parse(`${DAYS[1]}T${String(13 - index).padStart(2, "0")}:00:00.000Z`),
    type: "photo",
    uploadStatus: "uploaded",
    ...(sorted ? { sortOrder: index + 1 } : {}),
  }));
}

function materialPlaces() {
  return [
    { id: "p-prev", name: "Vortag", day: DAYS[0], ts: Date.parse(`${DAYS[0]}T09:00:00.000Z`), soft: false },
    { id: "p-park", name: "Sigurta Park", day: DAYS[1], ts: Date.parse(`${DAYS[1]}T12:00:00.000Z`), soft: false },
    { id: "p-mix", name: "Gemischter Ort", day: DAYS[1], ts: Date.parse(`${DAYS[1]}T11:00:00.000Z`), soft: false },
    { id: "p-ziel", name: "Zielort", day: DAYS[1], ts: Date.parse(`${DAYS[1]}T10:00:00.000Z`), soft: false },
    { id: "p-next", name: "Folgetag", day: DAYS[2], ts: Date.parse(`${DAYS[2]}T09:00:00.000Z`), soft: false },
  ];
}

function parkIds(content) {
  const scene = (content?.scenes || []).find((item) => item.waypoint_id === "p-park");
  return (scene?.media_ids || []).join(",");
}

function seed(state, { withFinal = true } = {}) {
  state.trips.length = 0;
  state.waypoints.length = 0;
  state.notes.length = 0;
  state.media.length = 0;
  state.recaps.length = 0;
  state.calls = [];
  state.gets = [];
  state.sortMisses = 0;
  state.people = [
    { user_id: USER, display_name: "Dominik", role: "owner", person_kind: "member", status: "aktiv", avatar_color: "#0066b3" },
    { user_id: OTHER, display_name: "Sabine", role: "editor", person_kind: "member", status: "aktiv", avatar_color: "#D64541" },
  ];
  state.trips.push({
    id: TRIP,
    title: "Paket 3",
    start_date: DAYS[0],
    end_date: DAYS[2],
    created_at: `${DAYS[0]}T08:00:00.000Z`,
    updated_at: `${DAYS[0]}T08:00:00.000Z`,
    created_by: USER,
    companions: [],
    companion_tags: [],
    cover_media_id: null,
    cover_preset: "stadt",
    deleted_at: null,
  });
  state.waypoints.push(
    placeRow("p-prev", "Vortag", DAYS[0], "09:00:00"),
    placeRow("p-park", "Sigurta Park", DAYS[1], "12:00:00"),
    placeRow("p-mix", "Gemischter Ort", DAYS[1], "11:00:00"),
    placeRow("p-ziel", "Zielort", DAYS[1], "10:00:00"),
    placeRow("p-next", "Folgetag", DAYS[2], "09:00:00")
  );
  CUSTOM.forEach((id, index) => {
    state.media.push(
      photoRow(id, "p-park", DAYS[1], `${String(13 - index).padStart(2, "0")}:00:00`, USER, `Notiz ${id}`, index + 1)
    );
  });
  state.media.push(photoRow("m-mix", "p-mix", DAYS[1], "11:20:00", OTHER, "Fremdes Foto", null));
  for (let i = 1; i <= 6; i += 1) state.notes.push(noteRow(i, "p-park", DAYS[1], `Parknotiz ${i}`));
  if (withFinal) {
    const built = buildVideoRecap({
      places: materialPlaces(),
      photos: [...parkPhotos(), { id: "m-mix", placeId: "p-mix", ts: Date.parse(`${DAYS[1]}T11:20:00.000Z`), type: "photo", uploadStatus: "uploaded" }],
      notes: [],
    });
    assert(built.ok, "Zeit-Recap lässt sich nicht bauen");
    state.timeIds = parkIds(built.content);
    state.recaps.push({
      id: "recap-final",
      trip_id: TRIP,
      kind: "video",
      status: "final",
      version: 1,
      content: built.content,
      feedback: [],
      source_text: null,
      deleted_at: null,
      created_at: `${DAYS[2]}T16:00:00.000Z`,
      updated_at: `${DAYS[2]}T16:00:00.000Z`,
      created_by: USER,
    });
  }
}

function allowWrites(state) {
  const rest = state.handleRest.bind(state);
  state.handleRest = async (url, method, body, headers) => {
    const table = url.pathname.split("/").filter(Boolean).pop();
    state.calls.push(`${method} ${url.pathname}`);
    if (method === "GET") state.gets.push(table);
    if (url.pathname.includes("list_trip_people")) return { status: 200, json: state.people };
    if (
      url.pathname.includes("list_trip_presence") ||
      url.pathname.includes("list_my_trip_invites") ||
      url.pathname.includes("touch_trip_presence") ||
      url.pathname.includes("clear_trip_presence")
    ) {
      return { status: 200, json: [] };
    }
    if (url.pathname.endsWith("/rpc/set_place_media_order")) {
      if (state.rpcMissing) {
        return {
          status: 404,
          json: {
            code: "PGRST202",
            message: "Could not find the function public.set_place_media_order(p_waypoint_id, p_media_ids, p_reset) in the schema cache",
          },
        };
      }
      if (state.role === "viewer") {
        return { status: 403, json: { code: "42501", message: "Dafür fehlt die Berechtigung." } };
      }
      const payload = JSON.parse(body || "{}");
      const placeId = payload.p_waypoint_id;
      const before = state.media.map((row) => ({ id: row.id, taken_at: row.taken_at }));
      if (payload.p_reset) {
        for (const row of state.media) {
          if (row.waypoint_id === placeId) row.sort_order = null;
        }
      } else {
        const ids = payload.p_media_ids || [];
        const seen = new Set();
        ids.forEach((id, index) => {
          const row = state.media.find((item) => item.id === id && item.waypoint_id === placeId);
          if (!row || seen.has(id)) return;
          seen.add(id);
          row.sort_order = index + 1;
        });
        for (const row of state.media) {
          if (row.waypoint_id === placeId && !seen.has(row.id)) row.sort_order = null;
        }
      }
      const stamp = new Date().toISOString();
      state.lastSortStamp = stamp;
      for (const row of state.media) {
        if (row.waypoint_id === placeId) row.updated_at = stamp;
      }
      for (const snap of before) {
        const row = state.media.find((item) => item.id === snap.id);
        if (row && row.taken_at !== snap.taken_at) throw new Error(`taken_at verändert ${snap.id}`);
      }
      return { status: 200, json: {} };
    }
    if (table === "trip_members" && method === "GET") {
      return { status: 200, json: [{ role: state.role, trip_id: TRIP, user_id: USER }] };
    }
    if (table === "media" && method === "GET" && state.sortColumnMissing) {
      const select = url.searchParams.get("select") || "";
      const order = url.searchParams.get("order") || "";
      if (select.includes("sort_order") || order.includes("sort_order")) {
        state.sortMisses += 1;
        return {
          status: 400,
          json: {
            code: "PGRST204",
            message: "Could not find the 'sort_order' column of 'media' in the schema cache",
          },
        };
      }
      const result = await rest(url, method, body, headers);
      if (Array.isArray(result.json)) {
        result.json = result.json.map((row) => {
          const copy = { ...row };
          delete copy.sort_order;
          return copy;
        });
      }
      return result;
    }
    const list = table === "notes" ? state.notes : table === "media" ? state.media : table === "waypoints" ? state.waypoints : null;
    if (list && (method === "POST" || method === "PATCH")) {
      const patch = JSON.parse(body || "{}");
      if (method === "POST") {
        const id = patch.id || crypto.randomUUID();
        let row = list.find((item) => item.id === id);
        if (!row) {
          row = { id, created_by: USER, created_at: new Date().toISOString(), deleted_at: null };
          list.push(row);
        }
        Object.assign(row, patch, { id, updated_at: new Date().toISOString() });
        return { status: 201, json: row };
      }
      const rows = list.filter((row) => {
        for (const [key, value] of url.searchParams.entries()) {
          if (["select", "order", "offset", "limit", "on_conflict"].includes(key)) continue;
          if (value.startsWith("eq.") && String(row[key]) !== value.slice(3)) return false;
        }
        return true;
      });
      for (const row of rows) Object.assign(row, patch, { updated_at: new Date().toISOString() });
      return { status: 200, json: rows.length === 1 ? rows[0] : rows };
    }
    return rest(url, method, body, headers);
  };
}

async function installCounters(page) {
  await page.addInitScript(() => {
    const stats = { appHtml: 0, currentPageHtml: 0, dataChanged: 0, armed: false };
    window.__p3 = stats;
    window.__p3reset = () => {
      stats.appHtml = 0;
      stats.currentPageHtml = 0;
      stats.dataChanged = 0;
      stats.armed = true;
    };
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    Object.defineProperty(Element.prototype, "innerHTML", {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        return desc.get.call(this);
      },
      set(value) {
        if (stats.armed) {
          if (this.id === "app") stats.appHtml += 1;
          if (this.getAttribute && this.getAttribute("data-page") === "current") stats.currentPageHtml += 1;
        }
        desc.set.call(this, value);
      },
    });
    window.addEventListener("vacrecap:data-changed", () => {
      if (stats.armed) stats.dataChanged += 1;
    });
  });
}

async function login(page) {
  await page.goto("./");
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

async function openPark(page) {
  if ((await page.locator('[data-testid="trip-content"]').count()) === 0) {
    await page.locator(`[data-vacation-id="${TRIP}"]`).first().click();
    await page.waitForSelector('[data-testid="trip-content"]', { timeout: 20_000 });
  }
  await page.locator(`.day-chip[data-day="${DAYS[1]}"]`).click();
  await page.waitForSelector('[data-page="current"] [data-place-id="p-park"]');
  const selected = await page.locator('[data-page="current"] .oc--selected').getAttribute("data-place-id");
  if (selected !== "p-park") {
    await page.locator('[data-page="current"] [data-place-id="p-park"] .oc__title').click();
    await page.waitForFunction(
      () => document.querySelector("[data-page='current'] .oc--selected")?.dataset.placeId === "p-park"
    );
  }
  await page.waitForSelector('[data-page="current"] [data-testid="photo-caption-row"][data-media-id="m1"]');
  await page.evaluate(() => {
    const el = document.querySelector("[data-page='current']");
    if (el) el.scrollTop = 0;
  });
}

async function rowOrder(page) {
  return page.locator('[data-page="current"] [data-place-id="p-park"] [data-testid="photo-caption-row"]').evaluateAll((els) =>
    els.map((el) => el.dataset.mediaId)
  );
}

async function pointOf(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element ohne Maß");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

async function arm(page, state) {
  const mark = state.calls.length;
  const gen = await page.evaluate(() => {
    window.__p3reset();
    return document.getElementById("app")?.dataset.appRenderGen || "0";
  });
  return { mark, gen };
}

async function readSnap(page, state, armed) {
  await page.waitForTimeout(350);
  const dom = await page.evaluate((start) => {
    const gen = document.getElementById("app")?.dataset.appRenderGen || "0";
    return {
      appHtml: window.__p3.appHtml,
      currentPageHtml: window.__p3.currentPageHtml,
      dataChanged: window.__p3.dataChanged,
      renderGen: Number(gen) - Number(start),
    };
  }, armed.gen);
  return { ...dom, calls: state.calls.slice(armed.mark) };
}

function assertOneRefresh(snap, label) {
  assert(snap.dataChanged === 0, `${label}: data-changed ${snap.dataChanged}`);
  assert(snap.renderGen === 0, `${label}: globaler Refresh ${snap.renderGen}`);
  assert(snap.currentPageHtml === 1, `${label}: Tagesliste ${snap.currentPageHtml} mal statt 1`);
  const rpc = snap.calls.filter((item) => item.includes("set_place_media_order")).length;
  const mediaGets = snap.calls.filter((item) => item.startsWith("GET") && item.endsWith("/media")).length;
  assert(rpc === 1, `${label}: RPC ${rpc} (${snap.calls.join(" | ")})`);
  assert(mediaGets === 1, `${label}: Medien-GET ${mediaGets}`);
  report.push({ label, ...snap, rpc, mediaGets });
}

async function dragFrom(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
}

async function assertOrder(page, ids, label) {
  const expected = ids.join(",");
  try {
    await page.waitForFunction(
      (value) =>
        [...document.querySelectorAll("[data-page='current'] [data-place-id='p-park'] [data-testid='photo-caption-row']")]
          .map((el) => el.dataset.mediaId)
          .join(",") === value,
      expected,
      { timeout: 8000 }
    );
  } catch (err) {
    const order = await rowOrder(page);
    const toast = (await page.locator('[data-testid="app-toast"]').count())
      ? await page.locator('[data-testid="app-toast"]').innerText()
      : "";
    const drag = await page.locator('[data-testid="photo-row-drag"]').count();
    throw new Error(`${label}: Reihenfolge ${order.join(",")} statt ${expected}; Toast «${toast}»; Zug ${drag}; ${err.message}`);
  }
}

async function assertRecap(page, state, label) {
  await page.locator(`.day-chip[data-day="${DAYS[2]}"]`).click();
  await page.waitForSelector('[data-testid="recap-entry"]');
  const before = parkIds(state.recaps.find((row) => row.id === "recap-final").content);
  await page.locator('[data-action="open-recap-video"]').click();
  await page.waitForSelector('[data-testid="recap-storyboard"]');
  assert(parkIds(state.recaps.find((row) => row.id === "recap-final").content) === before, `${label}: bestehendes Recap geändert`);
  assert(before === state.timeIds, `${label}: finales Recap ist nicht die Aufnahmezeit (${before})`);
  await page.locator('[data-testid="recap-new-draft"]').click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="recap-kicker"]')?.textContent || "").includes("Entwurf"));
  const finalRow = state.recaps.find((row) => row.id === "recap-final");
  const draft = state.recaps.find((row) => row.status === "draft");
  const expected = parkIds(
    buildVideoRecap({
      places: materialPlaces(),
      photos: [
        ...parkPhotos({ sorted: true }),
        { id: "m-mix", placeId: "p-mix", ts: Date.parse(`${DAYS[1]}T11:20:00.000Z`), type: "photo", uploadStatus: "uploaded" },
      ],
      notes: [],
    }).content
  );
  assert(draft, `${label}: neuer Entwurf fehlt`);
  assert(parkIds(finalRow.content) === before, `${label}: Final nach dem Entwurf verändert`);
  assert(parkIds(draft.content) === expected, `${label}: neuer Entwurf ${parkIds(draft.content)} statt ${expected}`);
  assert(parkIds(draft.content) !== before, `${label}: neuer Entwurf übernimmt die alte Reihenfolge`);
  await page.locator('[data-action="back"]').click();
  await page.waitForSelector('[data-testid="trip-content"]');
  await openPark(page);
}

async function assertTapAndStill(page, label) {
  await page.locator('[data-page="current"] [data-testid="place-photo"][data-media-id="m2"]').click();
  await page.waitForSelector('[data-testid="media-viewer"]');
  await page.click('[data-testid="media-viewer-close"]');
  await page.waitForSelector('[data-testid="media-viewer"]', { state: "detached" });
  const still = await pointOf(page.locator('[data-page="current"] [data-testid="place-photo"][data-media-id="m2"]'));
  const before = (await rowOrder(page)).join(",");
  await dragFrom(page, still, { x: still.x, y: still.y + 140 });
  assert((await page.locator('[data-testid="photo-row-drag"]').count()) === 0, `${label}: nicht angehakte Zeile wird gezogen`);
  await page.mouse.up();
  assert((await rowOrder(page)).join(",") === before, `${label}: nicht angehakte Zeile verändert die Reihenfolge`);
}

async function assertScrollAndSwipe(page, state, label) {
  const order = (await rowOrder(page)).join(",");
  const mark = state.calls.length;
  const title = await pointOf(page.locator('[data-page="current"] [data-place-id="p-park"] .oc__title'));
  const before = await page.evaluate(() => {
    const el = document.querySelector("[data-page='current']");
    return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
  });
  assert(before.height > before.client + 40, `${label}: Liste scrollt nicht (${before.height}/${before.client})`);
  await page.mouse.move(title.x, title.y);
  await page.mouse.wheel(0, 320);
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => document.querySelector("[data-page='current']").scrollTop);
  assert(after > before.top + 20, `${label}: Scrolltop ${after} statt über ${before.top}`);
  assert((await rowOrder(page)).join(",") === order, `${label}: Scrollen sortiert um`);
  await page.evaluate(() => {
    document.querySelector("[data-page='current']").scrollTop = 0;
  });
  const thumb = await pointOf(page.locator('[data-page="current"] [data-testid="place-photo"][data-media-id="m1"]'));
  await page.mouse.move(thumb.x, thumb.y);
  await page.mouse.down();
  await page.mouse.move(thumb.x - 240, thumb.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(
    (day) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === day,
    DAYS[2]
  );
  assert((await page.locator('[data-testid="photo-row-drag"]').count()) === 0, `${label}: Wischen zieht eine Zeile`);
  const back = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="trip-content"]');
    const rect = root.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + Math.min(180, rect.height / 2) };
  });
  await page.mouse.move(back.x, back.y);
  await page.mouse.down();
  await page.mouse.move(back.x + 240, back.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(
    (day) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === day,
    DAYS[1]
  );
  await page.waitForSelector('[data-page="current"] [data-place-id="p-park"]');
  if ((await page.locator('[data-page="current"] .oc--selected').getAttribute("data-place-id")) !== "p-park") {
    await page.locator('[data-page="current"] [data-place-id="p-park"] .oc__title').click();
  }
  assert((await rowOrder(page)).join(",") === order, `${label}: Wischen sortiert um`);
  const during = state.calls.slice(mark);
  assert(!during.some((item) => item.includes("set_place_media_order")), `${label}: Wischen speichert eine Reihenfolge`);
}

async function assertFreshStamp(page, state, label) {
  const stamp = state.lastSortStamp;
  const seen = await page.evaluate(async ({ trip, day }) => {
    const { peekDayPlace } = await import("./js/ui-place-list.js");
    const item = peekDayPlace(trip, day, "p-park");
    return (item?.media || []).map((entry) => entry.remoteUpdatedAt);
  }, { trip: TRIP, day: DAYS[1] });
  assert(stamp && seen.length && seen.every((value) => value === stamp), `${label}: Cache-Zeit ${seen.join(",")} statt ${stamp}`);
}

async function assertTapAfterTouch(page, label) {
  await page.locator('[data-page="current"] [data-testid="photo-caption-row"][data-media-id="m1"]').scrollIntoViewIfNeeded();
  const mode = await page.evaluate(() => {
    const el = document.querySelector("[data-page='current'] [data-testid='place-photo'][data-media-id='m1']");
    if (!el || typeof TouchEvent !== "function") return "ohne Touch";
    const rect = el.getBoundingClientRect();
    const x0 = rect.left + rect.width / 2;
    const y0 = rect.top + rect.height / 2;
    let legacy = false;
    const point = (x, y) => {
      if (!legacy) {
        try {
          return new Touch({ identifier: 4, target: el, clientX: x, clientY: y, pageX: x, pageY: y });
        } catch {
          legacy = true;
        }
      }
      if (typeof document.createTouch !== "function") throw new Error("Touch fehlt");
      return document.createTouch(window, el, 4, x, y, x, y);
    };
    const asList = (touch, active) => {
      if (legacy) return active ? document.createTouchList(touch) : document.createTouchList();
      return active ? [touch] : [];
    };
    const fire = (type, x, y) => {
      const touch = point(x, y);
      const active = type !== "touchend";
      el.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: asList(touch, active),
        targetTouches: asList(touch, active),
        changedTouches: asList(touch, true),
      }));
    };
    fire("touchstart", x0, y0);
    for (let step = 1; step <= 8; step += 1) fire("touchmove", x0, y0 + step * 18);
    fire("touchend", x0, y0 + 144);
    return "touch";
  });
  assert(mode === "touch", `${label}: ${mode}`);
  await page.waitForTimeout(500);
  if (await page.locator('[data-testid="media-viewer"]').count()) {
    await page.click('[data-testid="media-viewer-close"]');
    await page.waitForSelector('[data-testid="media-viewer"]', { state: "detached" });
  }
  await page.locator('[data-page="current"] [data-testid="place-photo"][data-media-id="m6"]').click();
  await page.waitForSelector('[data-testid="media-viewer"]');
  await page.click('[data-testid="media-viewer-close"]');
  await page.waitForSelector('[data-testid="media-viewer"]', { state: "detached" });
}

async function assertDragVisual(page, label) {
  await page.locator('[data-page="current"] [data-testid="photo-row-check"][data-media-id="m1"]').click();
  await page.waitForSelector('[data-testid="photo-select-bar"]');
  const bg = await page.locator('[data-page="current"] [data-media-id="m1"].photo-row, [data-page="current"] [data-testid="photo-caption-row"][data-media-id="m1"]').evaluate((el) => {
    const style = getComputedStyle(el);
    return { bg: style.backgroundColor, radius: style.borderRadius };
  });
  assert(bg.bg !== "rgba(0, 0, 0, 0)" && bg.bg !== "transparent", `${label}: angehakte Zeile ohne Hintergrund (${bg.bg})`);
  assert(parseFloat(bg.radius) >= 10, `${label}: angehakte Zeile ohne Rundung`);
  assert((await page.locator('[data-page="current"] [data-testid="photo-row-grip"]').count()) === 1, `${label}: Griff fehlt oder sitzt an einer anderen Zeile`);
  const grip = await pointOf(page.locator('[data-page="current"] [data-testid="photo-row-grip"]'));
  const pencil = await pointOf(page.locator('[data-page="current"] [data-media-id="m1"] .photo-cap-row__pencil'));
  assert(grip.x + grip.box.width <= pencil.x + 2, `${label}: Griff sitzt nicht vor dem Stift`);
  assert((await page.locator('[data-page="current"] [data-media-id="m2"] [data-testid="photo-row-grip"]').count()) === 0, `${label}: nicht angehakte Zeile hat einen Griff`);
}

async function saveDrag(page, state, from, target, expected, label) {
  await dragFrom(page, from, { x: from.x, y: from.y + 48 });
  await page.waitForSelector('[data-testid="photo-row-drag"]');
  const card = await page.locator('[data-page="current"] [data-place-id="p-park"]').boundingBox();
  const drag = await page.locator('[data-testid="photo-row-drag"]').evaluate((el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      bg: style.backgroundColor,
      shadow: style.boxShadow,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      inner: window.innerHeight,
      rows: [...el.querySelectorAll(".photo-row")].map((row) => row.dataset.mediaId),
    };
  });
  const gap = await page.locator('[data-testid="photo-row-gap"]').evaluate((el) => getComputedStyle(el).borderTopStyle);
  assert(drag.bg === "rgb(255, 255, 255)", `${label}: gezogene Fläche ${drag.bg}`);
  assert(drag.shadow && drag.shadow !== "none", `${label}: gezogene Fläche ohne Schatten`);
  assert(drag.left < card.x - 4 && drag.right > card.x + card.width + 4, `${label}: Zug ragt nicht über die Karte`);
  assert(drag.top > -8 && drag.top < drag.inner - 8, `${label}: Block liegt außerhalb (top ${drag.top})`);
  assert(gap === "dashed", `${label}: Lücke ${gap}`);
  const count = await page.locator('[data-testid="photo-select-count"]').innerText();
  assert(await page.locator('[data-testid="photo-select-bar"]').isVisible(), `${label}: Leiste verschwindet beim Ziehen`);
  const to = typeof target === "function" ? await target() : target;
  const armed = await arm(page, state);
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await assertOrder(page, expected, label);
  const snap = await readSnap(page, state, armed);
  assertOneRefresh(snap, label);
  assert(count.includes("ausgewählt"), `${label}: Zähler fehlt`);
  return { dragRows: drag.rows, count };
}

async function runCase(browser, baseUrl, viewport, role) {
  const label = `${browser.browserType().name()} ${viewport.width} ${role}`;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    baseURL: baseUrl,
    timezoneId: "Europe/Berlin",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await installCounters(page);
  const state = createMockSupabaseState();
  state.role = role;
  seed(state);
  allowWrites(state);
  await installSupabaseMocks(page, state);
  try {
    await login(page);
    await openPark(page);
    await assertOrder(page, CUSTOM, `${label} Anfang`);
    if (role === "owner") await assertRecap(page, state, label);
    if (role === "viewer") {
      await page.locator('[data-page="current"] [data-testid="photo-row-check"][data-media-id="m1"]').click();
      await page.waitForSelector('[data-testid="photo-select-bar"]');
      const bg = await page
        .locator('[data-page="current"] [data-testid="photo-caption-row"][data-media-id="m1"]')
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      assert(bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent", `${label}: angehakte Zeile ohne Hintergrund (${bg})`);
      assert((await page.locator('[data-page="current"] [data-testid="photo-row-grip"]').count()) === 0, `${label}: Beitragender sieht einen Griff`);
      assert(
        (await page.locator('[data-page="current"] [data-testid="photo-caption-row"][data-media-id="m1"]').getAttribute("data-sortable")) === "0",
        `${label}: Beitragender darf ziehen`
      );
    } else {
      await assertDragVisual(page, label);
      assert(
        (await page.locator('[data-page="current"] [data-testid="photo-caption-row"][data-media-id="m1"]').getAttribute("data-sortable")) === "1",
        `${label}: angehakte Zeile ist nicht ziehbar`
      );
    }
    await assertTapAndStill(page, label);
    await assertScrollAndSwipe(page, state, label);
    if ((await page.locator('[data-testid="photo-select-bar"]').count()) === 0) {
      await page.locator('[data-page="current"] [data-testid="photo-row-check"][data-media-id="m1"]').click();
      await page.waitForSelector('[data-testid="photo-select-bar"]');
    }
    assert((await page.locator('[data-testid="photo-move"]').innerText()).includes("Verschieben nach"), `${label}: Verschieben fehlt`);
    if (role === "viewer") {
      const mark = state.calls.length;
      const from = await pointOf(page.locator('[data-page="current"] [data-testid="place-photo"][data-media-id="m1"]'));
      await dragFrom(page, from, { x: from.x, y: from.y + 160 });
      assert((await page.locator('[data-testid="photo-row-drag"]').count()) === 0, `${label}: Beitragender zieht`);
      await page.mouse.up();
      await assertOrder(page, CUSTOM, `${label} Beitragender`);
      assert(!state.calls.slice(mark).some((item) => item.includes("set_place_media_order")), `${label}: Beitragender speichert die Reihenfolge`);
      await page.locator('[data-testid="photo-move"]').click();
      await page.waitForSelector('[data-testid="photo-move-sheet"]');
      await page.locator('[data-move-place="p-ziel"]').click();
      await page.waitForFunction(() => (document.querySelector('[data-place-id="p-ziel"] .oc__meta')?.textContent || "").includes("1 Foto"));
      assert(state.media.find((row) => row.id === "m1").waypoint_id === "p-ziel", `${label}: Verschieben bleibt aus`);
      if ((await page.locator('[data-testid="photo-select-exit"]').count()) === 1) {
        await page.locator('[data-testid="photo-select-exit"]').click();
        await page.waitForSelector('[data-testid="photo-select-bar"]', { state: "detached" });
      }
      const cold = state.gets.length;
      await page.evaluate(
        async ({ trip, day }) => {
          const { dropDayPlaceMemory } = await import("./js/ui-place-list.js");
          dropDayPlaceMemory(trip, day);
        },
        { trip: TRIP, day: DAYS[1] }
      );
      await page.locator('[data-page="current"] [data-place-id="p-mix"] .oc__title').click();
      await page.locator('[data-page="current"] [data-place-id="p-mix"] [data-action="edit-place"]').click();
      await page.waitForSelector('[data-testid="place-edit-sheet"]');
      const opened = state.gets.slice(cold);
      assert(!opened.includes("media") && !opened.includes("notes"), `${label}: Tagsperre fragt ${opened.join(",")}`);
      await page.waitForFunction((text) => document.querySelector('[data-testid="place-day-hint"]')?.textContent === text, HINT);
      assert(await page.locator('[data-testid="edit-place-day"]').isDisabled(), `${label}: Tag ohne Cache bleibt offen`);
      await page.locator('[data-testid="place-edit-sheet"] [data-action="cancel"]').click();
    } else {
      const from = await pointOf(page.locator('[data-page="current"] [data-testid="place-photo"][data-media-id="m1"]'));
      const single = await saveDrag(
        page,
        state,
        from,
        async () => {
          const box = await page.locator('[data-page="current"] [data-testid="photo-caption-row"][data-media-id="m4"]').boundingBox();
          return { x: box.x + 24, y: box.y + 8 };
        },
        ["m2", "m3", "m1", "m4", "m5", "m6"],
        `${label} eine Zeile`
      );
      assert(single.dragRows.join(",") === "m1", `${label}: Zug zeigt ${single.dragRows.join(",")}`);
      assert(single.count.includes("1 ausgewählt"), `${label}: Leiste ${single.count}`);
      assert((await page.locator('[data-testid="photo-select-count"]').innerText()).includes("1 ausgewählt"), `${label}: Auswahl nach dem Zug weg`);
      assert(state.media.find((row) => row.id === "m1").taken_at.endsWith("T13:00:00.000Z"), `${label}: taken_at überschrieben`);
      await assertFreshStamp(page, state, `${label} eine Zeile`);
      await assertFreshStamp(page, state, `${label} eine Zeile`);
      await page.locator('[data-page="current"] [data-testid="photo-row-check"][data-media-id="m3"]').click();
      await page.waitForFunction(() => (document.querySelector('[data-testid="photo-select-count"]')?.textContent || "").includes("2 ausgewählt"));
      const blockFrom = await pointOf(page.locator('[data-page="current"] [data-testid="place-photo"][data-media-id="m3"]'));
      const block = await saveDrag(
        page,
        state,
        blockFrom,
        async () => {
          const box = await page
            .locator('[data-page="current"] [data-place-id="p-park"] .photo-row:not(.photo-row--source)')
            .first()
            .boundingBox();
          return { x: box.x + 24, y: box.y + 6 };
        },
        ["m3", "m1", "m2", "m4", "m5", "m6"],
        `${label} Block`
      );
      assert(block.dragRows.join(",") === "m3,m1", `${label}: Block ${block.dragRows.join(",")}`);
      assert(block.count.includes("2 ausgewählt"), `${label}: Block-Leiste ${block.count}`);
      assert((await page.locator('[data-testid="photo-select-count"]').innerText()).includes("2 ausgewählt"), `${label}: Auswahl nach dem Block weg`);
      const taken = Object.fromEntries(state.media.map((row) => [row.id, row.taken_at]));
      const armed = await arm(page, state);
      await page.locator('[data-testid="photo-sort-reset"]').click();
      await assertOrder(page, BY_TIME, `${label} Reset`);
      const snap = await readSnap(page, state, armed);
      assertOneRefresh(snap, `${label} Reset`);
      assert(state.media.filter((row) => row.waypoint_id === "p-park").every((row) => row.sort_order == null), `${label}: sort_order bleibt gesetzt`);
      for (const row of state.media) assert(row.taken_at === taken[row.id], `${label}: Reset ändert taken_at`);
      assert((await page.locator('[data-testid="photo-sort-reset"]').count()) === 0, `${label}: Reset bleibt stehen`);
      await assertFreshStamp(page, state, `${label} Reset`);
      await assertTapAfterTouch(page, label);
      await page.locator('[data-testid="photo-move"]').click();
      await page.waitForSelector('[data-testid="photo-move-sheet"]');
      await page.locator('[data-move-place="p-ziel"]').click();
      await page.waitForFunction(() => {
        const toast = document.querySelector('[data-testid="app-toast"]')?.textContent || "";
        return toast.includes("verschoben") && !toast.includes("Inzwischen geändert");
      });
      assert(state.media.find((row) => row.id === "m1").waypoint_id === "p-ziel", `${label}: Verschieben nach dem Sortieren`);
      // Der Zug lässt die Tagesliste kurz stehen. Das Verschieben räumt die Auswahl
      // selbst ab. Ein echter Klick trifft in WebKit dann die alte, gerade ersetzte Leiste.
      await page
        .waitForSelector('[data-testid="photo-select-bar"]', { state: "detached", timeout: 4000 })
        .catch(async () => {
          await page.locator('[data-testid="photo-select-exit"]').evaluate((btn) => btn.click());
          await page.waitForSelector('[data-testid="photo-select-bar"]', { state: "detached" });
        });
      await page.locator('[data-page="current"] [data-place-id="p-mix"] .oc__title').click();
      await page.locator('[data-page="current"] [data-place-id="p-mix"] [data-action="edit-place"]').click();
      await page.waitForSelector('[data-testid="place-edit-sheet"]');
      assert(!(await page.locator('[data-testid="edit-place-day"]').isDisabled()), `${label}: ${role} ist beim Tag gesperrt`);
      await page.locator('[data-testid="place-edit-sheet"] [data-action="cancel"]').click();
    }
    assert(errors.length === 0, `${label}: ${errors.join(" | ")}`);
  } finally {
    await context.close();
  }
}

async function runDegraded(browser, baseUrl, viewport, mode) {
  const label = `${browser.browserType().name()} ${viewport.width} ${mode}`;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    baseURL: baseUrl,
    timezoneId: "Europe/Berlin",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  const state = createMockSupabaseState();
  state.role = "owner";
  seed(state, { withFinal: false });
  if (mode === "ohne-spalte") state.sortColumnMissing = true;
  if (mode === "ohne-rpc") state.rpcMissing = true;
  allowWrites(state);
  await installSupabaseMocks(page, state);
  try {
    await login(page);
    await openPark(page);
    await assertOrder(page, mode === "ohne-spalte" ? BY_TIME : CUSTOM, label);
    if (mode === "ohne-spalte") assert(state.sortMisses >= 1, `${label}: fehlende Spalte nicht gemeldet`);
    const taken = Object.fromEntries(state.media.map((row) => [row.id, row.taken_at]));
    const ranks = Object.fromEntries(state.media.map((row) => [row.id, row.sort_order]));
    const firstId = (await rowOrder(page))[0];
    await page.evaluate(() => {
      const el = document.querySelector("[data-page='current']");
      if (el) el.scrollTop = 0;
    });
    await page.locator(`[data-page="current"] [data-testid="photo-row-check"][data-media-id="${firstId}"]`).click();
    await page.waitForSelector('[data-testid="photo-select-bar"]');
    assert(
      (await page.locator(`[data-page="current"] [data-testid="photo-caption-row"][data-media-id="${firstId}"]`).getAttribute("data-sortable")) === "1",
      `${label}: Zeile nicht ziehbar`
    );
    const from = await pointOf(page.locator(`[data-page="current"] [data-testid="place-photo"][data-media-id="${firstId}"]`));
    const mark = state.calls.length;
    await dragFrom(page, from, { x: from.x, y: from.y + 170 });
    await page.mouse.up();
    try {
      await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("noch nicht verfügbar"));
    } catch (err) {
      const toast = (await page.locator('[data-testid="app-toast"]').count())
        ? await page.locator('[data-testid="app-toast"]').innerText()
        : "";
      const order = (await rowOrder(page)).join(",");
      throw new Error(`${label}: Toast «${toast}» Reihenfolge ${order} Fehler ${errors.join(" | ")} ${err.message}`);
    }
    await assertOrder(page, mode === "ohne-spalte" ? BY_TIME : CUSTOM, `${label} nach Zug`);
    if (mode === "ohne-spalte") {
      assert(!state.calls.slice(mark).some((item) => item.includes("set_place_media_order")), `${label}: RPC trotz fehlender Spalte`);
    }
    for (const row of state.media) {
      assert(row.taken_at === taken[row.id], `${label}: taken_at geändert`);
      assert(row.sort_order === ranks[row.id], `${label}: Rang geändert`);
    }
    assert(errors.length === 0, `${label}: ${errors.join(" | ")}`);
  } finally {
    await context.close();
  }
}

async function run() {
  const { server, baseUrl } = await startServer();
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch({ headless: true });
      try {
        for (const viewport of VIEWPORTS) {
          for (const role of ["owner", "editor", "viewer"]) {
            await runCase(browser, baseUrl, viewport, role);
            console.log(`ok ${engine.name()} ${viewport.width} ${role}`);
          }
          for (const mode of ["ohne-spalte", "ohne-rpc"]) {
            await runDegraded(browser, baseUrl, viewport, mode);
            console.log(`ok ${engine.name()} ${viewport.width} ${mode}`);
          }
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.close();
  }
  console.log(JSON.stringify(report, null, 2));
  console.log("Paket 3 Fotos ziehen grün");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
