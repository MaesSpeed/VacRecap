import { chromium, webkit } from "playwright";
import {
  USER,
  createMockSupabaseState,
  installSupabaseMocks,
  startServer,
} from "./run-tests-12b-recap-video.mjs";

const TRIP = "trip-paket1";
const OTHER = "22222222-2222-2222-2222-222222222222";
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const DAYS = ["2026-10-26", "2026-10-27", "2026-10-28"];
const PLACE = "p-sigurta";
const FOREIGN = "p-hafen";
const VIEWPORTS = [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function localHm(iso) {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function atLocalTime(day, hm, seconds = 0) {
  const [h, m] = hm.split(":").map(Number);
  const date = new Date(`${day}T00:00:00`);
  date.setHours(h, m, seconds, 0);
  return date.toISOString();
}

function sameClockIso(day, sourceIso) {
  const src = new Date(sourceIso);
  const date = new Date(`${day}T00:00:00`);
  date.setHours(src.getHours(), src.getMinutes(), src.getSeconds(), src.getMilliseconds());
  return date.toISOString();
}

const OPENED_AT = "2026-10-27T13:08:17.000Z";

function placeRow(id, title, day, time, author = USER) {
  const iso = `${day}T${time}.000Z`;
  return {
    id,
    trip_id: TRIP,
    day,
    visited_at: iso,
    lat: 45.63,
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

function photoRow(id, placeId, day, author = USER) {
  const iso = `${day}T13:10:00.000Z`;
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
    caption: null,
    deleted_at: null,
    created_at: iso,
    updated_at: iso,
    created_by: author,
  };
}

function noteRow(id, placeId, day, body, author = USER) {
  const iso = `${day}T13:20:00.000Z`;
  return {
    id,
    trip_id: TRIP,
    waypoint_id: placeId,
    day,
    body,
    deleted_at: null,
    created_at: iso,
    updated_at: iso,
    created_by: author,
  };
}

function seed(state) {
  state.trips.length = 0;
  state.waypoints.length = 0;
  state.notes.length = 0;
  state.media.length = 0;
  state.failNextMediaDay = false;
  state.trips.push({
    id: TRIP,
    title: "Paket 1",
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
    placeRow(PLACE, "Sigurta Park", DAYS[1], "13:08:17"),
    placeRow(FOREIGN, "Hafen", DAYS[1], "09:00:00", OTHER),
    placeRow("p-sofort", "Sofort Ort", DAYS[1], "11:22:33"),
    placeRow("p-mix", "Gemischter Ort", DAYS[1], "10:00:00"),
    placeRow("p-roll", "Rollback Ort", DAYS[1], "08:15:00")
  );
  state.media.push(
    photoRow("m-park-1", PLACE, DAYS[1]),
    photoRow("m-park-2", PLACE, DAYS[1]),
    photoRow("m-sofort", "p-sofort", DAYS[1]),
    photoRow("m-mix-own", "p-mix", DAYS[1]),
    photoRow("m-mix-other", "p-mix", DAYS[1], OTHER),
    photoRow("m-roll-1", "p-roll", DAYS[1]),
    photoRow("m-roll-2", "p-roll", DAYS[1])
  );
  state.notes.push(
    noteRow("n-park", PLACE, DAYS[1], "Parkweg"),
    noteRow("n-sofort", "p-sofort", DAYS[1], "Sofortnotiz"),
    noteRow("n-roll", "p-roll", DAYS[1], "Rollnotiz")
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
      return { status: 200, json: [{ role: state.role, trip_id: TRIP, user_id: USER }] };
    }
    const list = listOf(state, table);
    if (list && (method === "POST" || method === "PATCH")) {
      const patch = JSON.parse(body || "{}");
      if (table === "media" && method === "PATCH" && state.failNextMediaDay && Object.prototype.hasOwnProperty.call(patch, "day")) {
        state.failNextMediaDay = false;
        return { status: 403, json: { message: "Dafür fehlt die Berechtigung.", code: "42501" } };
      }
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
      const rows = matchRows(list, url);
      if (!rows.length) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
      const now = new Date().toISOString();
      for (const row of rows) Object.assign(row, patch, { updated_at: now });
      return { status: 200, json: represent(rows.length === 1 ? rows[0] : rows, headers) };
    }
    return rest(url, method, body, headers);
  };
}

function installCounters(page) {
  return page.addInitScript(() => {
    const stats = { dataChanged: 0, currentPageHtml: 0, appHtml: 0, armed: false };
    window.__p1 = stats;
    window.__p1reset = () => {
      stats.dataChanged = 0;
      stats.currentPageHtml = 0;
      stats.appHtml = 0;
      stats.armed = true;
    };
    window.__p1stop = () => {
      stats.armed = false;
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

function createMeter(page) {
  const box = { on: false, total: 0, gets: 0, writes: 0, byTable: {} };
  page.on("request", (req) => {
    if (!box.on) return;
    const href = req.url();
    if (!href.includes(SUPABASE_HOST)) return;
    box.total += 1;
    const url = new URL(href);
    const table = url.pathname.split("/").filter(Boolean).pop() || "";
    const key = `${req.method()} ${table}`;
    box.byTable[key] = (box.byTable[key] || 0) + 1;
    if (req.method() === "GET") box.gets += 1;
    else box.writes += 1;
  });
  return {
    reset() {
      box.on = true;
      box.total = 0;
      box.gets = 0;
      box.writes = 0;
      box.byTable = {};
    },
    stop() {
      box.on = false;
    },
    snapshot() {
      return { total: box.total, gets: box.gets, writes: box.writes, byTable: { ...box.byTable } };
    },
  };
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

async function openTripDay(page) {
  await page.locator(`[data-vacation-id="${TRIP}"]`).first().click();
  await page.waitForSelector('[data-testid="trip-content"]', { timeout: 20_000 });
  await page.locator(`.day-chip[data-day="${DAYS[1]}"]`).click();
  await page.waitForSelector(`[data-page="current"] [data-place-id="${PLACE}"]`, { timeout: 15_000 });
}

async function selectPlace(page, id) {
  const card = page.locator(`[data-page="current"] [data-place-id="${id}"]`);
  await card.click();
  await page.waitForFunction(
    (placeId) => document.querySelector("[data-page='current'] .oc--selected")?.dataset.placeId === placeId,
    id
  );
  return card;
}

async function openEdit(page, id) {
  await selectPlace(page, id);
  await page.locator(`[data-page="current"] [data-place-id="${id}"] [data-action="edit-place"]`).click();
  await page.waitForSelector('[data-testid="place-edit-sheet"]');
}

function writesOf(snap, table) {
  return (snap.byTable[`PATCH ${table}`] || 0) + (snap.byTable[`POST ${table}`] || 0);
}

async function readSnap(page, beforeGen, meter) {
  const dom = await page.evaluate((start) => {
    const gen = document.getElementById("app")?.dataset.appRenderGen || "0";
    return {
      dataChanged: window.__p1.dataChanged,
      currentPageHtml: window.__p1.currentPageHtml,
      appHtml: window.__p1.appHtml,
      renderGen: Number(gen) - Number(start),
    };
  }, beforeGen);
  return { ...dom, api: meter.snapshot() };
}

async function arm(page, meter) {
  meter.reset();
  return page.evaluate(() => {
    window.__p1reset();
    return document.getElementById("app")?.dataset.appRenderGen || "0";
  });
}

async function mockKeyboard(page) {
  await page.evaluate(() => {
    const mockHeight = window.innerHeight - 291;
    const vv = window.visualViewport;
    Object.defineProperty(vv, "height", { configurable: true, get: () => mockHeight });
    Object.defineProperty(vv, "offsetTop", { configurable: true, get: () => 0 });
    vv.dispatchEvent(new Event("resize"));
  });
}

async function captionMetrics(page) {
  return page.locator('[data-testid="photo-caption-text"]').evaluate((el) => {
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight);
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const lines = (el.clientHeight - pad) / lineHeight;
    const save = document.querySelector('[data-testid="photo-caption-save"]');
    const saveBox = save.getBoundingClientRect();
    const kb = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--kb"), 10) || 0;
    return {
      lines,
      lineHeight,
      clientHeight: el.clientHeight,
      scrollGap: el.scrollHeight - el.clientHeight,
      saveTop: saveBox.top,
      saveBottom: saveBox.bottom,
      kb,
      kbTop: window.innerHeight - kb,
      sheetKb: Boolean(document.querySelector('[data-testid="photo-caption-sheet"]')?.classList.contains("sheet--note-kb")),
    };
  });
}

async function runCase(browser, baseUrl, viewport, role) {
  const label = `${browser.browserType().name()} ${viewport.width} ${role}`;
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, baseURL: baseUrl });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await installCounters(page);
  const state = createMockSupabaseState();
  seed(state);
  state.role = role;
  allowWrites(state);
  await installSupabaseMocks(page, state);
  const meter = createMeter(page);
  const counts = {};

  try {
    await login(page);
    await openTripDay(page);

    const cardText = await page.locator(`[data-page="current"] [data-place-id="${PLACE}"]`).innerText();
    assert(cardText.includes("Parkweg"), `${label}: bestehende Notiz fehlt auf der Karte`);
    assert(cardText.includes("Sigurta Park"), `${label}: Ortsname fehlt`);
    assert(
      (await page.locator('[data-page="current"] .oc [data-action="add-note"]').count()) === 0,
      `${label}: + Notiz liegt noch auf der Karte`
    );
    assert((await page.locator('[data-footer-action="note"]').count()) === 1, `${label}: Footer-Notiz fehlt`);

    await selectPlace(page, FOREIGN);
    const foreignEdit = await page.locator(`[data-page="current"] [data-place-id="${FOREIGN}"] [data-action="edit-place"]`).count();
    if (role === "viewer") assert(foreignEdit === 0, `${label}: Beitragender bearbeitet fremde Orte`);
    else assert(foreignEdit === 1, `${label}: ${role} bearbeitet fremde Orte nicht`);

    await selectPlace(page, PLACE);
    assert(
      (await page.locator(`[data-page="current"] [data-place-id="${PLACE}"] [data-action="edit-place"]`).count()) === 1,
      `${label}: eigener Ort ist nicht bearbeitbar`
    );

    await page.locator('[data-footer-action="note"]').click();
    await page.waitForSelector('[data-testid="note-sheet"]');
    await page.locator('[data-testid="note-sheet"] [data-action="cancel"]').click();
    await page.waitForSelector('[data-testid="note-sheet"]', { state: "detached" });

    await openEdit(page, PLACE);
    await page.locator('[data-testid="place-note-row"]').click();
    await page.waitForSelector('[data-testid="note-sheet"]');
    assert(
      (await page.locator('[data-testid="note-sheet"]').innerText()).includes("Sigurta Park"),
      `${label}: Notiz zum Ort öffnet nicht den Ort`
    );
    await page.locator('[data-testid="note-sheet"] [data-action="cancel"]').click();
    await page.waitForSelector('[data-testid="note-sheet"]', { state: "detached" });

    await openEdit(page, PLACE);
    const save = page.locator('[data-testid="place-edit-sheet"] [data-action="save"]');
    assert(await save.isDisabled(), `${label}: Speichern ohne Änderung aktiv`);
    assert((await page.locator('[data-testid="edit-place-time"]').inputValue()) === localHm(OPENED_AT), `${label}: Uhrzeit fehlt`);
    await page.waitForFunction(() => (document.querySelector('[data-testid="edit-place-day"]')?.innerText || "").includes("Di 27.10. · 2. Tag"));
    assert((await page.locator('[data-testid="place-day-wheel"]').count()) === 1, `${label}: Rad fehlt`);
    assert(await page.locator('[data-testid="place-day-wheel"]').isHidden(), `${label}: Rad ist schon offen`);

    const buttons = await page.evaluate(() => {
      const sheet = document.querySelector('[data-testid="place-edit-sheet"]');
      const saveBox = sheet.querySelector('[data-action="save"]').getBoundingClientRect();
      const cancelBox = sheet.querySelector('[data-action="cancel"]').getBoundingClientRect();
      const deleteBox = sheet.querySelector('[data-action="delete"]').getBoundingClientRect();
      const sheetBox = sheet.getBoundingClientRect();
      const cancelCs = getComputedStyle(sheet.querySelector('[data-action="cancel"]'));
      const deleteCs = getComputedStyle(sheet.querySelector('[data-action="delete"]'));
      return {
        saveWidth: saveBox.width,
        rowWidth: deleteBox.right - cancelBox.left,
        cancelWidth: cancelBox.width,
        deleteWidth: deleteBox.width,
        cancelHeight: cancelBox.height,
        deleteHeight: deleteBox.height,
        saveTop: saveBox.top,
        rowTop: cancelBox.top,
        sheetWidth: sheetBox.width,
        cancelBg: cancelCs.backgroundColor,
        cancelColor: cancelCs.color,
        cancelBorder: cancelCs.borderTopWidth,
        deleteBg: deleteCs.backgroundColor,
        deleteColor: deleteCs.color,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    assert(buttons.overflow <= 2, `${label}: Überlauf ${buttons.overflow}`);
    assert(Math.abs(buttons.cancelWidth - buttons.deleteWidth) <= 2, `${label}: ungleiche Breite ${buttons.cancelWidth}/${buttons.deleteWidth}`);
    assert(Math.abs(buttons.cancelHeight - buttons.deleteHeight) <= 2, `${label}: ungleiche Höhe`);
    assert(buttons.cancelHeight >= 44, `${label}: Buttonhöhe ${buttons.cancelHeight}`);
    assert(buttons.saveWidth >= buttons.rowWidth - 2, `${label}: Speichern nicht volle Breite`);
    assert(buttons.saveTop + 8 < buttons.rowTop, `${label}: Speichern steht nicht über der Zeile`);
    assert(buttons.cancelBorder !== "0px", `${label}: Abbrechen ohne Rahmen`);
    assert(buttons.deleteColor === "rgb(255, 255, 255)", `${label}: Löschen nicht weiß (${buttons.deleteColor})`);
    assert(buttons.deleteBg !== buttons.cancelBg, `${label}: Löschen nicht gefüllt`);

    await page.locator('[data-testid="edit-place-day"]').click();
    await page.waitForSelector('[data-testid="place-day-wheel"]:not([hidden])');
    const wheel = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="place-day-wheel"]');
      const box = root.getBoundingClientRect();
      const items = [...root.querySelectorAll("[data-day]")].map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          day: el.dataset.day,
          top: r.top,
          bottom: r.bottom,
          weight: cs.fontWeight,
          color: cs.color,
          text: el.textContent,
        };
      });
      const visible = items.filter((item) => item.bottom > box.top + 2 && item.top < box.bottom - 2);
      const dayBtn = document.querySelector('[data-testid="edit-place-day"]');
      const note = document.querySelector('[data-testid="place-note-row"]').getBoundingClientRect();
      return {
        expanded: dayBtn.getAttribute("aria-expanded"),
        openClass: dayBtn.classList.contains("place-edit-day--open"),
        chevron: getComputedStyle(dayBtn.querySelector(".place-edit-day__chevron")).transform,
        visible,
        wheelBottom: box.bottom,
        noteTop: note.top,
        pill: getComputedStyle(root.querySelector(".place-day-wheel__pill")).backgroundColor,
      };
    });
    assert(wheel.expanded === "true" && wheel.openClass, `${label}: Tag-Feld nicht fokussiert`);
    assert(wheel.chevron && wheel.chevron !== "none", `${label}: Chevron dreht nicht`);
    assert(wheel.visible.length === 3, `${label}: Rad zeigt ${wheel.visible.length} Zeilen`);
    assert(wheel.noteTop >= wheel.wheelBottom - 1, `${label}: Rad schiebt Notiz zum Ort nicht nach unten`);
    const [above, mid, below] = wheel.visible.sort((a, b) => a.top - b.top);
    assert(above.text.includes("Mo 26.10. · 1. Tag"), `${label}: obere Zeile ${above.text}`);
    assert(mid.text.includes("Di 27.10. · 2. Tag"), `${label}: Mitte ${mid.text}`);
    assert(below.text.includes("Mi 28.10. · 3. Tag"), `${label}: untere Zeile ${below.text}`);
    assert(Number(mid.weight) >= 700, `${label}: Mitte nicht fett (${mid.weight})`);
    assert(Number(above.weight) < Number(mid.weight), `${label}: Nachbar nicht zurückgenommen`);
    assert(above.color !== mid.color, `${label}: Nachbar nicht grau`);
    assert(wheel.pill === "rgb(255, 255, 255)", `${label}: Pille ${wheel.pill}`);

    await page.locator('[data-testid="place-edit-sheet"] [data-action="delete"]').click();
    await page.waitForSelector('[data-testid="confirm-delete-place"]');
    const confirm = await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="confirm-delete-place"]');
      const box = dialog.getBoundingClientRect();
      const title = dialog.querySelector("h2");
      const titleCs = getComputedStyle(title);
      const cancel = dialog.querySelector('[data-action="cancel"]').getBoundingClientRect();
      const go = dialog.querySelector('[data-action="confirm"]');
      const goBox = go.getBoundingClientRect();
      const goCs = getComputedStyle(go);
      const layer = document.querySelector(".overlay-confirm-layer--center");
      return {
        title: title.textContent,
        message: dialog.querySelector("p").textContent,
        titleWeight: titleCs.fontWeight,
        titleColor: titleCs.color,
        centered: Boolean(layer),
        mid: box.top + box.height / 2,
        view: window.innerHeight / 2,
        cancelWidth: cancel.width,
        goWidth: goBox.width,
        cancelHeight: cancel.height,
        goHeight: goBox.height,
        goBg: goCs.backgroundColor,
        goColor: goCs.color,
      };
    });
    assert(confirm.title === "Ort löschen?", `${label}: Titel ${confirm.title}`);
    assert(Number(confirm.titleWeight) >= 700, `${label}: Titel nicht fett`);
    assert(confirm.titleColor === "rgb(0, 102, 179)", `${label}: Titelfarbe ${confirm.titleColor}`);
    assert(confirm.message.includes("Willst du «Sigurta Park» wirklich löschen?"), `${label}: Text ${confirm.message}`);
    assert(confirm.message.includes("Enthält 2 Fotos"), `${label}: Fotos ${confirm.message}`);
    assert(confirm.message.includes("1 Notiz"), `${label}: Notiz ${confirm.message}`);
    assert(confirm.centered, `${label}: Dialog nicht zentriert`);
    assert(Math.abs(confirm.mid - confirm.view) < confirm.view * 0.35, `${label}: Dialog nicht in der Mitte`);
    assert(Math.abs(confirm.cancelWidth - confirm.goWidth) <= 2, `${label}: Dialog-Buttons ungleich`);
    assert(Math.abs(confirm.cancelHeight - confirm.goHeight) <= 2, `${label}: Dialog-Höhe ungleich`);
    assert(confirm.goColor === "rgb(255, 255, 255)", `${label}: Dialog-Löschen nicht weiß`);
    assert(confirm.goBg !== "rgba(0, 0, 0, 0)", `${label}: Dialog-Löschen nicht gefüllt`);
    await page.locator('[data-testid="confirm-delete-place"] [data-action="cancel"]').click();
    await page.waitForSelector('[data-testid="confirm-delete-place"]', { state: "detached" });
    assert((await page.locator('[data-testid="place-edit-sheet"]').count()) === 1, `${label}: Abbrechen schließt das Blatt`);

    await page.locator('[data-testid="edit-place-day"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="place-day-wheel"]')?.hidden === true);
    await page.locator('[data-testid="place-edit-sheet"] [data-action="cancel"]').click();
    await page.waitForSelector('[data-testid="place-edit-sheet"]', { state: "detached" });

    await selectPlace(page, PLACE);
    await page.locator(`[data-page="current"] [data-place-id="${PLACE}"] [data-testid="photo-caption-edit"]`).first().click();
    await page.waitForSelector('[data-testid="photo-caption-sheet"]');
    const longNote = Array.from({ length: 8 }, (_, i) => `Zeile ${i + 1} im Feld`).join("\n");
    await page.locator('[data-testid="photo-caption-text"]').fill(longNote);
    const quiet = await captionMetrics(page);
    assert(quiet.lines >= 5.15 && quiet.lines <= 5.85, `${label}: ${quiet.lines.toFixed(2)} Zeilen statt 5.5`);
    assert(quiet.scrollGap > 2, `${label}: Textarea wächst mit dem Text statt zu scrollen`);
    assert(quiet.saveBottom <= windowHeight(viewport) + 2 && quiet.saveTop >= 0, `${label}: Speichern ohne Tastatur nicht sichtbar`);
    await mockKeyboard(page);
    await page.waitForTimeout(50);
    const typing = await captionMetrics(page);
    assert(typing.kb >= 200, `${label}: Tastaturhöhe ${typing.kb}`);
    assert(typing.sheetKb, `${label}: Tastaturklasse fehlt`);
    assert(typing.saveBottom <= typing.kbTop + 4, `${label}: Speichern unter der Tastatur (${typing.saveBottom} > ${typing.kbTop})`);
    assert(typing.saveTop >= 0 && typing.saveBottom - typing.saveTop >= 30, `${label}: Speichern nicht erreichbar`);
    assert(typing.lines >= 4.4, `${label}: mit Tastatur nur ${typing.lines.toFixed(2)} Zeilen`);
    await page.locator('[data-testid="photo-caption-cancel"]').click();
    await page.waitForSelector('[data-testid="photo-caption-sheet"]', { state: "detached" });

    await assertDayRights(page, state, role, label);
    counts.name = await saveName(page, meter, label, state);
    counts.time = await saveTime(page, meter, label, state);
    counts.day = await saveDay(page, meter, label, state);
    await saveDayImmediately(page, state, label);
    if (role === "owner") await assertDayRollback(page, state, label);

    assert(errors.length === 0, `${label}: ${errors.join(" | ")}`);
    return counts;
  } finally {
    await context.close();
  }
}

