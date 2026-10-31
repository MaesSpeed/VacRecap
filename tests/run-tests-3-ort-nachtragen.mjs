import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const DAY = "2026-10-26";
const OTHER = "2026-10-27";
const USER = "11111111-1111-1111-1111-111111111111";
const OTHER_USER = "22222222-2222-2222-2222-222222222222";

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

function placeRow(id, tripId, day, title, iso, coords = { lat: 45.76, lng: 10.81 }) {
  return {
    id,
    trip_id: tripId,
    day,
    visited_at: iso,
    lat: coords.lat,
    lng: coords.lng,
    accuracy_m: 8,
    title,
    is_soft: false,
    source: "manual",
    deleted_at: null,
    created_at: iso,
    updated_at: iso,
    created_by: USER,
  };
}

function photoRow(id, tripId, placeId, day, iso, author = USER, takenAt = iso) {
  return {
    id,
    trip_id: tripId,
    waypoint_id: placeId,
    day,
    taken_at: takenAt,
    kind: "photo",
    storage_path: `orig/${id}.jpg`,
    thumb_path: `${id}.jpg`,
    mime: "image/jpeg",
    upload_status: "uploaded",
    deleted_at: null,
    created_at: iso,
    updated_at: iso,
    created_by: author,
  };
}

function noteRow(id, tripId, placeId, day, body, author = USER) {
  const iso = `${day}T12:00:00.000Z`;
  return {
    id,
    trip_id: tripId,
    waypoint_id: placeId,
    day,
    body,
    deleted_at: null,
    created_at: iso,
    updated_at: iso,
    created_by: author,
  };
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
  let role = "editor";
  let failNextWaypoint = false;
  let waypointDelay = 0;
  let waypointAttempts = 0;
  let waypointInserts = 0;
  let geocodeMode = "fail";
  let geocodeDelay = 0;

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
  function sendRows(rows, headers) {
    const accept = headers.accept || "";
    if (accept.includes("application/vnd.pgrst.object+json")) {
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
    get role() {
      return role;
    },
    set role(value) {
      role = value;
    },
    get failNextWaypoint() {
      return failNextWaypoint;
    },
    set failNextWaypoint(value) {
      failNextWaypoint = Boolean(value);
    },
    get waypointDelay() {
      return waypointDelay;
    },
    set waypointDelay(value) {
      waypointDelay = Number(value) || 0;
    },
    get waypointAttempts() {
      return waypointAttempts;
    },
    get waypointInserts() {
      return waypointInserts;
    },
    get geocodeMode() {
      return geocodeMode;
    },
    set geocodeMode(value) {
      geocodeMode = value;
    },
    get geocodeDelay() {
      return geocodeDelay;
    },
    set geocodeDelay(value) {
      geocodeDelay = Number(value) || 0;
    },
    handleAuth(url, method) {
      const pathName = url.pathname;
      if (pathName.endsWith("/otp") && method === "POST") return { status: 200, json: {} };
      if (pathName.endsWith("/verify") && method === "POST") return { status: 200, json: session };
      if (pathName.endsWith("/token") && method === "POST") return { status: 200, json: session };
      if (pathName.endsWith("/user") && method === "GET") return { status: 200, json: session.user };
      return { status: 404, json: {} };
    },
    handleStorage(url, method, body) {
      const pathName = url.pathname;
      if (pathName.includes("/object/sign/") && method === "POST") {
        let payload = {};
        try {
          payload = JSON.parse(body || "{}");
        } catch {
          payload = {};
        }
        const paths = Array.isArray(payload.paths) ? payload.paths : [];
        return {
          status: 200,
          json: paths.map((one) => ({ error: null, path: one, signedURL: `/object/sign/mock?token=${encodeURIComponent(one)}` })),
        };
      }
      return { status: 404, json: {} };
    },
    async handleRest(url, method, body, headers) {
      const table = url.pathname.split("/").filter(Boolean).pop();
      if (table === "trips") {
        if (method === "POST" || method === "PATCH") {
          return { status: 201, json: represent(upsert(trips, JSON.parse(body || "{}")), headers) };
        }
        if (method === "GET") return sendRows(applyFilters(trips, url), headers);
      }
      if (table === "waypoints" && (method === "POST" || method === "PUT")) {
        waypointAttempts += 1;
        if (failNextWaypoint) {
          failNextWaypoint = false;
          return { status: 500, json: { message: "network", code: "500" } };
        }
        if (waypointDelay) await new Promise((resolve) => setTimeout(resolve, waypointDelay));
        waypointInserts += 1;
        return { status: 201, json: represent(upsert(waypoints, JSON.parse(body || "{}")), headers) };
      }
      if (table === "waypoints" && method === "PATCH") {
        const rows = applyFilters(waypoints, url);
        const patch = JSON.parse(body || "{}");
        if (!rows.length) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
        for (const row of rows) Object.assign(row, patch);
        return sendRows(rows, headers);
      }
      if (table === "waypoints" && method === "GET") return sendRows(applyFilters(waypoints, url), headers);
      if (table === "notes" && (method === "POST" || method === "PUT" || method === "PATCH")) {
        return { status: 201, json: represent(upsert(notes, JSON.parse(body || "{}")), headers) };
      }
      if (table === "notes" && method === "GET") return sendRows(applyFilters(notes, url), headers);
      if (table === "media" && method === "GET") return sendRows(applyFilters(media, url), headers);
      if (table === "media" && method === "PATCH") {
        const rows = applyFilters(media, url);
        const patch = JSON.parse(body || "{}");
        if (!rows.length) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
        const createdBy = rows[0].created_by;
        Object.assign(rows[0], patch, { created_by: createdBy });
        return sendRows([rows[0]], headers);
      }
      if (table === "trip_members" && method === "GET") {
        return { status: 200, json: [{ role, trip_id: url.searchParams.get("trip_id")?.replace(/^eq\./, "") || "", user_id: USER }] };
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
    let result;
    if (url.pathname.includes("/auth/v1/")) result = state.handleAuth(url, req.method(), req.postData());
    else if (url.pathname.includes("/storage/v1/")) result = state.handleStorage(url, req.method(), req.postData());
    else if (url.pathname.includes("/rest/v1/")) result = await state.handleRest(url, req.method(), req.postData(), req.headers());
    else result = { status: 404, json: {} };
    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      headers: corsHeaders(req),
      body: result.json == null ? "" : JSON.stringify(result.json),
    });
  });
  await page.context().route("**/nominatim.openstreetmap.org/**", async (route) => {
    if (state.geocodeDelay) await new Promise((resolve) => setTimeout(resolve, state.geocodeDelay));
    if (state.geocodeMode === "fail") {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "down" }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        name: "Spiaggia Paina",
        address: { road: "Via Gardesana", town: "Malcesine" },
      }),
    });
  });
  await page.context().route("**/tile.openstreetmap.org/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: TINY_PNG })
  );
  await page.context().route("**/routing.openstreetmap.de/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: "Ok", routes: [] }) })
  );
}

