import { chromium, devices } from "playwright";
import {
  USER,
  createMockSupabaseState,
  installSupabaseMocks,
  startServer,
} from "./run-tests-12b-recap-video.mjs";

const TRIP = "trip-p4";
const DAYS = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"];
const OTHER = "22222222-2222-2222-2222-222222222222";
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const CUR = "[data-page='current']";
const REPS = 4;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function placeRow(id, title, day, time, author = USER) {
  return {
    id,
    trip_id: TRIP,
    day,
    visited_at: `${day}T${time}.000Z`,
    lat: 45.8 + Number(id.replace(/\D/g, "") || 0) * 0.01,
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

function seed(state) {
  state.trips.push({
    id: TRIP,
    title: "Perf Paket 4",
    start_date: DAYS[0],
    end_date: DAYS[DAYS.length - 1],
    created_at: `${DAYS[0]}T00:00:00.000Z`,
    updated_at: `${DAYS[0]}T00:00:00.000Z`,
    created_by: USER,
    companions: [],
    companion_tags: [],
    cover_media_id: null,
    cover_preset: "stadt",
    deleted_at: null,
  });
  for (let i = 0; i < 40; i += 1) {
    const day = DAYS[i % DAYS.length];
    const id = `wp-${String(i).padStart(2, "0")}`;
    const hh = String(8 + (i % 10)).padStart(2, "0");
    state.waypoints.push(placeRow(id, `Ort ${i + 1}`, day, `${hh}:00:00`));
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
      caption: i % 7 === 0 ? "Bildtext" : null,
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
  state.waypoints.push(placeRow("wp-fremd", "Fremder Ort", DAYS[0], "07:00:00", OTHER));
  state.notes.push({
    id: "n-fremd",
    trip_id: TRIP,
    waypoint_id: "wp-fremd",
    day: DAYS[0],
    body: "Fremde Notiz",
    deleted_at: null,
    created_at: `${DAYS[0]}T07:30:00.000Z`,
    updated_at: `${DAYS[0]}T07:30:00.000Z`,
    created_by: OTHER,
  });
  state.media.push({
    id: "m-fremd",
    trip_id: TRIP,
    waypoint_id: "wp-fremd",
    day: DAYS[0],
    taken_at: `${DAYS[0]}T07:40:00.000Z`,
    kind: "photo",
    storage_path: "orig/fremd.jpg",
    thumb_path: "fremd.jpg",
    mime: "image/jpeg",
    upload_status: "uploaded",
    caption: "Fremdes Bild",
    deleted_at: null,
    created_at: `${DAYS[0]}T07:40:00.000Z`,
    updated_at: `${DAYS[0]}T07:40:00.000Z`,
    created_by: OTHER,
  });
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
      return { status: 200, json: { role: state.role, trip_id: TRIP, user_id: USER } };
    }
    const list = listOf(state, table);
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
        return { status: 201, json: represent(row, headers) };
      }
      let rows = matchRows(list, url);
      if (!rows.length) {
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
  const box = { on: false, total: 0, gets: 0, writes: 0, trips: 0 };
  page.on("request", (req) => {
    if (!box.on) return;
    const href = req.url();
    if (!href.includes(SUPABASE_HOST)) return;
    box.total += 1;
    const url = new URL(href);
    if (req.method() === "GET") box.gets += 1;
    else box.writes += 1;
    if (req.method() === "GET" && url.pathname.endsWith("/trips")) box.trips += 1;
  });
  return {
    reset() {
      box.on = true;
      box.total = 0;
      box.gets = 0;
      box.writes = 0;
      box.trips = 0;
    },
    stop() {
      box.on = false;
    },
    snapshot() {
      return { total: box.total, gets: box.gets, writes: box.writes, trips: box.trips };
    },
  };
}

async function installCounters(page) {
  await page.addInitScript(() => {
    const stats = {
      addedElements: 0,
      appHtml: 0,
      currentPageHtml: 0,
      dataChanged: 0,
      armed: false,
    };
    window.__p4 = stats;
    window.__p4reset = () => {
      stats.addedElements = 0;
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
    new MutationObserver((records) => {
      if (!stats.armed) return;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) stats.addedElements += 1 + node.querySelectorAll("*").length;
        }
      }
    }).observe(document, { childList: true, subtree: true });
    window.addEventListener("vacrecap:data-changed", () => {
      if (stats.armed) stats.dataChanged += 1;
    });
  });
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

async function openTrip(page) {
  await page.locator(`[data-vacation-id="${TRIP}"]`).first().click();
  await page.waitForSelector(`${CUR} .oc--selected`, { timeout: 20_000 });
  await page.waitForTimeout(500);
}

async function arm(page) {
  return page.evaluate(() => {
    window.__p4reset();
    return document.getElementById("app")?.dataset.appRenderGen || "0";
  });
}

async function readSnap(page, beforeGen, meter) {
  const dom = await page.evaluate((start) => {
    const gen = document.getElementById("app")?.dataset.appRenderGen || "0";
    return {
      addedElements: window.__p4.addedElements,
      appHtml: window.__p4.appHtml,
      currentPageHtml: window.__p4.currentPageHtml,
      dataChanged: window.__p4.dataChanged,
      renderGen: Number(gen) - Number(start),
    };
  }, beforeGen);
  return { ...dom, api: meter.snapshot() };
}

async function settle(page, needle) {
  await page.waitForFunction(
    (text) => document.querySelector("[data-page='current']")?.textContent?.includes(text),
    needle,
    { timeout: 15_000 }
  );
  await page.waitForTimeout(350);
}

function assertLocalSave(snap, label) {
  assert(snap.dataChanged === 0, `${label}: data-changed ${snap.dataChanged}, erwartet 0`);
  assert(snap.renderGen === 0, `${label}: globaler Refresh ${snap.renderGen}, erwartet 0`);
  assert(snap.appHtml === 0, `${label}: App-Gerüst ${snap.appHtml} mal neu`);
  assert(snap.currentPageHtml === 1, `${label}: Tagesliste ${snap.currentPageHtml} mal neu statt 1`);
  assert(snap.api.total <= 12, `${label}: ${snap.api.total} API-Aufrufe, auf main etwa 8`);
  assert(snap.addedElements < 400, `${label}: ${snap.addedElements} DOM-Elemente, lokaler Anstrich bleibt unter 400`);
}

function assertCaptionRefresh(snap, label) {
  assert(snap.dataChanged === 1, `${label}: data-changed ${snap.dataChanged} statt 1`);
  assert(snap.renderGen === 1, `${label}: View-Refresh ${snap.renderGen} statt 1`);
  assert(snap.currentPageHtml === 1, `${label}: Tagesliste ${snap.currentPageHtml} mal neu statt 1`);
  assert(snap.api.trips <= 2, `${label}: Reisen ${snap.api.trips} mal geladen`);
  assert(snap.api.total <= 24, `${label}: ${snap.api.total} API-Aufrufe`);
}

async function saveNote(page, meter, label) {
  const beforeScroll = await page.evaluate(() => {
    const el = document.querySelector("[data-page='current']");
    el.scrollTop = 220;
    return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
  });
  await page.locator(`${CUR} .oc--selected [data-action="edit-note"]`).first().click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.locator('[data-testid="note-sheet"] textarea').fill(label);
  meter.reset();
  const gen = await arm(page);
  await page.locator('[data-testid="note-sheet"] [data-action="save"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]', { state: "detached" });
  await settle(page, label);
  meter.stop();
  const snap = await readSnap(page, gen, meter);
  const afterScroll = await page.evaluate(() => document.querySelector("[data-page='current']")?.scrollTop || 0);
  return { snap, beforeScroll, afterScroll };
}

async function savePlace(page, meter, label) {
  await page.locator(`${CUR} .oc--selected [data-action="edit-place"]`).click();
  await page.waitForSelector(".sheet--place-edit");
  await page.locator('.sheet--place-edit [data-role="name"]').fill(label);
  meter.reset();
  const gen = await arm(page);
  await page.locator('.sheet--place-edit [data-action="save"]').click();
  await page.waitForSelector(".sheet--place-edit", { state: "detached" });
  await settle(page, label);
  meter.stop();
  return readSnap(page, gen, meter);
}

async function saveCaption(page, meter, label) {
  await page.locator(`${CUR} .oc--selected [data-testid="photo-caption-edit"]`).first().click();
  await page.waitForSelector('[data-testid="photo-caption-sheet"]');
  await page.locator('[data-testid="photo-caption-text"]').fill(label);
  meter.reset();
  const gen = await arm(page);
  await page.locator('[data-testid="photo-caption-save"]').click();
  await page.waitForSelector('[data-testid="photo-caption-sheet"]', { state: "detached" });
  await settle(page, label);
  meter.stop();
  return readSnap(page, gen, meter);
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
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="trip-content"]');
    if (root) root.dataset.suppressClick = "0";
  });
}

