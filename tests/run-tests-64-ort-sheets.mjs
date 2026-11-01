import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const DAY = "2026-10-26";
const USER = "11111111-1111-1111-1111-111111111111";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const VIEWPORTS = [
  { width: 375, height: 667 },
  { width: 360, height: 740 },
  { width: 390, height: 844 },
];

function assert(cond, message) {
  if (!cond) throw new Error(message);
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

function recapUniqueViolation(rows, candidate) {
  if (candidate.deleted_at) return false;
  if (candidate.status !== "final" && candidate.status !== "notes") return false;
  return rows.some(
    (row) =>
      !row.deleted_at &&
      row.id !== candidate.id &&
      row.trip_id === candidate.trip_id &&
      row.kind === candidate.kind &&
      row.status === candidate.status
  );
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
  const trips = [];
  const waypoints = [];
  const notes = [];
  const media = [];
  const recaps = [];
  const readCounts = { notes: 0, media: 0, waypoints: 0 };
  const abortGet = new Set();
  let waypointPosts = 0;
  let readsAtInsert = { notes: 0, media: 0, waypoints: 0 };
  let recapInserts = 0;
  let failRecapWrite = false;

  function represent(row, headers) {
    const accept = headers.accept || headers.Accept || "";
    if (String(accept).includes("application/vnd.pgrst.object+json")) return row;
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
  function sendRows(rows, headers) {
    const accept = headers.accept || headers.Accept || "";
    if (String(accept).includes("application/vnd.pgrst.object+json")) {
      if (!rows.length) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
      return { status: 200, json: rows[0] };
    }
    return { status: 200, json: rows };
  }
  function upsert(list, row) {
    const id = row.id || crypto.randomUUID();
    const hit = list.find((item) => item.id === id);
    const full = {
      created_by: USER,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
      ...(hit || {}),
      ...row,
      id,
      created_by: hit?.created_by || row.created_by || USER,
    };
    if (hit) Object.assign(hit, full);
    else list.push(full);
    return full;
  }

  return {
    trips,
    waypoints,
    notes,
    media,
    recaps,
    readCounts,
    abortGet,
    get waypointPosts() {
      return waypointPosts;
    },
    get readsAtInsert() {
      return readsAtInsert;
    },
    get recapInserts() {
      return recapInserts;
    },
    get failRecapWrite() {
      return failRecapWrite;
    },
    set failRecapWrite(value) {
      failRecapWrite = Boolean(value);
    },
    handleAuth(url, method) {
      const pathName = url.pathname;
      if (pathName.endsWith("/otp") && method === "POST") return { status: 200, json: {} };
      if (pathName.endsWith("/verify") && method === "POST") return { status: 200, json: session };
      if (pathName.endsWith("/token") && method === "POST") return { status: 200, json: session };
      if (pathName.endsWith("/user") && method === "GET") return { status: 200, json: session.user };
      return { status: 404, json: {} };
    },
    handleRest(url, method, body, headers) {
      const table = url.pathname.split("/").filter(Boolean).pop();
      if (table === "trips") {
        if (method === "POST" || method === "PATCH") {
          return { status: 201, json: represent(upsert(trips, JSON.parse(body || "{}")), headers) };
        }
        if (method === "GET") return sendRows(applyFilters(trips, url), headers);
      }
      if (table === "waypoints" && (method === "POST" || method === "PUT")) {
        waypointPosts += 1;
        readsAtInsert = { ...readCounts };
        return { status: 201, json: represent(upsert(waypoints, JSON.parse(body || "{}")), headers) };
      }
      if (table === "waypoints" && method === "PATCH") {
        const rows = applyFilters(waypoints, url);
        const patch = JSON.parse(body || "{}");
        for (const row of rows) Object.assign(row, patch);
        return sendRows(rows, headers);
      }
      if (table === "waypoints" && method === "GET") return sendRows(applyFilters(waypoints, url), headers);
      if (table === "notes" && (method === "POST" || method === "PATCH")) {
        return { status: 201, json: represent(upsert(notes, JSON.parse(body || "{}")), headers) };
      }
      if (table === "notes" && method === "GET") return sendRows(applyFilters(notes, url), headers);
      if (table === "media" && method === "GET") return sendRows(applyFilters(media, url), headers);
      if (table === "media" && method === "PATCH") {
        const rows = applyFilters(media, url);
        const patch = JSON.parse(body || "{}");
        if (rows[0]) Object.assign(rows[0], patch);
        return sendRows(rows, headers);
      }
      if (table === "trip_members" && method === "GET") {
        const tripId = url.searchParams.get("trip_id")?.replace(/^eq\./, "") || trips[0]?.id || "";
        return sendRows([{ role: "editor", trip_id: tripId, user_id: USER }], headers);
      }
      if (table === "trip_recaps" && method === "GET") return sendRows(applyFilters(recaps, url), headers);
      if (table === "trip_recaps" && (method === "POST" || method === "PATCH")) {
        if (failRecapWrite) return { status: 500, json: { message: "recap write failed", code: "500" } };
        const payload = JSON.parse(body || "{}");
        if (method === "POST") {
          const candidate = { ...payload, id: payload.id || "new" };
          if (recapUniqueViolation(recaps, candidate)) {
            const name = candidate.status === "notes" ? "trip_recaps_one_notes" : "trip_recaps_one_final";
            return {
              status: 409,
              json: {
                code: "23505",
                message: `duplicate key value violates unique constraint "${name}"`,
                details: "Key (trip_id, kind) already exists.",
              },
            };
          }
          recapInserts += 1;
          return { status: 201, json: represent(upsert(recaps, payload), headers) };
        }
        const rows = applyFilters(recaps, url);
        if (!rows.length) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
        const next = { ...rows[0], ...payload };
        if (recapUniqueViolation(recaps, next)) {
          const name = next.status === "notes" ? "trip_recaps_one_notes" : "trip_recaps_one_final";
          return {
            status: 409,
            json: { code: "23505", message: `duplicate key value violates unique constraint "${name}"` },
          };
        }
        Object.assign(rows[0], payload, { updated_at: new Date().toISOString() });
        return sendRows(rows, headers);
      }
      return { status: 404, json: { message: `missing ${method} ${table}` } };
    },
  };
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

async function installRoutes(page, state) {
  await page.context().route(`**/${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders(req) });
      return;
    }
    if (url.pathname.includes("/rest/v1/") && req.method() === "GET") {
      const table = url.pathname.split("/").filter(Boolean).pop();
      if (Object.prototype.hasOwnProperty.call(state.readCounts, table)) state.readCounts[table] += 1;
      if (state.abortGet.has(table)) {
        await route.abort("failed");
        return;
      }
    }
    let result;
    if (url.pathname.includes("/auth/v1/")) result = state.handleAuth(url, req.method());
    else if (url.pathname.includes("/rest/v1/")) result = state.handleRest(url, req.method(), req.postData(), req.headers());
    else result = { status: 404, json: {} };
    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      headers: corsHeaders(req),
      body: result.json == null ? "" : JSON.stringify(result.json),
    });
  });
  await page.context().route("**/nominatim.openstreetmap.org/**", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "down" }) })
  );
  await page.context().route("**/tile.openstreetmap.org/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: TINY_PNG })
  );
  await page.context().route("**/routing.openstreetmap.de/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: "Ok", routes: [] }) })
  );
}

function seedPlaces(state, tripId) {
  const iso = `${DAY}T12:00:00.000Z`;
  state.waypoints.push({
    id: "p-hafen",
    trip_id: tripId,
    day: DAY,
    visited_at: "2026-10-26T17:00:00.000Z",
    lat: 45.77,
    lng: 10.81,
    accuracy_m: 8,
    title: "Hafen",
    is_soft: false,
    source: "manual",
    deleted_at: null,
    created_at: iso,
    updated_at: iso,
    created_by: USER,
  });
}

function overlaps(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 1 && h > 1;
}

async function hitBoxes(page, selector) {
  return page.locator(selector).evaluateAll((els) =>
    els.map((el) => {
      const base = el.getBoundingClientRect();
      const cs = getComputedStyle(el, "::after");
      if (!cs || cs.content === "none" || cs.position !== "absolute") {
        return {
          left: base.left,
          top: base.top,
          right: base.right,
          bottom: base.bottom,
          width: base.width,
          height: base.height,
        };
      }
      const width = parseFloat(cs.width);
      const height = parseFloat(cs.height);
      const cssLeft = cs.left === "auto" ? 0 : parseFloat(cs.left) || 0;
      const cssTop = cs.top === "auto" ? 0 : parseFloat(cs.top) || 0;
      let tx = 0;
      let ty = 0;
      const matrix = /matrix\(([^)]+)\)/.exec(cs.transform || "");
      if (matrix) {
        const parts = matrix[1].split(",").map((n) => parseFloat(n.trim()));
        tx = parts[4] || 0;
        ty = parts[5] || 0;
      }
      const left = base.left + cssLeft + tx;
      const top = base.top + cssTop + ty;
      return { left, top, right: left + width, bottom: top + height, width, height };
    })
  );
}

function assertHits(boxes, label) {
  assert(boxes.length > 0, `${label}: keine Treffer`);
  boxes.forEach((box, index) => {
    assert(box.width >= 44 && box.height >= 44, `${label}[${index}] ${Math.round(box.width)}x${Math.round(box.height)}`);
  });
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      assert(!overlaps(boxes[i], boxes[j]), `${label}: Überlappung ${i}/${j}`);
    }
  }
}

async function loginAndOpen(page) {
  await page.waitForSelector('[data-testid="login-screen"]');
  await page.evaluate(async () => {
    const { setRememberLocationOnOpen, setMapRoutesEnabled } = await import("./js/settings-store.js");
    await setRememberLocationOnOpen(false);
    await setMapRoutesEnabled(false);
  });
  await page.fill('input[name="email"]', "test@example.com");
  await page.click('form[data-step="email"] button[type="submit"]');
  await page.waitForSelector('form[data-step="otp"]');
  await page.fill('input[name="otp"]', "123456");
  await page.click('form[data-step="otp"] button[type="submit"]');
  await page.waitForSelector(".screen--urlaube");
  await page.click('[data-action="new"]');
  await page.fill('input[name="title"]', "Gardasee 2026");
  await page.click('[data-action="pick-dates"]');
  await page.click('.calendar-day[data-date="2026-10-26"]');
  await page.click('.calendar-day[data-date="2026-10-29"]');
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  return page.locator(".screen--trip").getAttribute("data-vacation-id");
}

async function waitSheetReady(page, testId) {
  await page.waitForSelector(`[data-testid="${testId}"]`);
  await page.waitForFunction((id) => {
    const sheet = document.querySelector(`[data-testid="${id}"]`);
    return sheet && !sheet.classList.contains("sheet--input-blocked");
  }, testId);
}

async function pullClosed(page, testId) {
  await waitSheetReady(page, testId);
  const handle = page.locator(`[data-testid="${testId}"] .sheet-handle`);
  const box = await handle.boundingBox();
  assert(box, `${testId}: Griff fehlt`);
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 8);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 240, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction((id) => !document.querySelector(`[data-testid="${id}"]`), testId, { timeout: 4000 });
}

async function openAddPlace(page) {
  const mapReady = await page.evaluate(() => Boolean(window.__vacrecapMap?._loaded));
  if (!mapReady) {
    if (await page.locator('[data-testid="map-screen"] [data-action="back"]').count()) {
      await page.click('[data-testid="map-screen"] [data-action="back"]');
      await page.waitForSelector('[data-testid="trip-content"], .screen--urlaube');
    }
    await page.click('[data-action="map"]');
    await page.waitForSelector('[data-testid="map-screen"]');
    await page.click(`[data-segment="${DAY}"]`);
    await page.waitForFunction(
      (day) => document.querySelector(`[data-segment="${day}"]`)?.getAttribute("aria-selected") === "true",
      DAY
    );
  }
  const point = await page.waitForFunction(() => {
    const map = window.__vacrecapMap;
    if (!map?._loaded) return null;
    try {
      map.invalidateSize();
      const size = map.getSize();
      if (!size?.x || !size?.y) return null;
      const target = map.containerPointToLatLng([Math.round(size.x * 0.62), Math.round(size.y * 0.18)]);
      const pixel = map.latLngToContainerPoint(target);
      if (!Number.isFinite(pixel?.x) || !Number.isFinite(pixel?.y)) return null;
      return { x: pixel.x, y: pixel.y };
    } catch {
      return null;
    }
  });
  const tap = await point.jsonValue();
  await page.locator(".map-canvas").click({ position: { x: Math.max(8, tap.x), y: Math.max(8, tap.y) } });
  await waitSheetReady(page, "add-place-sheet");
}

async function openSheet(page, kind, tripId) {
  await page.evaluate(
    async ({ kind, tripId }) => {
      const vacation = { id: tripId, title: "Gardasee 2026", startDate: "2026-10-26", endDate: "2026-10-29" };
      if (kind === "assign") {
        const file = new File([new Uint8Array([1, 2, 3, 4])], "a.jpg", { type: "image/jpeg" });
        const { openPhotoAssignSheet } = await import("./js/ui-photo-assign-sheet.js");
        window.__sheet = openPhotoAssignSheet({
          groups: [
            {
              id: "g1",
              photoKeys: ["k1"],
              kind: "place",
              name: "Hafen",
              day: "2026-10-26",
              place: { id: "p-hafen", name: "Hafen", day: "2026-10-26", ts: 1 },
            },
          ],
          filesByKey: new Map([["k1", file]]),
          activeDay: "2026-10-26",
          vacation,
          selectedPlace: { id: "p-hafen", name: "Hafen", day: "2026-10-26" },
          dayPlaces: () => [],
        });
      } else if (kind === "caption") {
        const { openPhotoCaptionSheet } = await import("./js/ui-photo-caption-sheet.js");
        window.__sheet = openPhotoCaptionSheet({ media: { id: "m1", caption: "Alt" } });
      } else if (kind === "move") {
        const { openPhotoMoveSheet } = await import("./js/ui-photo-move-sheet.js");
        window.__sheet = openPhotoMoveSheet({
          vacation,
          places: [
            { id: "p-hafen", name: "Hafen", day: "2026-10-26", dayDate: "2026-10-26", ts: Date.parse("2026-10-26T17:00:00Z"), soft: false },
          ],
          initialDay: "2026-10-26",
        });
      } else if (kind === "target") {
        const { openPhotoTargetSheet } = await import("./js/ui-photo-target-sheet.js");
        window.__sheet = openPhotoTargetSheet({
          title: "Ziel für 1 Foto",
          thumbs: [],
          options: [{ key: "hafen", title: "Hafen", sub: "Anreise", kind: "place", selected: true }],
        });
      }
    },
    { kind, tripId }
  );
}

async function runFlows(page, state, where) {
  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  assert(Number(build) === 65, `${where}: Build ${build}`);
  const tripId = await loginAndOpen(page);

  assertHits(await hitBoxes(page, ".trip-header .link-btn--back"), `${where} Zurück`);
  assertHits(await hitBoxes(page, ".trip-header .icon-btn"), `${where} Karte/Einstellungen`);
  assertHits(await hitBoxes(page, ".day-chip"), `${where} Tag-Chips`);

  await page.click('[data-action="back"]');
  await page.waitForSelector(".screen--urlaube");
  assertHits(await hitBoxes(page, ".top-bar__actions .icon-btn"), `${where} Übersicht`);

  await page.click('.top-bar__actions [data-action="settings"]');
  await waitSheetReady(page, "global-settings-sheet");
  const closeBox = await page.locator('[data-testid="global-settings-sheet"] .sheet__close').boundingBox();
  const headerBox = await page.locator('[data-testid="global-settings-sheet"] .sheet__header').boundingBox();
  assert(closeBox && closeBox.width >= 44 && closeBox.height >= 44, `${where}: Schließen ${closeBox?.width}x${closeBox?.height}`);
  assert(closeBox.x + closeBox.width >= headerBox.x + headerBox.width - 12, `${where}: Schließen nicht rechts`);
  assert(closeBox.y <= headerBox.y + 8, `${where}: Schließen nicht oben`);
  assert((await page.locator('[data-testid="global-settings-sheet"] .sheet-handle').count()) === 1, `${where}: Einstellungen ohne Griff`);
  await pullClosed(page, "global-settings-sheet");
  await page.click('.top-bar__actions [data-action="settings"]');
  await waitSheetReady(page, "global-settings-sheet");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[data-testid="global-settings-sheet"]'));

  seedPlaces(state, tripId);
  await page.evaluate((id) => {
    location.hash = `#/urlaub/${id}`;
  }, tripId);
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.reload();
  await page.waitForSelector(`[data-day="${DAY}"]`);
  await page.click(`[data-day="${DAY}"]`);
  await page.waitForSelector('[data-action="edit-place"]');
  await page.waitForSelector('[data-action="add-note"]');
  assertHits(await hitBoxes(page, ".qa__btn"), `${where} Bearbeiten/Fotos/Kamera`);
  assertHits(await hitBoxes(page, '[data-action="add-note"]'), `${where} + Notiz`);

  await page.click('[data-footer-action="note"]');
  await waitSheetReady(page, "note-sheet");
  await page.fill('[data-role="text"]', "Hallo See");
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="confirm-discard-note"]');
  assert((await page.locator('[data-role="text"]').inputValue()) === "Hallo See", `${where}: Escape löscht die Notiz`);
  await page.click('[data-testid="confirm-discard-note"] [data-action="cancel"]');
  assert((await page.locator('[data-role="text"]').inputValue()) === "Hallo See", `${where}: Text nach Abbrechen weg`);
  await page.click('[data-action="change-place"]');
  await page.waitForSelector('[data-testid="note-place-sheet"]');
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[data-testid="note-place-sheet"]'));
  assert((await page.locator('[data-testid="note-sheet"]').count()) === 1, `${where}: Escape schließt die Notiz mit`);
  await page.fill('[data-role="text"]', "");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[data-testid="note-sheet"]'));

  await page.click('[data-footer-action="note"]');
  await waitSheetReady(page, "note-sheet");
  await pullClosed(page, "note-sheet");

  await openAddPlace(page);
  assert((await page.locator('[data-testid="add-place-only"]').isDisabled()) === true, `${where}: Nur Ort ohne Uhrzeit aktiv`);
  const timeInLabel = await page.evaluate(() => Boolean(document.querySelector('[data-testid="add-place-time"]')?.closest("label")));
  assert(timeInLabel === false, `${where}: Uhrzeit steckt im Label`);
  assert((await page.locator('label[for="add-place-time"]').count()) === 1, `${where}: Uhrzeit ohne for`);
  await page.click('[data-testid="add-place-part"][data-part="vormittag"]');
  assert((await page.locator('[data-testid="add-place-only"]').isDisabled()) === false, `${where}: Nur Ort bleibt gesperrt`);
  assertHits(await hitBoxes(page, '[data-testid="add-place-part"]'), `${where} Tageszeit`);
  assertHits(await hitBoxes(page, '[data-testid="add-place-cancel"]'), `${where} Abbrechen`);
  const actionBoxes = [
    ...(await hitBoxes(page, '[data-testid="add-place-next"]')),
    ...(await hitBoxes(page, '[data-testid="add-place-only"]')),
    ...(await hitBoxes(page, '[data-testid="add-place-cancel"]')),
  ];
  for (let i = 0; i < actionBoxes.length; i += 1) {
    for (let j = i + 1; j < actionBoxes.length; j += 1) {
      assert(!overlaps(actionBoxes[i], actionBoxes[j]), `${where}: Aktionsbuttons überlappen`);
    }
  }

  await page.evaluate(async () => {
    const { showWarnToast } = await import("./js/toast.js");
    showWarnToast("Hinweis über dem Sheet");
  });
  await page.waitForSelector('[data-testid="app-toast"]');
  await page.waitForFunction(() => {
    const toast = document.querySelector('[data-testid="app-toast"]').getBoundingClientRect();
    const sheet = document.querySelector('[data-testid="add-place-sheet"]').getBoundingClientRect();
    const buttons = ["add-place-next", "add-place-only", "add-place-cancel"].map((id) =>
      document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect()
    );
    const hits = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    const anchor = document.getElementById("toast-root")?.dataset.toastAnchor;
    return (anchor === "above-sheet" || anchor === "top") && toast.bottom <= sheet.top + 2 && buttons.every((btn) => !hits(toast, btn));
  });
  await pullClosed(page, "add-place-sheet");

  await openAddPlace(page);
  await page.click('[data-testid="add-place-part"][data-part="vormittag"]');
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[data-testid="add-place-sheet"]'));

  await openAddPlace(page);
  await page.fill('[data-testid="add-place-name"]', "Uferweg");
  await page.click('[data-testid="add-place-part"][data-part="vormittag"]');
  const before = { ...state.readCounts };
  const postsBefore = state.waypointPosts;
  await page.click('[data-testid="add-place-only"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Ort angelegt"));
  assert(state.readsAtInsert.notes === before.notes, `${where}: Nur Ort liest Notizen`);
  assert(state.readsAtInsert.media === before.media, `${where}: Nur Ort liest Fotos`);
  assert(state.readsAtInsert.waypoints === before.waypoints, `${where}: Nur Ort liest Orte vor dem Speichern`);
  assert(state.waypointPosts === postsBefore + 1, `${where}: Nur Ort speichert nicht`);
  assert(
    state.waypoints.filter((row) => row.title === "Uferweg" && !row.deleted_at).length === 1,
    `${where}: Uferweg fehlt`
  );

  state.abortGet.add("notes");
  state.abortGet.add("media");
  await openAddPlace(page);
  await page.fill('[data-testid="add-place-name"]', "Steg");
  await page.click('[data-testid="add-place-part"][data-part="vormittag"]');
  await page.click('[data-testid="add-place-next"]');
  await page.waitForSelector('[data-testid="add-place-load-hint"]', { timeout: 8000 });
  const hint = await page.locator('[data-testid="add-place-load-hint"]').innerText();
  assert(hint.includes("Fotos und Notizen konnten nicht geladen werden."), `${where}: Hinweis «${hint}»`);
  assert((await page.locator('[data-testid="add-place-reload"]').count()) === 1, `${where}: Erneut laden fehlt`);
  const toastText = (await page.locator('[data-testid="app-toast"]').count())
    ? await page.locator('[data-testid="app-toast"]').innerText()
    : "";
  assert(!toastText.includes("konnte nicht angelegt"), `${where}: irreführender Toast «${toastText}»`);
  assert((await page.locator('[data-testid="add-media-save"]').innerText()).includes("Ort ohne Fotos speichern"), `${where}: Speichern ohne Fotos fehlt`);
  await page.click('[data-testid="add-media-save"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Steg"));
  assert(state.waypoints.some((row) => row.title === "Steg" && !row.deleted_at), `${where}: Steg nicht gespeichert`);
  state.abortGet.clear();

  for (const kind of ["assign", "caption", "move", "target"]) {
    const testId =
      kind === "assign"
        ? "photo-assign-sheet"
        : kind === "caption"
          ? "photo-caption-sheet"
          : kind === "move"
            ? "photo-move-sheet"
            : "photo-target-sheet";
    await openSheet(page, kind, tripId);
    await pullClosed(page, testId);
    await openSheet(page, kind, tripId);
    await waitSheetReady(page, testId);
    await page.keyboard.press("Escape");
    await page.waitForFunction((id) => !document.querySelector(`[data-testid="${id}"]`), testId);
  }

  await page.evaluate((id) => {
    location.hash = `#/urlaub/${id}/tagebuch`;
  }, tripId);
  await page.waitForSelector('[data-testid="diary-source"]');
  await page.waitForTimeout(300);
  assert(state.recaps.filter((row) => row.status === "notes").length === 0, `${where}: leeres Tagebuch legt einen Eintrag an`);
  await page.fill('[data-testid="diary-source"]', "Montag\nAm See.");
  await page.waitForTimeout(1200);
  const notes = state.recaps.filter((row) => row.kind === "diary" && row.status === "notes" && !row.deleted_at);
  assert(notes.length === 1, `${where}: Notizen ${notes.length}`);
  assert(notes[0].source_text.includes("Am See"), `${where}: Text «${notes[0].source_text}»`);
  assert(state.recapInserts === 1, `${where}: ${state.recapInserts} Inserts`);
  await page.reload();
  await page.waitForSelector('[data-testid="diary-source"], [data-testid="login-screen"]');
  if (await page.locator('[data-testid="login-screen"]').count()) {
    await page.fill('input[name="email"]', "test@example.com");
    await page.click('form[data-step="email"] button[type="submit"]');
    await page.fill('input[name="otp"]', "123456");
    await page.click('form[data-step="otp"] button[type="submit"]');
    await page.evaluate((id) => {
      location.hash = `#/urlaub/${id}/tagebuch`;
    }, tripId);
  }
  await page.waitForSelector('[data-testid="diary-source"]');
  assert((await page.locator('[data-testid="diary-source"]').inputValue()).includes("Am See"), `${where}: Text nach Neuladen weg`);
  await page.fill('[data-testid="diary-source"]', "Montag\nAm See und im Hafen.");
  await page.waitForTimeout(1200);
  const again = state.recaps.filter((row) => row.kind === "diary" && row.status === "notes" && !row.deleted_at);
  assert(again.length === 1, `${where}: zweiter Notiz-Eintrag`);
  assert(state.recapInserts === 1, `${where}: Unique-Index umgangen (${state.recapInserts})`);
  assert(again[0].source_text.includes("Hafen"), `${where}: Update fehlt`);

  state.failRecapWrite = true;
  await page.fill('[data-testid="diary-source"]', "Montag\nNur lokal.");
  await page.waitForTimeout(1200);
  await page.waitForSelector('[data-testid="diary-save-hint"]');
  const failToast = (await page.locator('[data-testid="app-toast"]').count())
    ? await page.locator('[data-testid="app-toast"]').innerText()
    : "";
  assert(!failToast.includes("nicht"), `${where}: Toast bei Speicherfehler «${failToast}»`);
  const local = await page.evaluate((id) => localStorage.getItem(`vr-diary-source:${id}`), tripId);
  assert(local && local.includes("Nur lokal"), `${where}: lokaler Zwischenspeicher fehlt`);
  state.failRecapWrite = false;
}

async function runSuite(browserType, baseUrl, label, viewport) {
  const browser = await browserType.launch();
  const context = await browser.newContext({
    viewport,
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  const state = createMockSupabaseState();
  await installRoutes(page, state);
  const where = `${label} ${viewport.width}x${viewport.height}`;
  try {
    await page.goto(baseUrl);
    await runFlows(page, state, where);
    const unexpected = pageErrors.filter(
      (err) => !err.includes("access control checks") && !err.includes("Load failed") && !err.includes("Failed to fetch")
    );
    assert(!unexpected.length, `${where}: Seitenfehler ${unexpected.join(" | ")}`);
    console.log(`Playwright 64 Ort/Sheets OK (${where}, Build 65)`);
  } finally {
    await browser.close();
  }
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
console.log("Playwright 64 Ort/Sheets OK (Build 65)");