function seedTrip(state, tripId) {
  state.waypoints.push(
    placeRow("p-hafen", tripId, DAY, "Hafen Malcesine", "2026-10-26T19:30:00.000Z", { lat: 45.77, lng: 10.812 }),
    placeRow("p-hotel", tripId, DAY, "Hotel Lido", "2026-10-26T17:10:00.000Z", { lat: 45.758, lng: 10.808 }),
    placeRow("p-ohne", tripId, DAY, "Ohne Ort", "2026-10-26T12:00:00.000Z", { lat: null, lng: null }),
    placeRow("p-burg", tripId, OTHER, "Burg Limone", "2026-10-27T11:00:00.000Z", { lat: 45.82, lng: 10.79 })
  );
  state.media.push(
    photoRow("m-timed", tripId, "p-ohne", DAY, "2026-10-26T12:00:00.000Z", USER, "2026-10-26T09:40:00.000Z"),
    photoRow("m-notime", tripId, "p-ohne", DAY, "2026-10-26T12:00:00.000Z", USER, null),
    photoRow("m-fremd", tripId, "p-hotel", DAY, "2026-10-26T17:12:00.000Z", OTHER_USER),
    photoRow("m-other", tripId, "p-burg", OTHER, "2026-10-27T11:05:00.000Z")
  );
  state.notes.push(
    noteRow("n-own", tripId, "p-ohne", DAY, "Erster Sprung in den See, Wasser 19 Grad!"),
    noteRow("n-fremd", tripId, "p-hotel", DAY, "Fremde Hotelnotiz", OTHER_USER),
    noteRow("n-other", tripId, "p-burg", OTHER, "Notiz vom nächsten Tag")
  );
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

async function openDayMap(page) {
  await page.click('[data-action="map"]');
  await page.waitForSelector('[data-testid="map-screen"]');
  await page.click(`[data-segment="${DAY}"]`);
  await page.waitForFunction(
    (day) => document.querySelector(`[data-segment="${day}"]`)?.getAttribute("aria-selected") === "true",
    DAY
  );
  await page.waitForFunction(() => document.querySelectorAll(".map-marker--hard").length >= 2);
}

async function tapMap(page) {
  const point = await page.evaluate(() => {
    const map = window.__vacrecapMap;
    map.invalidateSize();
    const size = map.getSize();
    const target = map.containerPointToLatLng([Math.round(size.x * 0.62), Math.round(size.y * 0.18)]);
    const pixel = map.latLngToContainerPoint(target);
    return { x: pixel.x, y: pixel.y };
  });
  await page.locator(".map-canvas").click({ position: { x: Math.max(8, point.x), y: Math.max(8, point.y) } });
}

async function waitSheetReady(page) {
  await page.waitForSelector('[data-testid="add-place-sheet"]');
  await page.waitForFunction(() => !document.querySelector(".sheet--input-blocked"));
}

function livePlace(state, title) {
  return state.waypoints.find((row) => row.title === title && !row.deleted_at);
}

async function chooseTime(page) {
  await page.click('[data-testid="add-place-part"][data-part="morgens"]');
  assert((await page.locator('[data-testid="add-place-time"]').inputValue()) === "08:00", "Morgens setzt nicht 08:00");
  await page.click('[data-testid="add-place-part"][data-part="vormittag"]');
  assert((await page.locator('[data-testid="add-place-time"]').inputValue()) === "10:00", "Vormittag setzt nicht 10:00");
  await page.click('[data-testid="add-place-part"][data-part="mittag"]');
  assert((await page.locator('[data-testid="add-place-time"]').inputValue()) === "12:00", "Mittag setzt nicht 12:00");
  await page.click('[data-testid="add-place-part"][data-part="nachmittag"]');
  assert((await page.locator('[data-testid="add-place-time"]').inputValue()) === "15:00", "Nachmittag setzt nicht 15:00");
  assert((await page.locator('[data-testid="add-place-part"][data-part="nachmittag"]').getAttribute("aria-pressed")) === "true", "Nachmittag nicht gewählt");
  await page.click('[data-testid="add-place-part"][data-part="abend"]');
  assert((await page.locator('[data-testid="add-place-time"]').inputValue()) === "18:00", "Abend setzt nicht 18:00");
  await page.click('[data-testid="add-place-part"][data-part="nachmittag"]');
  await page.locator('[data-testid="add-place-time"]').fill("15:30");
  assert((await page.locator('[data-testid="add-place-time"]').inputValue()) === "15:30", "Uhrzeitfeld verfeinert nicht");
  assert(
    (await page.locator('[data-testid="add-place-part"][data-part="nachmittag"]').getAttribute("aria-pressed")) === "true",
    "Tageszeit-Chip fällt nach der Verfeinerung weg"
  );
  const hint = await page.locator('[data-testid="add-place-time-hint"]').innerText();
  assert(hint.includes("einsortiert"), `Hinweis nach der Uhrzeit: ${hint}`);
}

async function pickMedia(page, label) {
  await page.click('[data-testid="add-place-next"]');
  await page.waitForSelector('[data-testid="add-media-sheet"]');
  await page.waitForSelector('[data-testid="add-media-photo"][data-media-id="m-notime"]');
  assert((await page.locator('[data-testid="add-media-photo"][data-media-id="m-notime"]').getAttribute("aria-pressed")) === "true", `${label}: Foto ohne Zeit nicht vorausgewählt`);
  assert((await page.locator('[data-testid="add-media-photo"][data-media-id="m-timed"]').getAttribute("aria-pressed")) === "true", `${label}: Foto mit Zeit nicht vorausgewählt`);
  assert((await page.locator('[data-testid="add-media-note"][data-note-id="n-own"]').getAttribute("aria-pressed")) === "true", `${label}: Notiz nicht vorausgewählt`);
  const foreign = page.locator('[data-testid="add-media-photo"][data-media-id="m-fremd"]');
  assert(await foreign.isDisabled(), `${label}: fremdes Foto ist wählbar`);
  await foreign.click({ force: true });
  assert((await foreign.getAttribute("aria-pressed")) === "false", `${label}: fremdes Foto wurde gewählt`);
  assert((await page.locator('[data-testid="add-media-note"][data-note-id="n-fremd"]').isDisabled()) === true, `${label}: fremde Notiz ist wählbar`);
  assert((await page.locator('[data-testid="add-media-photo"][data-media-id="m-other"]').count()) === 0, `${label}: anderer Tag schon sichtbar`);
  await page.click('[data-testid="add-media-more"]');
  await page.waitForSelector('[data-testid="add-media-photo"][data-media-id="m-other"]');
  await page.click('[data-testid="add-media-photo"][data-media-id="m-other"]');
  await page.click('[data-testid="add-media-note"][data-note-id="n-other"]');
  assert((await page.locator('[data-testid="add-media-photo"][data-media-id="m-other"]').getAttribute("aria-pressed")) === "true", `${label}: Foto vom anderen Tag nicht gewählt`);
  assert((await page.locator('[data-testid="add-media-note"][data-note-id="n-other"]').getAttribute("aria-pressed")) === "true", `${label}: Notiz vom anderen Tag nicht gewählt`);
  const count = await page.locator('[data-testid="add-media-count"]').innerText();
  assert(count.includes("3 Fotos") && count.includes("2 Notizen"), `${label}: Zähler «${count}»`);
}

function placed(state) {
  return state.waypoints.filter((row) => row.title === "Spiaggia Paina" && !row.deleted_at);
}

async function saveOnce(page, state, label) {
  const before = state.waypointInserts;
  state.failNextWaypoint = true;
  await page.click('[data-testid="add-media-save"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("erneut"));
  const toast = await page.evaluate(() => document.querySelector('[data-testid="app-toast"]')?.innerText || "");
  assert(/angelegt|erneut|Verbindung|offline/i.test(toast), `${label}: Netzwerkfehler ohne Meldung «${toast}»`);
  assert(await page.locator('[data-testid="add-media-sheet"]').count(), `${label}: Sheet nach Fehler weg`);
  assert(state.waypointInserts === before, `${label}: Fehler hat einen Ort angelegt`);
  assert(!page.isClosed(), `${label}: Seite nach dem Fehler zu`);
  await page.evaluate(async () => {
    const { dismissActiveToast } = await import("./js/toast.js");
    dismissActiveToast();
  });

  state.waypointDelay = 700;
  const attemptsBefore = state.waypointAttempts;
  await page.evaluate(() => {
    const button = document.querySelector('[data-testid="add-media-save"]');
    button.click();
    button.click();
  });
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Ort angelegt"));
  state.waypointDelay = 0;
  assert(state.waypointAttempts === attemptsBefore + 1, `${label}: Doppeltipp hat ${state.waypointAttempts - attemptsBefore} Anfragen geschickt`);
  assert(placed(state).length === 1, `${label}: ${placed(state).length} Orte statt einem`);
}

function assertAssignment(state, label, { undone = false } = {}) {
  const place = placed(state)[0];
  const notime = state.media.find((row) => row.id === "m-notime");
  const timed = state.media.find((row) => row.id === "m-timed");
  const other = state.media.find((row) => row.id === "m-other");
  const foreign = state.media.find((row) => row.id === "m-fremd");
  const ownNote = state.notes.find((row) => row.id === "n-own");
  const otherNote = state.notes.find((row) => row.id === "n-other");
  const ohne = state.waypoints.find((row) => row.id === "p-ohne");
  if (undone) {
    assert(!place, `${label}: Rückgängig lässt den Ort stehen`);
    assert(notime.waypoint_id === "p-ohne" && notime.taken_at == null, `${label}: Zeitübernahme nicht zurück`);
    assert(timed.waypoint_id === "p-ohne" && timed.taken_at === "2026-10-26T09:40:00.000Z", `${label}: eigene Fotozeit verändert`);
    assert(other.waypoint_id === "p-burg" && other.day === OTHER, `${label}: anderes Foto nicht zurück`);
    assert(ownNote.waypoint_id === "p-ohne" && ownNote.day === DAY, `${label}: Notiz nicht zurück`);
    assert(otherNote.waypoint_id === "p-burg", `${label}: andere Notiz nicht zurück`);
    assert(!ohne.deleted_at, `${label}: Ohne Ort bleibt gelöscht`);
    assert(foreign.waypoint_id === "p-hotel", `${label}: fremdes Foto verschoben`);
    return;
  }
  assert(place, `${label}: Ort fehlt`);
  assert(place.day === DAY, `${label}: Tag ${place.day}`);
  const visited = new Date(place.visited_at);
  assert(visited.getHours() === 15 && visited.getMinutes() === 30, `${label}: Uhrzeit ${place.visited_at}`);
  assert(place.lat != null && place.lng != null, `${label}: Ort ohne Position`);
  assert(notime.waypoint_id === place.id && notime.day === DAY, `${label}: Foto ohne Zeit nicht am Ort`);
  assert(notime.taken_at === place.visited_at, `${label}: Foto ohne eigene Zeit behält keine Ortszeit (${notime.taken_at} vs ${place.visited_at})`);
  assert(timed.waypoint_id === place.id && timed.taken_at === "2026-10-26T09:40:00.000Z", `${label}: Foto mit eigener Zeit überschrieben`);
  assert(other.waypoint_id === place.id && other.day === DAY, `${label}: Foto vom anderen Tag nicht übernommen`);
  assert(ownNote.waypoint_id === place.id && ownNote.day === DAY, `${label}: Notiz nicht am Ort`);
  assert(otherNote.waypoint_id === place.id && otherNote.day === DAY, `${label}: Notiz vom anderen Tag nicht übernommen`);
  assert(ohne.deleted_at, `${label}: leeres Ohne Ort bleibt`);
  assert(foreign.waypoint_id === "p-hotel", `${label}: fremdes Foto mitverschoben`);
}

async function markerNumber(page, place) {
  return page.evaluate(({ lat, lng }) => {
    const map = window.__vacrecapMap;
    let found = null;
    map.eachLayer((layer) => {
      const html = layer?.options?.icon?.options?.html || "";
      const num = /<span>(\d+)<\/span>/.exec(html);
      if (!num || typeof layer.getLatLng !== "function") return;
      const at = layer.getLatLng();
      if (Math.abs(at.lat - lat) < 0.0002 && Math.abs(at.lng - lng) < 0.0002) found = Number(num[1]);
    });
    return found;
  }, { lat: Number(place.lat), lng: Number(place.lng) });
}

async function runFlows(page, state, label) {
  await openDayMap(page);
  assert(await page.locator('[data-testid="map-tap-hint"]').isVisible(), `${label}: Hinweis-Pille fehlt`);
  assert((await page.locator('[data-testid="map-tap-hint"]').innerText()).includes("Tippe auf die Stelle"), `${label}: Hinweistext`);

  state.geocodeMode = "fail";
  state.geocodeDelay = 0;
  await tapMap(page);
  await waitSheetReady(page);
  await page.waitForSelector('[data-testid="map-drop-pin"]');
  assert((await page.locator('[data-testid="add-place-day"]').innerText()).includes("Mo 26."), `${label}: Tag im Sheet`);
  assert((await page.locator('[data-testid="add-place-day"]').innerText()).includes("Anreise"), `${label}: Tagesrolle`);
  await page.waitForFunction(() => document.querySelector('[data-testid="add-place-name"]')?.dataset.geocode === "failed");
  const failed = page.locator('[data-testid="add-place-name"]');
  assert((await failed.getAttribute("placeholder")) === "Name des Ortes", `${label}: Platzhalter bei Fehler`);
  assert(!(await failed.isDisabled()), `${label}: Name bei Fehler gesperrt`);
  await failed.fill("Zwischendrin");
  assert(await page.locator('[data-testid="add-place-next"]').isDisabled(), `${label}: Weiter ohne Uhrzeit`);
  await page.click('[data-testid="add-place-cancel"]');
  await page.waitForSelector('[data-testid="add-place-sheet"]', { state: "detached" });
  assert((await page.locator('[data-testid="map-drop-pin"]').count()) === 0, `${label}: Pin bleibt nach Abbrechen`);

  state.geocodeMode = "ok";
  state.geocodeDelay = 1200;
  await tapMap(page);
  await page.waitForSelector('[data-testid="add-place-name"]');
  const loading = await page.locator('[data-testid="add-place-name"]').getAttribute("placeholder");
  assert(loading === "Adresse wird gesucht…", `${label}: Platzhalter beim Laden «${loading}»`);
  await waitSheetReady(page);
  await page.waitForFunction(() => document.querySelector('[data-testid="add-place-name"]')?.value === "Spiaggia Paina");
  const suggestion = await page.locator('[data-testid="add-place-suggestion"]').innerText();
  assert(suggestion.includes("Via Gardesana") && suggestion.includes("Malcesine"), `${label}: Adressvorschlag «${suggestion}»`);
  const name = page.locator('[data-testid="add-place-name"]');
  await name.fill("Spiaggia Paina Nord");
  await name.fill("Spiaggia Paina");
  assert((await name.inputValue()) === "Spiaggia Paina", `${label}: Name nicht änderbar`);
  state.geocodeDelay = 0;

  await chooseTime(page);
  await pickMedia(page, label);
  await saveOnce(page, state, label);
  const place = placed(state)[0];
  assertAssignment(state, label);
  await page.waitForFunction(() => document.querySelectorAll(".map-marker--hard").length >= 3);
  assert((await markerNumber(page, place)) === 1, `${label}: neuer Ort ist nicht Nummer 1`);
  const toast = await page.locator('[data-testid="app-toast"]').innerText();
  assert(toast.includes("Ort angelegt") && toast.includes("Spiaggia Paina"), `${label}: Snackbar «${toast}»`);
  assert(await page.locator('[data-testid="app-toast"] [data-action="undo"]').count(), `${label}: Rückgängig fehlt`);

  await page.click('[data-testid="app-toast"] [data-action="undo"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Wieder wie zuvor"));
  assertAssignment(state, `${label} undo`, { undone: true });
  await page.waitForFunction(() => document.querySelectorAll(".map-marker--hard").length === 2);

  state.geocodeMode = "ok";
  await tapMap(page);
  await waitSheetReady(page);
  await page.waitForFunction(() => document.querySelector('[data-testid="add-place-name"]')?.value === "Spiaggia Paina");
  await page.click('[data-testid="add-place-part"][data-part="nachmittag"]');
  await page.locator('[data-testid="add-place-time"]').fill("15:30");
  await page.click('[data-testid="add-place-next"]');
  await page.waitForSelector('[data-testid="add-media-more"]');
  await page.click('[data-testid="add-media-more"]');
  await page.click('[data-testid="add-media-photo"][data-media-id="m-other"]');
  await page.click('[data-testid="add-media-note"][data-note-id="n-other"]');
  await page.click('[data-testid="add-media-save"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Ort angelegt"));
  assertAssignment(state, `${label} erneut`);

  await page.click('[data-testid="map-screen"] [data-action="back"]');
  await page.waitForSelector('[data-testid="place-list"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="place-list"]')?.innerText || "").includes("Spiaggia Paina"));
  const titles = await page.locator(".oc__title").allInnerTexts();
  assert(!titles.some((title) => title.includes("Ohne Ort")), `${label}: Ohne Ort bleibt im Tag ${titles.join(" | ")}`);
  const hotelAt = titles.findIndex((title) => title.includes("Hotel Lido"));
  const newAt = titles.findIndex((title) => title.includes("Spiaggia Paina"));
  const hafenAt = titles.findIndex((title) => title.includes("Hafen"));
  assert(hafenAt >= 0 && hotelAt > hafenAt && newAt > hotelAt, `${label}: Reihenfolge ${titles.join(" | ")}`);
  const card = page.locator(".oc", { hasText: "Spiaggia Paina" });
  const meta = await card.locator(".oc__meta").innerText();
  assert(meta.includes("15:30"), `${label}: Meta ohne 15:30 «${meta}»`);
  assert(meta.includes("3 Fotos") && meta.includes("2 Notizen"), `${label}: Meta «${meta}»`);
  assert((await card.locator('[data-testid="place-new-badge"]').count()) === 1, `${label}: NEU fehlt`);

  state.role = "viewer";
  await page.evaluate(async () => {
    const { clearTripRoleCache } = await import("./js/trip-role.js");
    clearTripRoleCache();
  });
  await openDayMap(page);
  assert(await page.locator('[data-testid="map-tap-hint"]').isHidden(), `${label}: Betrachter sieht den Hinweis`);
  await tapMap(page);
  await page.waitForTimeout(400);
  assert((await page.locator('[data-testid="add-place-sheet"]').count()) === 0, `${label}: Betrachter legt einen Ort an`);
  assert(placed(state).length === 1, `${label}: Betrachter hat einen Ort gespeichert`);
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
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  const state = createMockSupabaseState();
  await installRoutes(page, state);
  const where = `${label} ${viewport.width}x${viewport.height}`;
  await page.goto(baseUrl);
  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  assert(Number(build) === 58, `${where}: Build ${build}`);
  const tripId = await loginAndOpen(page);
  seedTrip(state, tripId);
  await runFlows(page, state, where);
  const unexpected = pageErrors.filter((err) => !err.includes("access control checks") && !err.includes("Load failed") && !err.includes("Failed to fetch"));
  assert(!unexpected.length, `${where}: Seitenfehler ${unexpected.join(" | ")}`);
  await browser.close();
  console.log(`Playwright 3 Ort nachtragen OK (${where}, Build 58)`);
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
