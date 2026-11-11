import { chromium, webkit } from "playwright";
import {
  USER,
  createMockSupabaseState,
  installSupabaseMocks,
  startServer,
} from "./run-tests-12b-recap-video.mjs";

const TRIP = "trip-paket2";
const OTHER = "22222222-2222-2222-2222-222222222222";
const DAYS = ["2026-10-26", "2026-10-27", "2026-10-28"];
const HINT =
  "Den Tag können hier nur Besitzer oder Mitbearbeiter ändern, weil Fotos oder Notizen anderer dabei sind.";
const VIEWPORTS = [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

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
    lat: 45.76,
    lng: 10.8,
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

function photoRow(id, placeId, day, time, author, caption) {
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
    deleted_at: null,
    created_at: iso,
    updated_at: iso,
    created_by: author,
  };
}

function noteRow(id, placeId, day, body, author) {
  const iso = `${day}T13:40:00.000Z`;
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
  state.gets = [];
  state.people = [
    {
      user_id: USER,
      display_name: "Dominik",
      role: "owner",
      person_kind: "member",
      status: "aktiv",
      avatar_color: "#0066b3",
    },
    {
      user_id: OTHER,
      display_name: "Sabine",
      role: "editor",
      person_kind: "member",
      status: "aktiv",
      avatar_color: "#D64541",
    },
  ];
  state.trips.push({
    id: TRIP,
    title: "Paket 2",
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
    placeRow("p-hafen", "Hafen", DAYS[1], "12:00:00"),
    placeRow("p-ziel", "Zielort", DAYS[1], "09:00:00"),
    placeRow("p-clean", "Eigener Ort", DAYS[1], "08:00:00"),
    placeRow("p-mix", "Gemischter Ort", DAYS[1], "10:00:00"),
    placeRow("p-notiz", "Notizort", DAYS[1], "07:30:00"),
    placeRow("p-roll", "Rollback Ort", DAYS[1], "07:00:00")
  );
  state.media.push(
    photoRow("m-own", "p-hafen", DAYS[1], "12:05:00", USER, "Mein Steg"),
    photoRow("m-fremd", "p-hafen", DAYS[1], "12:10:00", OTHER, "Fremde Notiz"),
    photoRow("m-clean", "p-clean", DAYS[1], "08:05:00", USER, "Nur meins"),
    photoRow("m-mix-own", "p-mix", DAYS[1], "10:05:00", USER, null),
    photoRow("m-mix-other", "p-mix", DAYS[1], "10:10:00", OTHER, null),
    photoRow("m-roll", "p-roll", DAYS[1], "07:05:00", USER, null)
  );
  state.notes.push(noteRow("n-fremd", "p-notiz", DAYS[1], "Fremde Ortsnotiz", OTHER));
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

function allowWrites(state) {
  const rest = state.handleRest.bind(state);
  state.handleRest = async (url, method, body, headers) => {
    const table = url.pathname.split("/").filter(Boolean).pop();
    if (method === "GET") state.gets.push(table);
    if (url.pathname.includes("list_trip_people")) return { status: 200, json: state.people };
    if (url.pathname.includes("list_trip_presence") || url.pathname.includes("list_my_trip_invites")) {
      return { status: 200, json: [] };
    }
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
        return { status: 201, json: row };
      }
      const rows = matchRows(list, url);
      if (!rows.length) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
      const now = new Date().toISOString();
      for (const row of rows) Object.assign(row, patch, { updated_at: now });
      return { status: 200, json: rows.length === 1 ? rows[0] : rows };
    }
    return rest(url, method, body, headers);
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

async function openDay(page) {
  await page.locator(`[data-vacation-id="${TRIP}"]`).first().click();
  await page.waitForSelector('[data-testid="trip-content"]', { timeout: 20_000 });
  await page.locator(`.day-chip[data-day="${DAYS[1]}"]`).click();
  await page.waitForSelector('[data-page="current"] [data-place-id="p-hafen"]');
}

async function selectPlace(page, id) {
  const card = page.locator(`[data-page="current"] [data-place-id="${id}"]`);
  if ((await card.locator(".oc--selected, .oc").count()) && (await card.evaluate((el) => el.classList.contains("oc--selected")))) return;
  await card.locator(".oc__title").click();
  await page.waitForFunction(
    (placeId) => document.querySelector("[data-page='current'] .oc--selected")?.dataset.placeId === placeId,
    id
  );
}

async function openEdit(page, id) {
  await selectPlace(page, id);
  await page.locator(`[data-page="current"] [data-place-id="${id}"] [data-action="edit-place"]`).click();
  await page.waitForSelector('[data-testid="place-edit-sheet"]');
}

async function closeSheet(page) {
  await page.locator('[data-testid="place-edit-sheet"] [data-action="cancel"]').click();
  await page.waitForSelector('[data-testid="place-edit-sheet"]', { state: "detached" });
}

function card(page) {
  return page.locator('[data-page="current"] .oc--selected[data-place-id="p-hafen"]');
}

async function assertLayout(page, label) {
  const root = card(page);
  assert((await root.locator(".tiles").count()) === 0, `${label}: Kachelleiste ist noch da`);
  assert((await page.locator('[data-testid="photo-select-start"]').count()) === 0, `${label}: Knopf Auswählen ist noch da`);
  assert((await root.locator('[data-testid="photo-caption-row"]').count()) === 2, `${label}: Fotozeilen fehlen`);
  const check = await root.locator('[data-testid="photo-row-check"][data-media-id="m-own"]').boundingBox();
  const thumb = await root.locator('[data-testid="place-photo"][data-media-id="m-own"]').boundingBox();
  const pin = await root.locator(".pinb").boundingBox();
  const title = await root.locator(".oc__title").boundingBox();
  assert(check && thumb && pin && title, `${label}: Zeile ohne Maße`);
  assert(Math.abs(check.width - 22) <= 2 && Math.abs(check.height - 22) <= 2, `${label}: Kreis ${Math.round(check.width)}×${Math.round(check.height)}`);
  assert(Math.abs(thumb.width - 68) <= 2 && Math.abs(thumb.height - 68) <= 2, `${label}: Miniatur ${Math.round(thumb.width)}×${Math.round(thumb.height)}`);
  assert(check.x + check.width < thumb.x - 2, `${label}: Kreis sitzt nicht links von der Miniatur`);
  assert(Math.abs(check.x + check.width / 2 - (pin.x + pin.width / 2)) <= 4, `${label}: Kreis nicht unter der Nadel`);
  assert(check.y >= pin.y + pin.height - 2, `${label}: Kreis sitzt nicht unter der Nadel`);
  assert(check.x < title.x - 16, `${label}: Zeile reicht nicht bis an den Kartenrand`);
  const font = await root.locator('[data-testid="photo-caption-edit"][data-media-id="m-own"]').evaluate((el) => getComputedStyle(el).fontSize);
  assert(font === "15px", `${label}: Text ${font}`);
  const order = await root.locator('[data-testid="photo-caption-row"]').evaluateAll((els) => els.map((el) => el.dataset.mediaId));
  assert(order.join(",") === "m-own,m-fremd", `${label}: Reihenfolge ${order.join(",")}`);
}

async function assertSeal(page, label) {
  await page.waitForSelector('[data-page="current"] .photo-row__thumb .kr-seal');
  const seal = await page.locator('[data-media-id="m-own"] .kr-seal').evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      text: el.textContent.trim(),
      font: cs.fontFamily,
      color: cs.color,
      border: cs.borderTopWidth,
      bg: cs.backgroundColor,
    };
  });
  assert(seal.text === "D", `${label}: Siegelbuchstabe ${seal.text}`);
  assert(/georgia|palatino|times|serif/i.test(seal.font), `${label}: Siegel-Schrift ${seal.font}`);
  assert(seal.color === "rgb(246, 241, 228)", `${label}: Siegelfarbe ${seal.color}`);
  assert(parseFloat(seal.border) >= 1, `${label}: Siegelrand ${seal.border}`);
  assert(seal.bg === "rgb(0, 102, 179)", `${label}: Siegelfläche ${seal.bg}`);
  const foreign = await page.locator('[data-media-id="m-fremd"] .kr-seal').evaluate((el) => getComputedStyle(el).backgroundColor);
  assert(foreign === "rgb(214, 69, 65)", `${label}: Personenfarbe ${foreign}`);
}

