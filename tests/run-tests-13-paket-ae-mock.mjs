/**
 * Paket A–E: Integrationstests mit gemocktem Supabase (kein Netz).
 * node tests/run-tests-13-paket-ae-mock.mjs
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";
import { ensureTripDetailDay } from "./trip-detail-helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const USER_ID = "11111111-1111-1111-1111-111111111111";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
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

function qp(url, key) {
  const raw = url.searchParams.get(key);
  return raw ? raw.replace(/^eq\./, "") : "";
}

function applyFilters(rows, url) {
  let out = rows.slice();
  for (const [key, value] of url.searchParams.entries()) {
    if (["select", "order", "offset", "limit", "on_conflict"].includes(key)) continue;
    if (value === "is.null") out = out.filter((row) => row[key] == null);
    else if (value === "not.is.null") out = out.filter((row) => row[key] != null);
    else if (value.startsWith("eq.")) out = out.filter((row) => String(row[key]) === value.slice(3));
    else if (value.startsWith("in.")) {
      const set = new Set(value.slice(3).replace(/[()]/g, "").split(",").map((s) => s.trim()));
      out = out.filter((row) => set.has(String(row[key])));
    }
  }
  return out;
}

function createMockState() {
  const session = {
    access_token: "test-access",
    refresh_token: "test-refresh",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: { id: USER_ID, aud: "authenticated", role: "authenticated", email: "test@example.com" },
  };
  const trips = [];
  const waypoints = [];
  const notes = [];
  const media = [];
  const members = [];
  /** @type {string[]} */
  const requests = [];

  function recordAuth(method, pathname) {
    requests.push(`${method} ${pathname}`);
  }

  function recordRest(method, kind, extra = "") {
    requests.push(`${method} ${kind}${extra ? ` ${extra}` : ""}`);
  }

  const state = {
    session,
    trips,
    waypoints,
    notes,
    media,
    members,
    requests,
    tripRole: "owner",
    handleAuth(url, method) {
      const pathName = url.pathname;
      if (pathName.endsWith("/otp") && method === "POST") return { status: 200, json: {} };
      if (pathName.endsWith("/verify") && method === "POST") {
        const parsed = JSON.parse(arguments[2] || "{}");
        if (parsed.token !== "123456") return { status: 400, json: { error: "invalid_otp" } };
        return { status: 200, json: session };
      }
      if (pathName.endsWith("/token") && method === "POST") return { status: 200, json: session };
      if (pathName.endsWith("/user") && method === "GET") {
        recordAuth(method, pathName);
        return { status: 200, json: session.user };
      }
      return { status: 404, json: {} };
    },
    handleRest(url, method, body, headers = {}) {
      if (url.pathname.includes("/rpc/")) {
        const fn = url.pathname.split("/").filter(Boolean).pop() || "";
        recordRest(method, `rpc:${fn}`);
        if (fn === "list_trip_people") return { status: 200, json: [] };
        if (fn === "touch_trip_presence" || fn === "clear_trip_presence") return { status: 200, json: null };
        if (fn === "list_trip_presence") return { status: 200, json: [] };
        return { status: 200, json: null };
      }

      const table = url.pathname.split("/").filter(Boolean).pop() || "";
      const prefer = (headers.accept || "").includes("return=representation");
      recordRest(method, table);

      if (table === "trips" && method === "POST") {
        const row = JSON.parse(body || "{}");
        const id = row.id || crypto.randomUUID();
        const full = {
          created_by: USER_ID,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          companions: [],
          companion_tags: [],
          ...row,
          id,
        };
        trips.push(full);
        members.push({ trip_id: id, user_id: USER_ID, role: "owner" });
        return { status: 201, json: prefer ? [full] : null };
      }
      if (table === "trips" && method === "GET") {
        const id = qp(url, "id");
        if (id) {
          const t = trips.find((x) => x.id === id);
          return { status: 200, json: t ? [t] : [] };
        }
        return { status: 200, json: trips };
      }
      if (table === "trip_members" && method === "GET") {
        const tripEq = qp(url, "trip_id");
        const uidEq = qp(url, "user_id");
        const accept = headers.accept || "";
        const asObject = accept.includes("application/vnd.pgrst.object+json");
        if (tripEq && uidEq) {
          const m = members.find((x) => String(x.trip_id) === String(tripEq) && String(x.user_id) === String(uidEq));
          const role = m?.role || state.tripRole;
          const row = m ? { role: m.role } : { role };
          return { status: 200, json: asObject ? row : [row] };
        }
        return { status: 200, json: asObject ? null : [] };
      }
      if (table === "waypoints" && method === "GET") return { status: 200, json: applyFilters(waypoints, url) };
      if (table === "waypoints" && method === "POST") {
        const row = JSON.parse(body || "{}");
        const id = row.id || crypto.randomUUID();
        const full = {
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          created_by: USER_ID,
          deleted_at: null,
          ...row,
          id,
        };
        waypoints.push(full);
        return { status: 201, json: prefer ? [full] : null };
      }
      if (table === "notes" && method === "GET") return { status: 200, json: applyFilters(notes, url) };
      if (table === "notes" && (method === "POST" || method === "PATCH")) {
        const accept = headers.accept || "";
        const asObject = accept.includes("application/vnd.pgrst.object+json");
        if (method === "POST") {
          const row = JSON.parse(body || "{}");
          const id = row.id || crypto.randomUUID();
          const now = new Date().toISOString();
          const full = {
            created_at: now,
            updated_at: now,
            created_by: USER_ID,
            deleted_at: null,
            body: row.body || "",
            ...row,
            id,
          };
          notes.push(full);
          return { status: 201, json: asObject ? full : [full] };
        }
        const rows = applyFilters(notes, url);
        if (!rows[0]) return { status: 406, json: { code: "PGRST116" } };
        const patch = JSON.parse(body || "{}");
        Object.assign(rows[0], patch, { updated_at: new Date().toISOString() });
        return { status: 200, json: asObject ? rows[0] : [rows[0]] };
      }
      if (table === "media" && method === "GET") return { status: 200, json: applyFilters(media, url) };
      return { status: 200, json: [] };
    },
  };
  return state;
}