async function run() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices["iPhone 8"], baseURL: baseUrl });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await installCounters(page);
  await installSwipe(page);
  const state = createMockSupabaseState();
  seed(state);
  allowWrites(state);
  await installSupabaseMocks(page, state);
  const meter = createMeter(page);
  const report = { note: [], place: [], caption: [] };

  try {
    await login(page, baseUrl);
    await openTrip(page);

    const foreign = await page.evaluate(async () => {
      const { putPlace, putNote } = await import("./js/db.js");
      const { createPlace } = await import("./js/places.js");
      const { createId } = await import("./js/utils.js");
      const tripId = document.querySelector(".screen--trip").dataset.vacationId;
      const day = document.querySelector('[data-testid="trip-content"]').dataset.activeDay;
      const placeId = document.querySelector("[data-page='current'] .oc--selected").dataset.placeId;
      await putNote({
        id: createId(),
        vacationId: tripId,
        placeId,
        day,
        text: "Notiz aus der Ferne",
        ts: Date.now(),
      });
      const created = await putPlace(
        createPlace({
          vacationId: tripId,
          day,
          ts: Date.now(),
          lat: 46.1,
          lng: 10.7,
          name: "Ort aus der Ferne",
        })
      );
      await putNote({
        id: createId(),
        vacationId: tripId,
        placeId: created.id,
        day,
        text: "Notiz am fernen Ort",
        ts: Date.now(),
      });
      window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
      return { day, placeId };
    });
    await page.waitForFunction(() => {
      const text = document.querySelector("[data-page='current']")?.innerText || "";
      return text.includes("Notiz aus der Ferne") && text.includes("Ort aus der Ferne") && text.includes("Notiz am fernen Ort");
    });
    assert(foreign.day, "Tag für die fremde Änderung fehlt");

    let lastNote = "";
    for (let i = 1; i <= REPS; i += 1) {
      lastNote = `Notiz gespeichert ${i}`;
      const note = await saveNote(page, meter, lastNote);
      assertLocalSave(note.snap, `Notiz ${i}`);
      assert(note.beforeScroll.height > note.beforeScroll.client + 40, `Tagesliste ist nicht scrollbar (${note.beforeScroll.height}/${note.beforeScroll.client})`);
      assert(Math.abs(note.afterScroll - note.beforeScroll.top) <= 2, `Notiz ${i}: Scroll ${note.afterScroll} statt ${note.beforeScroll.top}`);
      await page.locator(`${CUR} .oc--selected [data-action="edit-note"]`).first().click();
      await page.waitForSelector('[data-testid="note-sheet"]');
      const again = await page.locator('[data-testid="note-sheet"] textarea').inputValue();
      assert(again === lastNote, `Notiz ${i} im erneuten Sheet «${again}»`);
      await page.locator('[data-testid="note-sheet"] [data-action="cancel"]').click();
      await page.waitForSelector('[data-testid="note-sheet"]', { state: "detached" });
      report.note.push(note.snap);

      const placeLabel = `Ort gespeichert ${i}`;
      const place = await savePlace(page, meter, placeLabel);
      assertLocalSave(place, `Ort ${i}`);
      await page.locator(`${CUR} .oc--selected [data-action="edit-place"]`).click();
      await page.waitForSelector(".sheet--place-edit");
      const placeAgain = await page.locator('.sheet--place-edit [data-role="name"]').inputValue();
      assert(placeAgain === placeLabel, `Ort ${i} im erneuten Sheet «${placeAgain}»`);
      await page.locator('.sheet--place-edit [data-action="cancel"]').click();
      await page.waitForSelector(".sheet--place-edit", { state: "detached" });
      report.place.push(place);

      const captionLabel = `Bildtext ${i}`;
      const caption = await saveCaption(page, meter, captionLabel);
      assertCaptionRefresh(caption, `Fotobeschriftung ${i}`);
      await page.locator(`${CUR} .oc--selected [data-testid="photo-caption-edit"]`).first().click();
      await page.waitForSelector('[data-testid="photo-caption-sheet"]');
      const captionAgain = await page.locator('[data-testid="photo-caption-text"]').inputValue();
      assert(captionAgain === captionLabel, `Fotobeschriftung ${i} im erneuten Sheet «${captionAgain}»`);
      await page.locator('[data-testid="photo-caption-cancel"]').click();
      await page.waitForSelector('[data-testid="photo-caption-sheet"]', { state: "detached" });
      report.caption.push(caption);
    }

    const chipBefore = await page.evaluate(() => {
      const chips = document.querySelector("[data-role='chips']");
      chips.scrollLeft = Math.min(120, chips.scrollWidth);
      return chips.scrollLeft;
    });
    assert(chipBefore > 20, `Tagleiste scrollt nicht (${chipBefore})`);
    const chipNote = "Notiz nach Chip-Scroll";
    const chipSave = await saveNote(page, meter, chipNote);
    assertLocalSave(chipSave.snap, "Notiz mit Tagleisten-Scroll");
    await page.waitForTimeout(80);
    const chipAfter = await page.evaluate(() => document.querySelector("[data-role='chips']")?.scrollLeft || 0);
    assert(Math.abs(chipAfter - chipBefore) <= 2, `Tagleiste ${chipAfter} statt ${chipBefore}`);

    for (let i = 1; i <= 3; i += 1) {
      await swipeTo(page, DAYS[1], -180);
      await swipeTo(page, DAYS[0], 180);
      const back = await page.locator(`${CUR} .oc--selected`).innerText();
      assert(back.includes(chipNote), `Wischen ${i}: gespeicherte Notiz fehlt`);
      assert(back.includes("Ort gespeichert 4"), `Wischen ${i}: gespeicherter Ort fehlt`);
      assert(back.includes("Bildtext 4"), `Wischen ${i}: Fotobeschriftung fehlt`);
    }

    const sources = await page.locator(`${CUR} .oc[data-place-id]`).evaluateAll((nodes) =>
      nodes
        .map((node) => node.dataset.placeId)
        .filter((id) => id && id.startsWith("wp-") && id !== "wp-fremd")
        .slice(0, 3)
    );
    assert(sources.length === 3, `Zu wenige Fotos zum Verschieben (${sources.length})`);
    const moved = [];
    for (const sourceId of sources) {
      await page.locator(`${CUR} .oc[data-place-id="${sourceId}"]`).click();
      await page.waitForFunction(
        (id) => document.querySelector("[data-page='current'] .oc--selected")?.dataset.placeId === id,
        sourceId
      );
      await page.locator(`${CUR} .oc--selected [data-testid="photo-select-start"]`).click();
      await page.locator(`${CUR} .oc--selected [data-testid="place-photo"]`).first().click();
      await page.locator('[data-testid="photo-move"]').click();
      await page.waitForSelector('[data-testid="photo-move-sheet"]');
      await page.locator('[data-testid="photo-move-day"]').nth(1).click();
      const target = page.locator('[data-testid="photo-move-place"]:not([disabled])').first();
      const targetId = await target.getAttribute("data-move-place");
      await target.click();
      await page.waitForFunction(
        (id) => !document.querySelector(`[data-page='current'] .oc[data-place-id="${id}"] [data-testid="place-photo"]`),
        sourceId
      );
      moved.push(targetId);
    }
    await swipeTo(page, DAYS[1], -180);
    const arrived = await page.locator(`${CUR} [data-place-id="${moved[0]}"] [data-testid="place-photo"]`).count();
    assert(arrived >= 1 + moved.filter((id) => id === moved[0]).length, `Verschobene Fotos fehlen am Ziel (${arrived})`);
    await swipeTo(page, DAYS[0], 180);
    for (const sourceId of sources) {
      const left = await page.locator(`${CUR} .oc[data-place-id="${sourceId}"] [data-testid="place-photo"]`).count();
      assert(left === 0, `Foto von ${sourceId} liegt nach dem Zurückwischen noch am Ursprung`);
    }

    await page.locator(`${CUR} .oc--selected [data-action="add-note"]`).click();
    await page.waitForSelector('[data-testid="note-sheet"]');
    await page.locator('[data-testid="note-sheet"] textarea').fill("Zusatz fuer die Liste");
    await page.locator('[data-testid="note-sheet"] [data-action="save"]').click();
    await settle(page, "Zusatz fuer die Liste");
    const renamed = await page.locator(`${CUR} .oc--selected .oc__title`).innerText();
    await page.locator('.trip-header [data-action="back"]').click();
    if ((await page.locator(".screen--urlaube").count()) === 0) {
      await page.locator('.trip-header [data-action="back"]').click();
    }
    await page.waitForSelector(".screen--urlaube", { timeout: 15_000 });
    const card = await page.locator(`[data-vacation-id="${TRIP}"]`).innerText();
    assert(card.includes("44 Notizen"), `Reiseliste zeigt den neuen Stand nicht («${card.replace(/\s+/g, " ")}»)`);

    await openTrip(page);
    await page.locator('[data-action="map"]').click();
    await page.waitForSelector('[data-testid="map-screen"]');
    await page.waitForTimeout(400);
    const popup = await page.evaluate((name) => {
      const map = window.__vacrecapMap;
      let html = "";
      map.eachLayer((layer) => {
        const content = layer.getPopup?.()?.getContent?.() || "";
        if (typeof content === "string" && content.includes(name)) html = content;
      });
      return html;
    }, renamed.trim());
    assert(popup.includes(renamed.trim()), `Karte zeigt «${renamed.trim()}» nicht`);
    assert(popup.includes("2 Notizen"), `Karte zeigt den neuen Notizstand nicht («${popup.replace(/<[^>]+>/g, " ")}»)`);
    await page.locator('.map-header [data-action="back"]').click();
    await page.waitForSelector(`${CUR} .oc--selected`);

    await page.locator('[data-action="settings"]').click();
    await page.waitForSelector('[data-testid="settings-edit-trip"]');
    await page.locator('[data-testid="settings-edit-trip"]').click();
    await page.waitForSelector('[data-testid="share-section"]');
    const shareLabel = await page.locator('[data-testid="share-section"] .field__label').first().innerText();
    assert(shareLabel.includes("Freigeben"), `Freigabe-Feld fehlt («${shareLabel}»)`);
    await page.fill('[data-testid="share-email-input"]', "ada@example.com");
    await page.locator('[data-testid="share-email-input"]').press("Enter");
    await page.waitForSelector('[data-testid="share-chip"]');
    const chip = await page.locator('[data-testid="share-chip"]').innerText();
    assert(chip.includes("ada@example.com"), `Freigabe-Chip «${chip}»`);
    assert(
      (await page.locator('[data-testid="share-section"]').innerText()).includes("Beitragender"),
      "Rolle Beitragender fehlt in der Freigabe"
    );
    await page.locator('[data-action="cancel"]').click();
    await page.waitForSelector('[data-testid="settings-edit-trip"]');

    state.role = "viewer";
    await login(page, baseUrl);
    await openTrip(page);
    const banner = await page.locator('[data-testid="role-banner"]').innerText();
    assert(banner.includes("Beitragender"), `Hinweis fehlt («${banner}»)`);
    assert(
      (await page.locator(`${CUR} .oc[data-place-id="wp-fremd"] [data-action="edit-place"]`).count()) === 0,
      "Beitragender bearbeitet einen fremden Ort"
    );
    assert(
      (await page.locator(`${CUR} .oc[data-place-id="wp-fremd"] [data-action="edit-note"]`).count()) === 0,
      "Beitragender bearbeitet eine fremde Notiz"
    );
    for (let i = 1; i <= 3; i += 1) {
      const label = `Eigene Notiz ${i}`;
      const snap = await saveNote(page, meter, label);
      assertLocalSave(snap.snap, `Beitragender Notiz ${i}`);
      assert(
        (await page.locator(`${CUR} .oc[data-place-id="wp-fremd"] [data-action="edit-note"]`).count()) === 0,
        `Beitragender ${i}: fremde Notiz wurde bearbeitbar`
      );
      assert((await page.locator('[data-testid="role-banner"]').innerText()).includes("Beitragender"), `Hinweis nach Speichern ${i} weg`);
    }

    assert(errors.length === 0, `Seitenfehler: ${errors.join(" | ")}`);
    console.log(JSON.stringify(report, null, 2));
    console.log("Perf P4 ein Refresh grün");
  } finally {
    await ctx.close();
    await browser.close();
    server.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