function windowHeight(viewport) {
  return viewport.height;
}

async function clickDayAndSave(page, day) {
  await page.evaluate((iso) => {
    document.querySelector(`[data-testid="place-day-wheel"] [data-day="${iso}"]`).click();
    document.querySelector('[data-testid="place-edit-sheet"] [data-action="save"]').click();
  }, day);
}

async function assertDayRights(page, state, role, label) {
  await openEdit(page, "p-mix");
  if (role === "viewer") {
    await page.waitForFunction(() => {
      const hint = document.querySelector('[data-testid="place-day-hint"]');
      return hint && !hint.hidden && (hint.textContent || "").includes("Besitzer oder Mitbearbeiter");
    });
    assert(await page.locator('[data-testid="edit-place-day"]').isDisabled(), `${label}: Tag bleibt für Beitragende wählbar`);
    assert(await page.locator('[data-testid="place-day-wheel"]').isHidden(), `${label}: Rad ist beim Öffnen offen`);
    const stayed = state.waypoints.find((item) => item.id === "p-mix");
    assert(stayed.day === DAYS[1] && stayed.title === "Gemischter Ort", `${label}: Tagwechsel trotz fremder Fotos (${stayed.day} ${stayed.title})`);
    assert(
      state.media.filter((item) => item.waypoint_id === "p-mix").every((item) => item.day === DAYS[1]),
      `${label}: Fotos wandern trotz Sperre`
    );
    await page.locator('[data-testid="place-edit-sheet"] [data-role="name"]').fill("Gemischt neu");
    await page.locator('[data-testid="place-edit-sheet"] [data-action="save"]').click();
    await page.waitForSelector('[data-testid="place-edit-sheet"]', { state: "detached" });
    assert(stayed.title === "Gemischt neu" && stayed.day === DAYS[1], `${label}: Name bleibt nicht speicherbar (${stayed.title} ${stayed.day})`);
    return;
  }
  if (role === "editor") {
    await page.locator('[data-testid="edit-place-day"]').click();
    await page.waitForSelector('[data-testid="place-day-wheel"] [data-day="2026-10-26"]');
    await clickDayAndSave(page, DAYS[0]);
    await page.waitForSelector('[data-testid="place-edit-sheet"]', { state: "detached" });
    const row = state.waypoints.find((item) => item.id === "p-mix");
    assert(row.day === DAYS[0], `${label}: Mitbearbeiter verschiebt den Tag nicht (${row.day})`);
    assert(
      state.media.filter((item) => item.waypoint_id === "p-mix").every((item) => item.day === DAYS[0]),
      `${label}: Mitbearbeiter lässt fremde Fotos liegen`
    );
    return;
  }
  assert(await page.locator('[data-testid="place-day-hint"]').isHidden(), `${label}: Hinweis ohne fremde Sperre`);
  assert(!(await page.locator('[data-testid="edit-place-day"]').isDisabled()), `${label}: Tag ist für den Besitzer gesperrt`);
  await page.locator('[data-testid="place-edit-sheet"] [data-action="cancel"]').click();
  await page.waitForSelector('[data-testid="place-edit-sheet"]', { state: "detached" });
}

