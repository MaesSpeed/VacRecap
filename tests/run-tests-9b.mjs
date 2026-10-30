import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const LATENCY_MS = 600;
const TODAY = "2026-10-30";
const NEIGHBOR = "2026-10-29";
const FAR = "2026-10-26";
const USER = "11111111-1111-1111-1111-111111111111";

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

function photoRow(id, tripId, placeId, day, thumb, iso) {
  return {
    id,
    trip_id: tripId,
    waypoint_id: placeId,
    day,
    taken_at: iso,
    kind: "photo",
    storage_path: `orig/${thumb}`,
    thumb_path: thumb,
    mime: "image/jpeg",
    upload_status: "uploaded",
    deleted_at: null,
    created_at: iso,
    updated_at: iso,
    created_by: USER,
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
  let inflight = 0;
  let lastDone = 0;

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
    get inflight() {
      return inflight;
    },
    set inflight(n) {
      inflight = n;
    },
    get lastDone() {
      return lastDone;
    },
    set lastDone(n) {
      lastDone = n;
    },
    handleAuth(url, method, body) {
      const pathName = url.pathname;
      if (pathName.endsWith("/otp") && method === "POST") return { status: 200, json: {} };
      if (pathName.endsWith("/verify") && method === "POST") {
        const parsed = JSON.parse(body || "{}");
        if (parsed.token !== "123456") return { status: 400, json: { message: "Invalid" } };
        return { status: 200, json: session };
      }
      if (pathName.endsWith("/token") && method === "POST") return { status: 200, json: session };
      if (pathName.endsWith("/user") && method === "GET") return { status: 200, json: session.user };
      return { status: 404, json: {} };
    },
    handleStorage(url, method, body) {
      const p = url.pathname;
      if (p.includes("/object/sign/") && method === "POST") {
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
      if (p.includes("/object/sign/mock") && method === "GET") {
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
      if (table === "media" && method === "GET") return { status: 200, json: applyFilters(media, url) };
      if (table === "trip_members" && method === "GET") return { status: 200, json: [{ role: "owner", trip_id: url.searchParams.get("trip_id")?.replace(/^eq\./, "") || "", user_id: USER }] };
      return { status: 404, json: { message: "not found" } };
    },
  };
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
};

async function installSupabaseMocks(page, state) {
  await page.context().route(`**/${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const url = new URL(req.url());
    state.inflight += 1;
    await new Promise((r) => setTimeout(r, LATENCY_MS));
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
          headers: CORS,
          body: result.raw,
        });
      } else {
        await route.fulfill({
          status: result.status,
          contentType: "application/json",
          headers: CORS,
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
  let saw = false;
  while (Date.now() - start < 30000) {
    if (state.inflight > 0) saw = true;
    if (saw && state.inflight === 0 && Date.now() - state.lastDone > 350) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Netz nicht ruhig (inflight ${state.inflight})`);
}

function seedTrip(state, tripId) {
  const rows = [
    placeRow("p-hafen", tripId, TODAY, "Hafen Malcesine", "2026-10-30T12:00:00.000Z"),
    placeRow("p-2", tripId, TODAY, "Platz Zwei", "2026-10-30T11:00:00.000Z"),
    placeRow("p-3", tripId, TODAY, "Platz Drei", "2026-10-30T10:00:00.000Z"),
    placeRow("p-4", tripId, TODAY, "Platz Vier", "2026-10-30T09:00:00.000Z"),
    placeRow("p-5", tripId, TODAY, "Platz Fuenf", "2026-10-30T08:00:00.000Z"),
    placeRow("p-6", tripId, TODAY, "Platz Sechs", "2026-10-30T07:00:00.000Z"),
    placeRow("p-burg", tripId, NEIGHBOR, "Burg Limone", "2026-10-29T15:00:00.000Z"),
    placeRow("p-alt", tripId, NEIGHBOR, "Alt Limone", "2026-10-29T09:00:00.000Z"),
    placeRow("p-strand", tripId, FAR, "Strand Riva", "2026-10-26T11:00:00.000Z"),
  ];
  state.waypoints.push(...rows);
  state.media.push(
    photoRow("m-hafen", tripId, "p-hafen", TODAY, "hafen.jpg", "2026-10-30T12:05:00.000Z"),
    photoRow("m-burg-1", tripId, "p-burg", NEIGHBOR, "burg-1.jpg", "2026-10-29T15:10:00.000Z"),
    photoRow("m-burg-2", tripId, "p-burg", NEIGHBOR, "burg-2.jpg", "2026-10-29T15:20:00.000Z"),
    photoRow("m-burg-3", tripId, "p-burg", NEIGHBOR, "burg-3.jpg", "2026-10-29T15:30:00.000Z"),
    photoRow("m-alt", tripId, "p-alt", NEIGHBOR, "alt.jpg", "2026-10-29T09:10:00.000Z"),
    photoRow("m-strand-1", tripId, "p-strand", FAR, "strand-1.jpg", "2026-10-26T11:10:00.000Z"),
    photoRow("m-strand-2", tripId, "p-strand", FAR, "strand-2.jpg", "2026-10-26T11:20:00.000Z")
  );
}

async function loginAndCreateTrip(page) {
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
  await page.click('.calendar-day[data-date="2026-10-26"]');
  await page.click('.calendar-day[data-date="2026-10-31"]');
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForFunction(
    (day) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === day,
    TODAY
  );
  return page.locator(".screen--trip").getAttribute("data-vacation-id");
}

async function tapDay(page, state, day, { name, thumbs, requireCached, label }) {
  state.signBatches.length = 0;
  const sync = await page.evaluate((iso) => {
    const snapshot = () => {
      const root = document.querySelector("[data-page='current']");
      const list = root?.querySelector("[data-testid='place-list']");
      return {
        items: list ? list.querySelectorAll(":scope > li").length : 0,
        skeleton: Boolean(root?.querySelector("[data-testid='day-skeleton']")),
        emptyState: Boolean(root?.querySelector("[data-testid='trip-empty']")),
        text: root?.innerText || "",
        thumbs: root?.querySelectorAll(".tile__img[src], .th__img[src]").length || 0,
        gallery: root?.querySelectorAll('[data-testid="place-gallery"]').length || 0,
        html: (root?.innerHTML || "").trim().length,
      };
    };
    const blank = (s) => s.html === 0 || (s.items === 0 && !s.skeleton && !s.emptyState);
    window.__gaps = [];
    window.__sample = () => {
      const s = snapshot();
      if (blank(s)) window.__gaps.push(s.text.slice(0, 100));
      return s;
    };
    const t0 = performance.now();
    document.querySelector(`[data-day="${iso}"]`).click();
    const snap = window.__sample();
    window.__timer = setInterval(() => window.__sample(), 30);
    return { ...snap, dt: performance.now() - t0 };
  }, day);

  assert(sync.dt < 80, `${label}: Inhalt erst nach ${sync.dt.toFixed(0)} ms`);
  assert(sync.html > 0 && (sync.items > 0 || sync.emptyState), `${label}: Liste direkt nach dem Tippen leer`);
  const hasName = sync.text.includes(name);
  if (requireCached) {
    assert(hasName, `${label}: Nachbartag nicht sofort aus dem Cache (${sync.skeleton ? "Skeleton" : sync.text.slice(0, 100)})`);
  } else {
    assert(hasName || sync.skeleton, `${label}: weder Inhalt noch Skeleton, «${sync.text.slice(0, 100)}»`);
  }

  await page.waitForFunction(
    ({ placeName, minThumbs }) => {
      const s = window.__sample();
      return s.text.includes(placeName) && s.thumbs >= minThumbs && s.gallery >= 1 && !s.skeleton;
    },
    { placeName: name, minThumbs: thumbs },
    { timeout: 20_000 }
  );
  await page.evaluate(() => clearInterval(window.__timer));
  const gaps = await page.evaluate(() => window.__gaps);
  assert(!gaps.length, `${label}: Liste zwischendurch leer`);
  const placeholders = await page.locator("[data-page='current'] .th--ph").count();
  assert(placeholders === 0, `${label}: graue Platzhalter bleiben (${placeholders})`);
  assert(state.signBatches.length >= 1, `${label}: keine Signed-URL-Anfrage`);
  assert(
    state.signBatches.every((n) => n >= 2),
    `${label}: Thumbnails einzeln geholt (${state.signBatches.join(",")})`
  );
}

async function runSuite(browserType, baseUrl, label) {
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({
    ...devices["iPhone 8"],
    viewport: { width: 375, height: 667 },
    baseURL: baseUrl,
    permissions: ["geolocation"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(40_000);
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
  });

  await page.goto(baseUrl);
  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  assert(Number(build) === 53, `${label}: Build ${build}`);

  const tripId = await loginAndCreateTrip(page);
  seedTrip(state, tripId);
  await page.reload();
  await page.waitForFunction(
    (name) => {
      const root = document.querySelector("[data-page='current']");
      return root?.innerText?.includes(name) && root.querySelector(".tile__img[src], .th__img[src]");
    },
    "Hafen Malcesine",
    { timeout: 30_000 }
  );
  await waitQuiet(state);

  await tapDay(page, state, NEIGHBOR, {
    name: "Burg Limone",
    thumbs: 4,
    requireCached: true,
    label: `${label} Nachbar`,
  });
  await waitQuiet(state);
  await tapDay(page, state, FAR, {
    name: "Strand Riva",
    thumbs: 2,
    requireCached: false,
    label: `${label} entfernt`,
  });

  assert(!pageErrors.length, `${label}: Seitenfehler ${pageErrors.join(" | ")}`);
  await browser.close();
  console.log(`Playwright 9b tests OK (${label}, Build 53)`);
}

const { server, baseUrl } = await startServer();
try {
  await runSuite(chromium, baseUrl, "Chromium");
  await runSuite(webkit, baseUrl, "WebKit");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
