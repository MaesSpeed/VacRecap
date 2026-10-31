import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const TODAY = "2026-10-30";
const OTHER = "2026-10-29";
const USER = "11111111-1111-1111-1111-111111111111";
const OTHER_USER = "22222222-2222-2222-2222-222222222222";

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

function placeRow(id, tripId, day, title, iso) {
  return {
    id,
    trip_id: tripId,
    day,
    visited_at: iso,
    lat: 45.76,
    lng: 10.81,
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

function photoRow(id, tripId, placeId, day, iso, author = USER) {
  return {
    id,
    trip_id: tripId,
    waypoint_id: placeId,
    day,
    taken_at: iso,
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
  const signBatches = [];
  const mediaPatches = [];
  let inflight = 0;
  let lastDone = 0;
  let mediaGets = 0;
  let failNextMediaPatch = false;

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
  return {
    trips,
    waypoints,
    notes,
    media,
    signBatches,
    mediaPatches,
    get inflight() {
      return inflight;
    },
    set inflight(value) {
      inflight = value;
    },
    get lastDone() {
      return lastDone;
    },
    set lastDone(value) {
      lastDone = value;
    },
    get mediaGets() {
      return mediaGets;
    },
    get failNextMediaPatch() {
      return failNextMediaPatch;
    },
    set failNextMediaPatch(value) {
      failNextMediaPatch = Boolean(value);
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
        if (Array.isArray(payload.paths)) {
          signBatches.push(payload.paths.length);
          return {
            status: 200,
            json: payload.paths.map((one) => ({
              error: null,
              path: one,
              signedURL: `/object/sign/mock?token=${encodeURIComponent(one)}`,
            })),
          };
        }
        signBatches.push(1);
        return { status: 200, json: { signedURL: "/object/sign/mock?token=1" } };
      }
      if (pathName.includes("/object/sign/mock") && method === "GET") {
        return { status: 200, raw: TINY_PNG, contentType: "image/png" };
      }
      return { status: 404, json: {} };
    },
    handleRest(url, method, body, headers) {
      const table = url.pathname.split("/").filter(Boolean).pop();
      const upsert = (list, row) => {
        const id = row.id || crypto.randomUUID();
        const hit = list.find((item) => item.id === id);
        const full = {
          created_by: USER,
          created_at: hit?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null,
          ...row,
          id,
        };
        if (hit) Object.assign(hit, full);
        else list.push(full);
        return full;
      };
      if (table === "trips") {
        if (method === "POST") return { status: 201, json: represent(upsert(trips, JSON.parse(body || "{}")), headers) };
        if (method === "GET") return { status: 200, json: applyFilters(trips, url) };
      }
      if (table === "waypoints" && method === "GET") return { status: 200, json: applyFilters(waypoints, url) };
      if (table === "notes" && method === "GET") return { status: 200, json: applyFilters(notes, url) };
      if (table === "media" && method === "GET") {
        mediaGets += 1;
        return { status: 200, json: applyFilters(media, url) };
      }
      if (table === "media" && method === "PATCH") {
        if (failNextMediaPatch) {
          failNextMediaPatch = false;
          return { status: 500, json: { message: "network" } };
        }
        const rows = applyFilters(media, url);
        const patch = JSON.parse(body || "{}");
        if (!rows[0]) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
        mediaPatches.push({ id: rows[0].id, patch });
        const createdBy = rows[0].created_by;
        Object.assign(rows[0], patch, { updated_at: patch.updated_at || new Date().toISOString(), created_by: createdBy });
        return { status: 200, json: represent(rows[0], headers) };
      }
      if (table === "trip_members" && method === "GET") {
        return { status: 200, json: [{ role: "owner", trip_id: "", user_id: USER }] };
      }
      return { status: 404, json: { message: "not found" } };
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

async function installSupabaseMocks(page, state) {
  await page.context().route(`**/${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders(req) });
      return;
    }
    const url = new URL(req.url());
    state.inflight += 1;
    let result;
    try {
      if (url.pathname.includes("/auth/v1/")) result = state.handleAuth(url, req.method(), req.postData());
      else if (url.pathname.includes("/storage/v1/")) result = state.handleStorage(url, req.method(), req.postData());
      else if (url.pathname.includes("/rest/v1/")) result = state.handleRest(url, req.method(), req.postData(), req.headers());
      else result = { status: 404, json: {} };
      if (result.raw) {
        await route.fulfill({
          status: result.status,
          contentType: result.contentType,
          headers: corsHeaders(req),
          body: result.raw,
        });
      } else {
        await route.fulfill({
          status: result.status,
          contentType: "application/json",
          headers: corsHeaders(req),
          body: result.json == null ? "" : JSON.stringify(result.json),
        });
      }
    } finally {
      state.inflight -= 1;
      state.lastDone = Date.now();
    }
  });
}

async function waitQuiet(state) {
  const start = Date.now();
  if (!state.lastDone) state.lastDone = start;
  while (Date.now() - start < 20000) {
    if (state.inflight === 0 && Date.now() - state.lastDone > 250) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Netz nicht ruhig (inflight ${state.inflight})`);
}

function seedTrip(state, tripId) {
  const rows = [
    placeRow("p-hafen", tripId, TODAY, "Hafen Malcesine", "2026-10-30T12:00:00.000Z"),
    placeRow("p-ufer", tripId, TODAY, "Uferpromenade", "2026-10-30T11:00:00.000Z"),
    placeRow("p-platz", tripId, TODAY, "Marktplatz", "2026-10-30T10:00:00.000Z"),
    placeRow("p-gasse", tripId, TODAY, "Alte Gasse", "2026-10-30T09:00:00.000Z"),
    placeRow("p-kirche", tripId, TODAY, "Kirche", "2026-10-30T08:00:00.000Z"),
    placeRow("p-markt", tripId, TODAY, "Wochenmarkt", "2026-10-30T07:00:00.000Z"),
    placeRow("p-steg", tripId, TODAY, "Bootssteg", "2026-10-30T06:30:00.000Z"),
    placeRow("p-amt", tripId, TODAY, "Hafenamt", "2026-10-30T06:00:00.000Z"),
    placeRow("p-oleander", tripId, TODAY, "Oleanderweg", "2026-10-30T05:30:00.000Z"),
    placeRow("p-zitrone", tripId, TODAY, "Zitronenhain", "2026-10-30T05:00:00.000Z"),
    placeRow("p-burg", tripId, OTHER, "Burg Limone", "2026-10-29T15:00:00.000Z"),
    placeRow("p-alt", tripId, OTHER, "Altstadt", "2026-10-29T09:00:00.000Z"),
  ];
  state.waypoints.push(...rows);
  state.media.push(
    photoRow("m-own-1", tripId, "p-hafen", TODAY, "2026-10-30T12:05:00.000Z"),
    photoRow("m-own-2", tripId, "p-hafen", TODAY, "2026-10-30T12:10:00.000Z"),
    photoRow("m-fremd", tripId, "p-hafen", TODAY, "2026-10-30T12:12:00.000Z", OTHER_USER),
    photoRow("m-burg", tripId, "p-burg", OTHER, "2026-10-29T15:10:00.000Z")
  );
}

async function loginAndOpen(page) {
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
  await page.click('[data-action="new"]');
  await page.fill('input[name="title"]', "Gardasee");
  await page.click('[data-action="pick-dates"]');
  await page.click('.calendar-day[data-date="2026-10-28"]');
  await page.click('.calendar-day[data-date="2026-10-30"]');
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForFunction(
    (day) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === day,
    TODAY
  );
  return page.locator(".screen--trip").getAttribute("data-vacation-id");
}

async function meta(page, placeId) {
  return page.locator(`[data-place-id="${placeId}"] .oc__meta`).innerText();
}

async function longPress(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  assert(box, `Langdruck-Ziel fehlt: ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
}

async function assertTouch(page, selector, label) {
  const box = await page.locator(selector).first().boundingBox();
  assert(box, `${label}: Element fehlt (${selector})`);
  assert(box.height >= 43.5 && box.width >= 43.5, `${label}: Ziel ${Math.round(box.width)}×${Math.round(box.height)} px`);
}

async function enterSelect(page) {
  await page.click('[data-testid="photo-select-start"]');
  await page.waitForSelector('[data-testid="photo-select-bar"]');
}

async function selectOwn(page, id) {
  await page.locator(`[data-testid="place-photo"][data-media-id="${id}"]`).click();
}

function patchIds(state) {
  return state.mediaPatches.map((entry) => entry.id);
}

async function runFlows(page, state, label) {
  await page.waitForFunction(() => {
    const root = document.querySelector("[data-page='current']");
    const photos = root?.querySelectorAll('[data-testid="place-photo"]').length || 0;
    return root?.innerText?.includes("Hafen Malcesine") && root.querySelector('[data-testid="photo-select-start"]') && photos >= 3;
  });
  await waitQuiet(state);
  const hafenMeta = await meta(page, "p-hafen");
  assert(hafenMeta.includes("3 Fotos"), `${label}: Hafen startet mit «${hafenMeta}»`);
  assert((await page.locator('[data-media-id="m-fremd"]').first().getAttribute("data-own")) === "0", `${label}: fremdes Foto ist wählbar markiert`);
  assert((await page.locator('[data-testid="place-photo"][data-media-id="m-own-1"]').getAttribute("data-own")) === "1", `${label}: eigenes Foto nicht markiert`);
  await assertTouch(page, '[data-testid="photo-select-start"]', `${label} Auswählen`);

  const patchesBefore = state.mediaPatches.length;
  await longPress(page, '[data-testid="place-photo"][data-media-id="m-own-1"]');
  await page.waitForSelector('[data-testid="photo-select-bar"]');
  assert((await page.locator('[data-testid="photo-select-count"]').innerText()).includes("1 ausgewählt"), `${label}: Langdruck wählt nicht`);
  assert((await page.locator('[data-testid="place-photo"][data-media-id="m-own-1"]').getAttribute("aria-pressed")) === "true", `${label}: Langdruck ohne Auswahlzustand`);
  await page.click('[data-testid="photo-select-exit"]');
  await page.waitForSelector('[data-testid="photo-select-bar"]', { state: "detached" });
  assert(state.mediaPatches.length === patchesBefore, `${label}: Beenden hat gespeichert`);
  assert((await meta(page, "p-hafen")).includes("3 Fotos"), `${label}: Beenden hat Fotos bewegt`);

  await enterSelect(page);
  await selectOwn(page, "m-own-1");
  assert((await page.locator('[data-testid="photo-select-count"]').innerText()).includes("1 ausgewählt"), `${label}: erstes Foto`);
  const getsBeforeCancel = state.mediaGets;
  await page.click('[data-testid="photo-move"]');
  await page.waitForSelector('[data-testid="photo-move-sheet"]');
  await assertTouch(page, '[data-testid="photo-move-day"]', `${label} Tag im Sheet`);
  await assertTouch(page, '[data-testid="photo-move-place"]', `${label} Ort im Sheet`);
  await assertTouch(page, '[data-testid="photo-move-cancel"]', `${label} Abbrechen`);
  await page.click(`[data-move-day="${OTHER}"]`);
  await page.waitForSelector('[data-move-place="p-burg"]');
  await page.click('[data-testid="photo-move-cancel"]');
  await page.waitForSelector('[data-testid="photo-move-sheet"]', { state: "detached" });
  assert(state.mediaPatches.length === patchesBefore, `${label}: Abbrechen hat verschoben`);
  assert(await page.locator('[data-testid="photo-select-bar"]').count(), `${label}: Abbrechen beendet die Auswahl`);
  assert((await meta(page, "p-hafen")).includes("3 Fotos"), `${label}: Abbrechen ändert den Ort`);
  assert(state.mediaGets === getsBeforeCancel, `${label}: Abbrechen lädt Fotos neu`);
  await page.click('[data-testid="photo-select-exit"]');

  await enterSelect(page);
  await assertTouch(page, '[data-testid="photo-select-exit"]', `${label} Beenden`);
  await assertTouch(page, '[data-testid="photo-move"]', `${label} Verschieben`);
  await page.locator('[data-testid="place-photo"][data-media-id="m-fremd"]').click({ force: true });
  await page.waitForSelector('[data-testid="app-toast"]');
  const foreignToast = await page.locator('[data-testid="app-toast"]').innerText();
  assert(foreignToast.includes("Nur eigene Fotos"), `${label}: Hinweis fremd «${foreignToast}»`);
  assert((await page.locator('[data-testid="photo-select-count"]').innerText()).includes("0 ausgewählt"), `${label}: fremdes Foto mitgezählt`);
  assert(await page.locator('[data-testid="photo-foreign-hint"]').count(), `${label}: Hinweis fehlt`);
  const moveDisabled = await page.locator('[data-testid="photo-move"]').isDisabled();
  assert(moveDisabled, `${label}: Verschieben ohne Auswahl aktiv`);
  await selectOwn(page, "m-own-1");
  await selectOwn(page, "m-own-2");
  assert((await page.locator('[data-testid="photo-select-count"]').innerText()).includes("2 ausgewählt"), `${label}: Mehrfachauswahl`);
  const shadow = await page.locator(".tile--selected").first().evaluate((el) => getComputedStyle(el).boxShadow);
  assert(shadow && shadow !== "none", `${label}: Auswahl nur bei Hover sichtbar`);
  await selectOwn(page, "m-own-2");
  assert((await page.locator('[data-testid="photo-select-count"]').innerText()).includes("1 ausgewählt"), `${label}: Abwählen`);
  await selectOwn(page, "m-own-2");
  assert((await page.locator('[data-testid="photo-select-count"]').innerText()).includes("2 ausgewählt"), `${label}: erneut wählen`);

  const scrollTop = await page.evaluate(() => {
    const el = document.querySelector("[data-page='current']");
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    const target = Math.min(80, max);
    el.scrollTop = target;
    return { top: el.scrollTop, max };
  });
  assert(scrollTop.max > 40 && scrollTop.top > 40, `${label}: Liste scrollt nicht (max ${scrollTop.max})`);
  const getsBeforeMove = state.mediaGets;
  const signsBeforeMove = state.signBatches.length;
  await page.evaluate((top) => {
    window.__scrolls = [];
    window.__scrollWatch = setInterval(() => {
      const el = document.querySelector("[data-page='current']");
      if (!el) return;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      const y = el.scrollTop;
      const clamped = Math.min(top, max);
      if (Math.abs(y - clamped) > 2 && y < top - 48) window.__scrolls.push(y);
    }, 16);
  }, scrollTop.top);
  await page.click('[data-testid="photo-move"]');
  await page.waitForSelector('[data-testid="photo-move-sheet"]');
  await page.locator('[data-move-place="p-ufer"]').click();
  await page.waitForFunction(() => {
    const ufer = document.querySelector('[data-place-id="p-ufer"] .oc__meta')?.textContent || "";
    const hafen = document.querySelector('[data-place-id="p-hafen"] .oc__meta')?.textContent || "";
    return ufer.includes("2 Fotos") && hafen.includes("1 Foto");
  });
  const scrollAfter = await page.evaluate(() => {
    clearInterval(window.__scrollWatch);
    const el = document.querySelector("[data-page='current']");
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    return { top: el.scrollTop, max, jumps: window.__scrolls || [] };
  });
  assert(scrollAfter.top === Math.min(scrollTop.top, scrollAfter.max), `${label}: Scrollsprung ${scrollTop.top} → ${scrollAfter.top} (max ${scrollAfter.max})`);
  assert(!scrollAfter.jumps.length, `${label}: Liste springt auf ${scrollAfter.jumps.join(",")}`);
  await page.waitForTimeout(400);
  assert(state.mediaGets === getsBeforeMove, `${label}: Verschieben lädt Fotos neu (${state.mediaGets - getsBeforeMove})`);
  assert(state.signBatches.length === signsBeforeMove, `${label}: Thumbnails neu signiert`);
  const moved = state.mediaPatches.slice(patchesBefore);
  assert(moved.length === 2, `${label}: ${moved.length} Patches statt 2`);
  for (const entry of moved) {
    assert(!("created_by" in entry.patch), `${label}: Autor im Patch ${JSON.stringify(entry.patch)}`);
    assert(entry.patch.waypoint_id === "p-ufer", `${label}: Ziel ${entry.patch.waypoint_id}`);
    assert(entry.patch.day === TODAY, `${label}: Tag ${entry.patch.day}`);
    const keys = Object.keys(entry.patch).sort();
    assert(keys.every((key) => ["day", "updated_at", "waypoint_id"].includes(key)), `${label}: Patch-Felder ${keys.join(",")}`);
  }
  assert(new Set(patchIds({ mediaPatches: moved })).size === 2, `${label}: nicht beide Fotos`);
  const rows = state.media.filter((row) => row.id === "m-own-1" || row.id === "m-own-2");
  assert(rows.every((row) => row.created_by === USER && row.waypoint_id === "p-ufer" && row.day === TODAY), `${label}: Zeile nach dem Verschieben`);
  assert((await page.locator('[data-place-id="p-ufer"] .th[data-media-id], [data-place-id="p-ufer"] [data-testid="place-photo"]').count()) > 0, `${label}: Ufer ohne Thumbnail`);
  await assertTouch(page, '[data-testid="app-toast"] [data-action="undo"]', `${label} Rückgängig`);

  const undoFrom = state.mediaPatches.length;
  await page.click('[data-testid="app-toast"] [data-action="undo"]');
  await page.waitForFunction(() => (document.querySelector('[data-place-id="p-hafen"] .oc__meta')?.textContent || "").includes("3 Fotos"));
  const undoPatches = state.mediaPatches.slice(undoFrom);
  assert(undoPatches.length === 2, `${label}: Undo-Patches ${undoPatches.length}`);
  assert(undoPatches.every((entry) => entry.patch.waypoint_id === "p-hafen" && entry.patch.day === TODAY), `${label}: Undo stellt nicht wieder her`);
  assert(!state.mediaPatches.slice(undoFrom).some((entry) => entry.id === "m-fremd" || entry.id === "m-burg"), `${label}: Undo bewegt fremde Fotos`);
  assert((await meta(page, "p-ufer")).includes("Foto") === false, `${label}: Ufer behält Fotos nach Undo «${await meta(page, "p-ufer")}»`);
  await waitQuiet(state);

  await enterSelect(page);
  await selectOwn(page, "m-own-1");
  const getsBeforeDay = state.mediaGets;
  const signsBeforeDay = state.signBatches.length;
  await page.click('[data-testid="photo-move"]');
  await page.click(`[data-move-day="${OTHER}"]`);
  await page.click('[data-move-place="p-burg"]');
  await page.waitForFunction(() => (document.querySelector('[data-place-id="p-hafen"] .oc__meta')?.textContent || "").includes("2 Fotos"));
  const dayPatch = state.mediaPatches.at(-1);
  assert(dayPatch?.id === "m-own-1" && dayPatch.patch.waypoint_id === "p-burg" && dayPatch.patch.day === OTHER, `${label}: anderer Tag ${JSON.stringify(dayPatch)}`);
  assert(state.media.find((row) => row.id === "m-own-1").day === OTHER, `${label}: Foto-Tag unverändert`);
  assert(state.mediaGets === getsBeforeDay, `${label}: Tageswechsel-Verschieben lädt neu`);
  assert(state.signBatches.length === signsBeforeDay, `${label}: Tageswechsel signiert neu`);
  const gaps = [];
  await page.evaluate((iso) => {
    window.__gaps = [];
    const sample = () => {
      const root = document.querySelector("[data-page='current']");
      if (root?.querySelector("[data-testid='day-skeleton']")) window.__gaps.push("skeleton");
    };
    document.querySelector(`[data-day="${iso}"]`).click();
    sample();
    window.__timer = setInterval(sample, 20);
  }, OTHER);
  await page.waitForFunction(() => {
    const root = document.querySelector("[data-page='current']");
    return root?.innerText?.includes("Burg Limone") && root.querySelector('[data-media-id="m-own-1"]');
  });
  await page.evaluate(() => clearInterval(window.__timer));
  gaps.push(...(await page.evaluate(() => window.__gaps || [])));
  assert(!gaps.length, `${label}: Zieltag zeigt Skeleton`);
  assert((await meta(page, "p-burg")).includes("2 Fotos"), `${label}: Burg «${await meta(page, "p-burg")}»`);
  assert(state.mediaGets === getsBeforeDay, `${label}: Zieltag lädt Fotos nach`);
  await page.click('[data-testid="app-toast"] [data-action="undo"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("bisherigen Ort"));
  await page.click(`[data-day="${TODAY}"]`);
  await page.waitForFunction(() => (document.querySelector('[data-place-id="p-hafen"] .oc__meta')?.textContent || "").includes("3 Fotos"));
  assert(state.media.find((row) => row.id === "m-own-1").waypoint_id === "p-hafen", `${label}: Undo über den Tag`);
  await waitQuiet(state);

  await enterSelect(page);
  await selectOwn(page, "m-own-1");
  state.failNextMediaPatch = true;
  await page.click('[data-testid="photo-move"]');
  await page.locator('[data-move-place="p-ufer"]').click();
  await page.waitForSelector('[data-testid="app-toast"]');
  const errText = await page.locator('[data-testid="app-toast"]').innerText();
  assert(errText.includes("nicht verschoben"), `${label}: Fehlertext «${errText}»`);
  assert((await meta(page, "p-hafen")).includes("3 Fotos"), `${label}: Fehler hat verschoben`);
  assert(state.media.find((row) => row.id === "m-own-1").waypoint_id === "p-hafen", `${label}: Fehler schreibt den Ort`);
  assert(await page.locator('[data-testid="photo-select-bar"]').count(), `${label}: Fehler beendet die Auswahl`);
  await page.click('[data-testid="photo-select-exit"]');

  await enterSelect(page);
  await selectOwn(page, "m-own-2");
  const patchesBeforeOffline = state.mediaPatches.length;
  await page.evaluate(() => {
    window.__online = false;
  });
  await page.click('[data-testid="photo-move"]');
  await page.locator('[data-move-place="p-ufer"]').click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("offline"));
  assert(state.mediaPatches.length === patchesBeforeOffline, `${label}: Offline schreibt`);
  assert((await meta(page, "p-hafen")).includes("3 Fotos"), `${label}: Offline verändert die Liste`);
  await page.evaluate(() => {
    window.__online = true;
  });
  await page.click('[data-testid="photo-select-exit"]');
  await page.waitForSelector('[data-testid="photo-select-start"]');
}

async function runSuite(browserType, baseUrl, label, viewport) {
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({
    ...devices["iPhone 8"],
    viewport,
    baseURL: baseUrl,
    permissions: ["geolocation"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const state = createMockSupabaseState();
  await installSupabaseMocks(page, state);
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await page.addInitScript(() => {
    const RealDate = Date;
    const fixed = new RealDate(2026, 9, 30, 12, 0, 0, 0).getTime();
    function TestDate(...args) {
      if (!new.target) return new RealDate(fixed).toString();
      if (args.length === 0) return new RealDate(fixed);
      return new RealDate(...args);
    }
    TestDate.prototype = RealDate.prototype;
    TestDate.now = () => fixed;
    TestDate.parse = RealDate.parse.bind(RealDate);
    TestDate.UTC = RealDate.UTC.bind(RealDate);
    window.Date = TestDate;
    window.__online = true;
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => window.__online });
  });

  const where = `${label} ${viewport.width}x${viewport.height}`;
  await page.goto(baseUrl);
  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  assert(Number(build) === 57, `${where}: Build ${build}`);
  const tripId = await loginAndOpen(page);
  seedTrip(state, tripId);
  await page.reload();
  await runFlows(page, state, where);
  const unexpected = pageErrors.filter((err) => !err.includes("access control checks"));
  assert(!unexpected.length, `${where}: Seitenfehler ${unexpected.join(" | ")}`);
  await browser.close();
  console.log(`Playwright 9c tests OK (${where})`);
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