async function installMocks(page, state) {
  await page.context().route(`**/${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const body = req.method() === "GET" || req.method() === "HEAD" ? null : req.postData();
    let result;
    if (url.pathname.includes("/auth/v1/")) result = state.handleAuth(url, req.method(), body);
    else if (url.pathname.includes("/rest/v1/")) result = state.handleRest(url, req.method(), body, Object.fromEntries(Object.entries(req.headers())));
    else result = { status: 404, json: {} };
    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      body: result.json != null ? JSON.stringify(result.json) : "",
    });
  });
  await page.context().route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      await route.continue();
      return;
    }
    if (url.includes(SUPABASE_HOST)) {
      await route.fallback();
      return;
    }
    await route.abort();
  });
}

function installGestureHelpers(page) {
  return page.addInitScript(() => {
    const gesture = { el: null, kind: "touch", x0: 0, y0: 0, x: 0 };
    function fireTouch(el, phase, x, y) {
      const touchType = phase === "start" ? "touchstart" : phase === "move" ? "touchmove" : "touchend";
      const ended = phase === "end";
      const touch = new Touch({ identifier: 0, target: el, clientX: x, clientY: y, pageX: x, pageY: y, radiusX: 1, radiusY: 1 });
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
    function firePointer(el, phase, x, y) {
      const type =
        phase === "start" ? "pointerdown" : phase === "move" ? "pointermove" : phase === "end" ? "pointerup" : "pointercancel";
      el.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
          buttons: phase === "end" ? 0 : 1,
          clientX: x,
          clientY: y,
        })
      );
    }
    function fire(phase, x, y) {
      if (gesture.kind === "pointer") firePointer(gesture.el, phase, x, y);
      else fireTouch(gesture.el, phase, x, y);
    }
    window.__down = (kind) => {
      const el = document.querySelector('[data-testid="trip-content"]');
      const rect = el.getBoundingClientRect();
      gesture.el = el;
      gesture.kind = kind || "touch";
      gesture.x0 = rect.left + rect.width / 2;
      gesture.y0 = rect.top + Math.min(120, Math.max(28, rect.height / 2));
      gesture.x = gesture.x0;
      fire("start", gesture.x0, gesture.y0);
    };
    window.__move = (dx) => {
      gesture.x = gesture.x0 + dx;
      fire("move", gesture.x, gesture.y0);
    };
    window.__up = () => fire("end", gesture.x, gesture.y0);
  });
}

async function login(page) {
  await page.goto("./");
  await page.waitForSelector('[data-testid="login-screen"]');
  await page.fill('input[name="email"]', "test@example.com");
  await page.click('form[data-step="email"] button[type="submit"]');
  await page.waitForSelector('form[data-step="otp"]');
  await page.fill('input[name="otp"]', "123456");
  await page.click('form[data-step="otp"] button[type="submit"]');
  await page.waitForSelector(".screen--urlaube");
}

async function createTrip(page, title, start, end) {
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', title);
  await page.click('[data-action="pick-dates"]');
  await page.locator(`.calendar-day[data-date="${start}"]`).click();
  await page.locator(`.calendar-day[data-date="${end}"]`).click();
  await page.waitForFunction(() => {
    const btn = document.querySelector('button[data-action="apply"]');
    return btn && !btn.disabled;
  });
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  await ensureTripDetailDay(page, start);
}

async function waitSwipeQuiet(page) {
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="trip-content"]');
    return el && el.dataset.swipeLock !== "1" && el.dataset.gesture !== "1";
  });
}

async function main() {
  const { server, baseUrl } = await startServer();
  const state = createMockState();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices["iPhone 8"], baseURL: baseUrl });
  const page = await ctx.newPage();

  await installGestureHelpers(page);
  await page.addInitScript(() => {
    const RealDate = Date;
    const fixed = Date.parse("2026-10-30T10:00:00.000Z");
    const booted = RealDate.now();
    function TestDate(...args) {
      if (!new.target) return new RealDate(TestDate.now()).toString();
      if (args.length === 0) return new RealDate(TestDate.now());
      return new RealDate(...args);
    }
    TestDate.prototype = RealDate.prototype;
    TestDate.now = () => fixed + (RealDate.now() - booted);
    TestDate.parse = RealDate.parse.bind(RealDate);
    TestDate.UTC = RealDate.UTC.bind(RealDate);
    window.Date = TestDate;
  });
  await installMocks(page, state);
  await login(page);

  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  assert(Number(build) === 69, `Build ${build}`);

  const authBaseline = state.requests.filter((r) => r.startsWith("GET ") && r.includes("/user")).length;

  await createTrip(page, "AE-Paket", "2026-10-26", "2026-10-31");
  const tripId = await page.locator(".screen--trip").getAttribute("data-vacation-id");
  assert(tripId, "trip id");

  const t = state.trips.find((x) => x.id === tripId);
  if (t) {
    t.companions = ["Ada", "Ben"];
    t.companion_tags = ["freunde"];
  }

  const chips = page.locator(".day-chips");
  assert((await chips.evaluate((el) => getComputedStyle(el).overflowY)) === "hidden", "overflow-y");
  assert((await chips.evaluate((el) => getComputedStyle(el).touchAction)) === "pan-x", "touch-action");

  assert((await page.locator('[data-testid="trip-companions"]').count()) === 0, "Begleiter-Zeile fehlt");

  await page.locator('.day-chip[data-day="2026-10-26"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2026-10-26");

  for (let i = 0; i < 16; i += 1) {
    const active = await page.locator('[data-testid="trip-content"]').getAttribute("data-active-day");
    if (active === "2026-10-30") break;
    const can = await page.locator('[data-testid="trip-content"]').getAttribute("data-can-next");
    if (can !== "1") break;
    await page.evaluate(() => {
      window.__down("touch");
      const w = document.querySelector('[data-testid="trip-content"]').clientWidth || 375;
      window.__move(-Math.max(120, w * 0.45));
      window.__up();
    });
    await waitSwipeQuiet(page);
    await page.waitForTimeout(60);
  }
  const dayAfterSwipes = await page.locator('[data-testid="trip-content"]').getAttribute("data-active-day");
  assert(dayAfterSwipes === "2026-10-30", `Schnellwischen Ziel ${dayAfterSwipes}`);
  await page.locator('.day-chip[data-day="2026-10-26"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2026-10-26");

  const placeA = "place-a";
  const dayIso = "2026-10-26";
  state.waypoints.push({
    id: placeA,
    trip_id: tripId,
    day: dayIso,
    visited_at: `${dayIso}T10:00:00.000Z`,
    lat: 45.5,
    lng: 10.5,
    accuracy_m: 8,
    title: "Ufer",
    is_soft: false,
    source: "manual",
    deleted_at: null,
    created_at: `${dayIso}T10:00:00.000Z`,
    updated_at: `${dayIso}T10:00:00.000Z`,
    created_by: USER_ID,
  });
  state.media.push({
    id: "m-a",
    trip_id: tripId,
    waypoint_id: placeA,
    day: dayIso,
    taken_at: `${dayIso}T10:05:00.000Z`,
    kind: "photo",
    storage_path: "o/a.jpg",
    thumb_path: "t/a.jpg",
    mime: "image/jpeg",
    upload_status: "uploaded",
    deleted_at: null,
    created_at: `${dayIso}T10:05:00.000Z`,
    updated_at: `${dayIso}T10:05:00.000Z`,
    created_by: USER_ID,
  });

  await page.evaluate(() => document.querySelector('[data-action="back"]')?.click());
  await page.waitForSelector(".screen--urlaube");
  await page.locator(`[data-vacation-id="${tripId}"]`).click();
  await page.waitForSelector('[data-testid="trip-content"]');
  await ensureTripDetailDay(page, "2026-10-26");

  const imgBefore = await page.evaluate(() =>
    [...document.querySelectorAll("[data-page='current'] img")].map((img) => img.getAttribute("src") || "")
  );

  await page.evaluate(() => {
    const pageEl = document.querySelector("[data-page='current']");
    if (pageEl) pageEl.scrollTop = 120;
  });

  const beforeDom = await page.evaluate(() => ({
    scroll: document.querySelector("[data-page='current']")?.scrollTop || 0,
    placeRoot: document.querySelector(`[data-page='current'] .oc[data-place-id="${CSS.escape("place-a")}"]`),
  }));

  const reqBeforeSave = state.requests.length;
  const authBeforeSave = state.requests.filter((r) => r.includes("/user")).length;

  await page.click('[data-footer-action="note"]');
  await page.waitForSelector('[data-testid="note-sheet"]');

  const authAfterOpenSheet = state.requests.filter((r) => r.includes("/user")).length;
  assert(authAfterOpenSheet === authBeforeSave, `Auth nach Sheet ${authAfterOpenSheet} vs ${authBeforeSave}`);

  await page.fill('[data-testid="note-sheet"] textarea', "Testnotiz Paket 13");
  await page.click('[data-testid="note-sheet"] [data-action="save"]');
  await page.waitForSelector('[data-testid="note-sheet"]', { state: "detached", timeout: 15000 });
  await page.waitForFunction(() => {
    const el = document.querySelector(`[data-page='current'] .oc[data-place-id="${CSS.escape("place-a")}"]`);
    return el && el.isConnected;
  });

  const reqAfterSave = state.requests.length;
  const authAfterSave = state.requests.filter((r) => r.includes("/user")).length;
  assert(authAfterSave === authBeforeSave, `Auth beim Speichern ${authAfterSave} vs ${authBeforeSave}`);

  const afterDom = await page.evaluate(() => ({
    scroll: document.querySelector("[data-page='current']")?.scrollTop || 0,
    placeRoot: document.querySelector(`[data-page='current'] .oc[data-place-id="${CSS.escape("place-a")}"]`),
  }));

  assert(Math.abs(afterDom.scroll - beforeDom.scroll) < 32, `Scroll ${beforeDom.scroll} → ${afterDom.scroll}`);
  assert(beforeDom.placeRoot && afterDom.placeRoot && beforeDom.placeRoot === afterDom.placeRoot, "Ort-Karte neu gebaut");

  const imgAfter = await page.evaluate(() =>
    [...document.querySelectorAll("[data-page='current'] img")].map((img) => img.getAttribute("src") || "")
  );
  assert(JSON.stringify(imgBefore.sort()) === JSON.stringify(imgAfter.sort()), "Bild-URLs geändert");

  console.log(
    `requests around save: total ${reqBeforeSave}→${reqAfterSave} (+${reqAfterSave - reqBeforeSave}), auth/user baseline+${authBeforeSave - authBaseline}`
  );

  {
    const idx = state.members.findIndex((m) => String(m.trip_id) === String(tripId) && String(m.user_id) === String(USER_ID));
    if (idx >= 0) state.members[idx].role = "observer";
    else state.members.push({ trip_id: tripId, user_id: USER_ID, role: "observer" });
  }
  state.tripRole = "observer";
  const probe = await page.evaluate(
    async ({ tid, uid }) => {
      const { getSupabase } = await import("./js/supabase-client.js");
      const { data, error } = await getSupabase()
        .from("trip_members")
        .select("role")
        .eq("trip_id", tid)
        .eq("user_id", uid)
        .maybeSingle();
      return { data, error: error?.message || null };
    },
    { tid: tripId, uid: USER_ID }
  );
  if (probe.data?.role !== "observer") {
    throw new Error(`trip_members mock: ${JSON.stringify(probe)} members=${JSON.stringify(state.members)}`);
  }
  await page.evaluate(async (id) => {
    const { clearTripRoleCache } = await import("./js/trip-role.js");
    clearTripRoleCache(id);
  }, tripId);
  await page.goto(`${baseUrl}#/urlaube`);
  await page.waitForSelector(".screen--urlaube");
  await page.goto(`${baseUrl}#/urlaub/${tripId}`);
  if (await page.locator('[data-testid="login-screen"]').count()) {
    await page.fill('input[name="email"]', "test@example.com");
    await page.click('form[data-step="email"] button[type="submit"]');
    await page.waitForSelector('form[data-step="otp"]');
    await page.fill('input[name="otp"]', "123456");
    await page.click('form[data-step="otp"] button[type="submit"]');
  }
  await page.waitForSelector(".screen--trip", { timeout: 30000 });
  await page.waitForSelector("footer.trip-footer", { timeout: 30000 });
  const tripIdNow = await page.locator(".screen--trip").getAttribute("data-vacation-id");
  const roleDbg = await page.evaluate(async (id) => {
    const { getConfirmedTripRole } = await import("./js/trip-role.js");
    return getConfirmedTripRole(id);
  }, tripIdNow || tripId);
  if (roleDbg.role !== "observer") {
    const banner = await page.locator('[data-role="role-banner"]').innerHTML().catch(() => "");
    throw new Error(`Rolle nach Reload: ${JSON.stringify(roleDbg)} trip=${tripIdNow} banner=${banner}`);
  }
  assert((await page.locator('[data-footer-action="gallery"]').count()) === 1, "Betrachter: nur Mediathek");
  assert((await page.locator('[data-footer-action="pin"]').count()) === 0, "Betrachter: kein Ort merken");
  assert((await page.locator('[data-footer-action="camera"]').count()) === 0, "Betrachter: keine Kamera");
  assert((await page.locator('[data-footer-action="note"]').count()) === 0, "Betrachter: keine Notiz");
  assert((await page.locator('[data-action="settings"]').getAttribute("disabled")) != null, "Betrachter: Einstellungen aus");
  assert((await page.locator('[data-testid="photo-select-start"]').count()) === 0, "Betrachter: keine Foto-Auswahl");

  const migPath = path.join(root, "supabase/migrations/20260206180000_betrachter_rolle.sql");
  const mig = await readFile(migPath, "utf8");
  assert(mig.includes("observer"), "Migration: observer");
  assert(/policy|rls|check/i.test(mig), "Migration: Policy/RLS erwähnt");

  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  console.log("Playwright 13 paket A–E mock OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