async function saveDayImmediately(page, state, label) {
  const before = state.waypoints.find((item) => item.id === "p-sofort").visited_at;
  await page.locator(`.day-chip[data-day="${DAYS[1]}"]`).click();
  await page.waitForSelector('[data-page="current"] [data-place-id="p-sofort"]');
  await openEdit(page, "p-sofort");
  await page.locator('[data-testid="edit-place-day"]').click();
  await page.waitForSelector('[data-testid="place-day-wheel"] [data-day="2026-10-26"]');
  await clickDayAndSave(page, DAYS[0]);
  await page.waitForSelector('[data-testid="place-edit-sheet"]', { state: "detached" });
  const row = state.waypoints.find((item) => item.id === "p-sofort");
  assert(row.day === DAYS[0], `${label} sofort: Tag ${row.day}`);
  assert(row.visited_at === sameClockIso(DAYS[0], before), `${label} sofort: Zeit ${row.visited_at}`);
  assert(
    state.media.filter((item) => item.waypoint_id === "p-sofort").every((item) => item.day === DAYS[0]),
    `${label} sofort: Foto bleibt`
  );
  assert(state.notes.find((item) => item.id === "n-sofort").day === DAYS[0], `${label} sofort: Notiz bleibt`);
}

async function assertDayRollback(page, state, label) {
  await page.locator(`.day-chip[data-day="${DAYS[1]}"]`).click();
  await page.waitForSelector('[data-page="current"] [data-place-id="p-roll"]');
  await openEdit(page, "p-roll");
  await page.locator('[data-testid="edit-place-day"]').click();
  await page.waitForSelector('[data-testid="place-day-wheel"] [data-day="2026-10-28"]');
  state.failNextMediaDay = true;
  await clickDayAndSave(page, DAYS[2]);
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Berechtigung"));
  assert((await page.locator('[data-testid="place-edit-sheet"]').count()) === 1, `${label}: Sheet schließt nach dem Fehlschlag`);
  const row = state.waypoints.find((item) => item.id === "p-roll");
  assert(row.day === DAYS[1], `${label}: Rollback lässt den Ort auf ${row.day}`);
  assert(
    state.media.filter((item) => item.waypoint_id === "p-roll").every((item) => item.day === DAYS[1]),
    `${label}: Rollback lässt Fotos liegen`
  );
  assert(state.notes.find((item) => item.id === "n-roll").day === DAYS[1], `${label}: Rollback lässt die Notiz liegen`);
  assert((await page.locator('[data-page="current"] [data-place-id="p-roll"]').count()) === 1, `${label}: Liste zeigt den Ort nach dem Rollback nicht`);
  await page.locator('[data-testid="place-edit-sheet"] [data-action="cancel"]').click();
  await page.waitForSelector('[data-testid="place-edit-sheet"]', { state: "detached" });
}