async function assertHits(page, state, label) {
  const root = card(page);
  await root.locator('[data-testid="photo-row-check"][data-media-id="m-own"]').click();
  await page.waitForSelector('[data-testid="photo-select-bar"]');
  assert((await page.locator('[data-testid="photo-select-count"]').innerText()).includes("1 ausgewählt"), `${label}: eigenes Foto nicht angehakt`);
  assert((await page.locator('[data-testid="media-viewer"]').count()) === 0, `${label}: Kreis öffnet den Betrachter`);
  assert((await page.locator('[data-testid="photo-caption-sheet"]').count()) === 0, `${label}: Kreis öffnet die Notiz`);
  const bg = await root.locator('[data-testid="photo-caption-row"][data-media-id="m-own"]').evaluate((el) => getComputedStyle(el).backgroundColor);
  assert(bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent", `${label}: angehakte Zeile ohne Hintergrund (${bg})`);
  await root.locator('[data-testid="photo-row-check"][data-media-id="m-fremd"]').click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Nur eigene Fotos"));
  assert((await page.locator('[data-testid="photo-select-count"]').innerText()).includes("1 ausgewählt"), `${label}: fremdes Foto mitgezählt`);
  assert((await root.locator('[data-testid="photo-row-check"][data-media-id="m-fremd"]').getAttribute("aria-pressed")) === "false", `${label}: fremdes Foto ist angehakt`);
  assert((await page.locator('[data-testid="media-viewer"]').count()) === 0, `${label}: fremder Kreis öffnet den Betrachter`);
  assert((await page.locator('[data-testid="photo-caption-sheet"]').count()) === 0, `${label}: fremder Kreis öffnet die Notiz`);
  assert((await page.locator('[data-testid="photo-move"]').innerText()).includes("Verschieben nach"), `${label}: Verschieben fehlt`);
  await page.locator('[data-testid="photo-move"]').click();
  await page.waitForSelector('[data-testid="photo-move-sheet"]');
  await page.locator('[data-move-place="p-ziel"]').click();
  await page.waitForFunction(() => (document.querySelector('[data-place-id="p-ziel"] .oc__meta')?.textContent || "").includes("1 Foto"));
  assert(state.media.find((row) => row.id === "m-own").waypoint_id === "p-ziel", `${label}: eigenes Foto nicht verschoben`);
  assert(state.media.find((row) => row.id === "m-fremd").waypoint_id === "p-hafen", `${label}: fremdes Foto verschoben`);
  await selectPlace(page, "p-hafen");
  await root.locator('[data-testid="place-photo"][data-media-id="m-fremd"]').click();
  await page.waitForSelector('[data-testid="media-viewer"]');
  assert((await page.locator('[data-testid="photo-caption-sheet"]').count()) === 0, `${label}: Miniatur öffnet die Notiz`);
  await page.click('[data-testid="media-viewer-close"]');
  await page.waitForSelector('[data-testid="media-viewer"]', { state: "detached" });
  await root.locator('[data-testid="photo-row-text"][data-media-id="m-fremd"]').click();
  await page.waitForSelector('[data-testid="photo-caption-sheet"]');
  assert((await page.locator('[data-testid="media-viewer"]').count()) === 0, `${label}: Text öffnet den Betrachter`);
  assert((await page.locator('[data-testid="photo-caption-text"]').inputValue()) === "Fremde Notiz", `${label}: Text öffnet die falsche Notiz`);
  assert(await page.locator('[data-testid="photo-caption-text"]').evaluate((el) => el.readOnly), `${label}: fremde Notiz ist beschreibbar`);
  await page.click('[data-testid="photo-caption-cancel"]');
  await page.waitForSelector('[data-testid="photo-caption-sheet"]', { state: "detached" });
  const box = await root.locator('[data-testid="place-photo"][data-media-id="m-fremd"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  if (await page.locator('[data-testid="media-viewer"]').count()) {
    await page.click('[data-testid="media-viewer-close"]');
    await page.waitForSelector('[data-testid="media-viewer"]', { state: "detached" });
  }
  assert((await page.locator('[data-testid="photo-select-bar"]').count()) === 0, `${label}: Langdruck auf der Miniatur wählt aus`);
}

async function assertDayLock(page, state, role, label) {
  const from = state.gets.length;
  await openEdit(page, "p-mix");
  const opened = state.gets.slice(from);
  assert(!opened.includes("media") && !opened.includes("notes"), `${label}: Öffnen fragt ${opened.join(",")}`);
  const hint = page.locator('[data-testid="place-day-hint"]');
  if (role === "viewer") {
    await page.waitForFunction((text) => document.querySelector('[data-testid="place-day-hint"]')?.textContent === text, HINT);
    assert(await page.locator('[data-testid="edit-place-day"]').isDisabled(), `${label}: Tag ist beim Öffnen offen`);
    assert(await page.locator('[data-testid="place-day-wheel"]').isHidden(), `${label}: Rad ist beim Öffnen offen`);
    await closeSheet(page);
    await openEdit(page, "p-notiz");
    await page.waitForFunction((text) => document.querySelector('[data-testid="place-day-hint"]')?.textContent === text, HINT);
    assert(await page.locator('[data-testid="edit-place-day"]').isDisabled(), `${label}: Notizort lässt den Tag offen`);
    await closeSheet(page);
    await openEdit(page, "p-clean");
    assert(await hint.isHidden(), `${label}: eigener Ort ist gesperrt`);
    assert(!(await page.locator('[data-testid="edit-place-day"]').isDisabled()), `${label}: eigener Tag ist gesperrt`);
    await closeSheet(page);
    await page.evaluate(
      async ({ trip, day }) => {
        const { dropDayPlaceMemory } = await import("./js/ui-place-list.js");
        dropDayPlaceMemory(trip, day);
      },
      { trip: TRIP, day: DAYS[1] }
    );
    await openEdit(page, "p-mix");
    assert(!(await page.locator('[data-testid="edit-place-day"]').isDisabled()), `${label}: Tag ohne Cache schon gesperrt`);
    await page.locator('[data-testid="place-edit-sheet"] [data-role="name"]').fill("Darf nicht bleiben");
    await page.locator('[data-testid="edit-place-day"]').click();
    await page.locator(`[data-testid="place-day-wheel"] [data-day="${DAYS[2]}"]`).click();
    await page.locator('[data-testid="place-edit-sheet"] [data-action="save"]').click();
    await page.waitForFunction((text) => document.querySelector('[data-testid="place-day-hint"]')?.textContent === text, HINT);
    await page.waitForTimeout(250);
    const toast = (await page.locator('[data-testid="app-toast"]').count())
      ? await page.locator('[data-testid="app-toast"]').innerText()
      : "";
    assert(!toast.includes("Gespeichert"), `${label}: stilles Speichern «${toast}»`);
    const row = state.waypoints.find((item) => item.id === "p-mix");
    assert(row.title === "Gemischter Ort" && row.day === DAYS[1], `${label}: Tag und Name wurden trotzdem geschrieben (${row.title} ${row.day})`);
    assert((await page.locator('[data-testid="place-edit-sheet"]').count()) === 1, `${label}: Sheet schließt nach der Sperre`);
    const marked = await page.locator(".place-day-wheel__item--active").getAttribute("data-day");
    assert(marked === DAYS[1], `${label}: Rad markiert nach der Sperre ${marked}`);
    await closeSheet(page);
    return;
  }
  assert(await hint.isHidden(), `${label}: ${role} sieht die Tages-Sperre`);
  assert(!(await page.locator('[data-testid="edit-place-day"]').isDisabled()), `${label}: ${role} kann den Tag nicht öffnen`);
  await page.locator('[data-testid="edit-place-day"]').click();
  await page.waitForSelector(`[data-testid="place-day-wheel"] [data-day="${DAYS[0]}"]`);
  await closeSheet(page);
  if (role !== "owner") return;
  await openEdit(page, "p-roll");
  await page.locator('[data-testid="edit-place-day"]').click();
  await page.locator(`[data-testid="place-day-wheel"] [data-day="${DAYS[2]}"]`).click();
  state.failNextMediaDay = true;
  await page.locator('[data-testid="place-edit-sheet"] [data-action="save"]').click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Berechtigung"));
  const row = state.waypoints.find((item) => item.id === "p-roll");
  assert(row.day === DAYS[1], `${label}: Rollback lässt den Ort auf ${row.day}`);
  assert(state.media.find((item) => item.id === "m-roll").day === DAYS[1], `${label}: Rollback lässt das Foto wandern`);
  const marked = await page.locator(".place-day-wheel__item--active").getAttribute("data-day");
  assert(marked === DAYS[1], `${label}: Rad markiert nach dem Rollback ${marked}`);
  const centered = await page.evaluate(() => {
    const scroller = document.querySelector('[data-role="day-wheel"]');
    const active = document.querySelector(".place-day-wheel__item--active");
    if (!scroller || !active || scroller.closest("[hidden]")) return false;
    const host = scroller.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    return Math.abs(item.top + item.height / 2 - (host.top + host.height / 2)) < 24;
  });
  assert(centered, `${label}: alter Tag steht nicht in der Mitte des Rads`);
  await closeSheet(page);
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
  const state = createMockSupabaseState();
  state.role = role;
  seed(state);
  allowWrites(state);
  await installSupabaseMocks(page, state);
  try {
    await login(page);
    await openDay(page);
    await selectPlace(page, "p-hafen");
    await page.waitForSelector('[data-testid="photo-row-check"][data-media-id="m-own"]');
    await assertLayout(page, label);
    await assertSeal(page, label);
    await assertHits(page, state, label);
    await assertDayLock(page, state, role, label);
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
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.close();
  }
  console.log("Paket 2 Ort-Karte Zeilen grün");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