async function saveName(page, meter, label, state) {
  await openEdit(page, PLACE);
  await page.locator('[data-testid="place-edit-sheet"] [data-role="name"]').fill("Sigurta Garten");
  const gen = await arm(page, meter);
  await page.locator('[data-testid="place-edit-sheet"] [data-action="save"]').click();
  await page.waitForSelector('[data-testid="place-edit-sheet"]', { state: "detached" });
  await page.waitForFunction(() => document.querySelector("[data-page='current']")?.innerText?.includes("Sigurta Garten"));
  await page.waitForTimeout(350);
  meter.stop();
  await page.evaluate(() => window.__p1stop());
  const snap = await readSnap(page, gen, meter);
  assert(snap.dataChanged === 0, `${label} Name: data-changed ${snap.dataChanged}`);
  assert(snap.renderGen === 0, `${label} Name: globaler Refresh ${snap.renderGen}`);
  assert(snap.currentPageHtml === 1, `${label} Name: Tagesliste ${snap.currentPageHtml} mal`);
  assert(writesOf(snap.api, "waypoints") === 1, `${label} Name: Waypoint-Writes ${JSON.stringify(snap.api.byTable)}`);
  assert(writesOf(snap.api, "media") === 0 && writesOf(snap.api, "notes") === 0, `${label} Name: zusätzliche Writes`);
  const row = state.waypoints.find((item) => item.id === PLACE);
  assert(row.visited_at === "2026-10-27T13:08:17.000Z", `${label} Name verliert die Sekunde (${row.visited_at})`);
  assert(row.day === DAYS[1], `${label} Name ändert den Tag`);
  return snap;
}

async function saveTime(page, meter, label, state) {
  await openEdit(page, PLACE);
  await page.locator('[data-testid="edit-place-time"]').evaluate((el) => {
    el.value = "15:30";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  assert(!(await page.locator('[data-testid="place-edit-sheet"] [data-action="save"]').isDisabled()), `${label}: Uhrzeit aktiviert Speichern nicht`);
  const gen = await arm(page, meter);
  await page.locator('[data-testid="place-edit-sheet"] [data-action="save"]').click();
  await page.waitForSelector('[data-testid="place-edit-sheet"]', { state: "detached" });
  await page.waitForFunction(
    (id) => (document.querySelector(`[data-page="current"] [data-place-id="${id}"]`)?.innerText || "").includes("15:30"),
    PLACE
  );
  await page.waitForTimeout(350);
  meter.stop();
  await page.evaluate(() => window.__p1stop());
  const snap = await readSnap(page, gen, meter);
  const row = state.waypoints.find((item) => item.id === PLACE);
  assert(row.visited_at === atLocalTime(DAYS[1], "15:30"), `${label} Zeit: ${row.visited_at}`);
  assert(row.day === DAYS[1], `${label} Zeit ändert den Tag`);
  assert(
    state.media.filter((item) => item.waypoint_id === PLACE).every((item) => item.day === DAYS[1]),
    `${label} Zeit verschiebt Fotos`
  );
  assert(snap.dataChanged === 0 && snap.renderGen === 0, `${label} Zeit: Refresh ${snap.dataChanged}/${snap.renderGen}`);
  assert(snap.currentPageHtml === 1, `${label} Zeit: Tagesliste ${snap.currentPageHtml}`);
  assert(writesOf(snap.api, "waypoints") === 1, `${label} Zeit: Writes ${JSON.stringify(snap.api.byTable)}`);
  assert(writesOf(snap.api, "media") === 0 && writesOf(snap.api, "notes") === 0, `${label} Zeit: Anhangs-Writes`);
  return snap;
}

async function saveDay(page, meter, label, state) {
  await openEdit(page, PLACE);
  await page.locator('[data-testid="edit-place-day"]').click();
  await page.waitForSelector('[data-testid="place-day-wheel"] [data-day="2026-10-28"]');
  await page.locator('[data-testid="place-day-wheel"] [data-day="2026-10-28"]').click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="edit-place-day"]')?.innerText || "").includes("Mi 28.10. · 3. Tag"));
  assert(!(await page.locator('[data-testid="place-edit-sheet"] [data-action="save"]').isDisabled()), `${label}: Tag aktiviert Speichern nicht`);
  const gen = await arm(page, meter);
  await page.locator('[data-testid="place-edit-sheet"] [data-action="save"]').click();
  await page.waitForSelector('[data-testid="place-edit-sheet"]', { state: "detached" });
  await page.waitForFunction(
    (id) => !document.querySelector(`[data-page="current"] [data-place-id="${id}"]`),
    PLACE
  );
  await page.waitForTimeout(700);
  meter.stop();
  await page.evaluate(() => window.__p1stop());
  const snap = await readSnap(page, gen, meter);
  const row = state.waypoints.find((item) => item.id === PLACE);
  assert(row.day === DAYS[2], `${label} Tag: day ${row.day}`);
  assert(row.visited_at === atLocalTime(DAYS[2], "15:30"), `${label} Tag: visited_at ${row.visited_at}`);
  assert(state.media.filter((item) => item.waypoint_id === PLACE).every((item) => item.day === DAYS[2]), `${label} Tag: Fotos bleiben`);
  assert(state.notes.find((item) => item.id === "n-park").day === DAYS[2], `${label} Tag: Notiz bleibt`);
  assert(snap.dataChanged === 0, `${label} Tag: data-changed ${snap.dataChanged}`);
  assert(snap.renderGen === 0, `${label} Tag: globaler Refresh ${snap.renderGen}`);
  assert(snap.currentPageHtml === 1, `${label} Tag: Tagesliste ${snap.currentPageHtml}`);
  assert(writesOf(snap.api, "waypoints") === 1, `${label} Tag: Ort ${JSON.stringify(snap.api.byTable)}`);
  assert(writesOf(snap.api, "media") === 2, `${label} Tag: Fotos ${JSON.stringify(snap.api.byTable)}`);
  assert(writesOf(snap.api, "notes") === 1, `${label} Tag: Notiz ${JSON.stringify(snap.api.byTable)}`);

  await page.locator(`.day-chip[data-day="${DAYS[2]}"]`).click();
  await page.waitForSelector(`[data-page="current"] [data-place-id="${PLACE}"]`);
  const moved = await page.locator(`[data-page="current"] [data-place-id="${PLACE}"]`).innerText();
  assert(moved.includes("Sigurta Garten"), `${label}: Name fehlt am neuen Tag`);
  assert(moved.includes("Parkweg"), `${label}: Notiz fehlt am neuen Tag`);
  assert(moved.includes("15:30"), `${label}: Uhrzeit fehlt am neuen Tag`);
  return snap;
}

function brief(snap) {
  return {
    dataChanged: snap.dataChanged,
    renderGen: snap.renderGen,
    currentPageHtml: snap.currentPageHtml,
    appHtml: snap.appHtml,
    gets: snap.api.gets,
    writes: snap.api.writes,
    byTable: snap.api.byTable,
  };
}

async function run() {
  const { server, baseUrl } = await startServer();
  const report = {};
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch({ headless: true });
      try {
        for (const viewport of VIEWPORTS) {
          for (const role of ["owner", "editor", "viewer"]) {
            const key = `${engine.name()} ${viewport.width} ${role}`;
            const counts = await runCase(browser, baseUrl, viewport, role);
            report[key] = {
              name: brief(counts.name),
              time: brief(counts.time),
              day: brief(counts.day),
            };
            console.log(`ok ${key}`);
          }
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.close();
  }
  console.log(`PAKET1_REPORT ${JSON.stringify(report)}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
