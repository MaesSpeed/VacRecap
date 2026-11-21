import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
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

function createState() {
  const userId = "11111111-1111-1111-1111-111111111111";
  const session = {
    access_token: "test-access",
    refresh_token: "test-refresh",
    expires_in: 3600,
    expires_at: Math.round(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: { id: userId, email: "test@example.com" },
  };
  const trips = [];
  const waypoints = [];
  const media = [];
  const qp = (url, key) => {
    for (const [k, v] of url.searchParams.entries()) {
      if (k === key || k.startsWith(`${key}=`)) return v.replace(/^eq\./, "");
    }
    return url.searchParams.get(key)?.replace(/^eq\./, "") ?? "";
  };
  return {
    userId,
    media,
    handleAuth(url, method, body) {
      const authPath = url.pathname;
      if (authPath.endsWith("/otp") && method === "POST") return { status: 200, json: {} };
      if (authPath.endsWith("/verify") && method === "POST") {
        const parsed = JSON.parse(body || "{}");
        if (parsed.token !== "123456") return { status: 400, json: { error: "invalid_otp", message: "Invalid" } };
        return { status: 200, json: session };
      }
      if (authPath.endsWith("/token") && method === "POST") return { status: 200, json: session };
      if (authPath.endsWith("/user") && method === "GET") return { status: 200, json: session.user };
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
          return {
            status: 200,
            json: payload.paths.map((one) => ({
              error: null,
              path: one,
              signedURL: `/object/sign/mock?token=${encodeURIComponent(one)}`,
            })),
          };
        }
        return { status: 200, json: { signedURL: "/object/sign/mock?token=x" } };
      }
      if (p.includes("/object/sign/mock")) {
        return { status: 200, raw: Buffer.from("ffd8ffe000104a46494600000101000100010000ffd9", "hex"), contentType: "image/jpeg" };
      }
      return { status: 200, json: {} };
    },
    handleRest(url, method, body, headers) {
      const table = url.pathname.split("/").filter(Boolean).pop();
      const prefer = headers.prefer || "";
      const accept = headers.accept || "";
      const represent = (row) => {
        if (!prefer.includes("return=representation") && method !== "GET") return null;
        return accept.includes("vnd.pgrst.object") ? row : [row];
      };
      if (table === "trips") {
        if (method === "POST") {
          const row = JSON.parse(body || "{}");
          const full = {
            created_by: userId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            companions: [],
            ...row,
            id: row.id || crypto.randomUUID(),
          };
          trips.push(full);
          return { status: 201, json: represent(full) };
        }
        if (method === "GET") {
          const id = qp(url, "id");
          return { status: 200, json: id ? trips.filter((item) => item.id === id) : trips };
        }
      }
      if (table === "waypoints") {
        if (method === "POST") {
          const row = JSON.parse(body || "{}");
          const full = {
            created_by: userId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            deleted_at: null,
            ...row,
            id: row.id || crypto.randomUUID(),
          };
          waypoints.push(full);
          return { status: 201, json: represent(full) };
        }
        if (method === "GET") {
          const tripId = qp(url, "trip_id");
          return { status: 200, json: waypoints.filter((item) => item.trip_id === tripId && !item.deleted_at) };
        }
      }
      if (table === "media" && method === "GET") {
        let rows = media.filter((item) => !item.deleted_at);
        const tripId = qp(url, "trip_id");
        const kind = qp(url, "kind");
        const status = qp(url, "upload_status");
        const wp = qp(url, "waypoint_id");
        if (tripId) rows = rows.filter((item) => item.trip_id === tripId);
        if (kind) rows = rows.filter((item) => item.kind === kind);
        if (status) rows = rows.filter((item) => item.upload_status === status);
        if (wp.startsWith("in.(")) {
          const ids = wp.slice(4, -1).split(",");
          rows = rows.filter((item) => ids.includes(item.waypoint_id));
        } else if (wp) rows = rows.filter((item) => item.waypoint_id === wp);
        return { status: 200, json: rows };
      }
      if (table === "trip_members" && method === "GET") {
        return { status: 200, json: [{ trip_id: qp(url, "trip_id"), user_id: userId, role: "owner" }] };
      }
      if (table === "trip_recaps" && method === "GET") return { status: 200, json: [] };
      if (method === "GET" || method === "HEAD") return { status: 200, json: [] };
      return { status: 200, json: null };
    },
  };
}

async function installMocks(page, state) {
  await page.route(`**/${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const body = req.postData();
    const headers = req.headers();
    let result = { status: 404, json: {} };
    if (url.pathname.includes("/auth/v1/")) result = state.handleAuth(url, method, body);
    else if (url.pathname.includes("/storage/v1/")) result = state.handleStorage(url, method, body);
    else if (url.pathname.includes("/rest/v1/")) result = state.handleRest(url, method, body, headers);
    else result = { status: 200, json: {} };
    if (result.raw) {
      await route.fulfill({ status: result.status, contentType: result.contentType, body: result.raw });
      return;
    }
    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      body: result.json == null ? "" : JSON.stringify(result.json),
    });
  });
}

async function login(page) {
  await page.fill('input[name="email"]', "test@example.com");
  await page.click('form[data-step="email"] button[type="submit"]');
  await page.waitForSelector('form[data-step="otp"]');
  await page.fill('input[name="otp"]', "123456");
  await page.click('form[data-step="otp"] button[type="submit"]');
  await page.waitForSelector(".screen--urlaube", { timeout: 15_000 });
}

async function runCase(browserType, contextOptions, baseUrl) {
  const label = `${browserType.name()} ${contextOptions.viewport?.width || "device"}`;
  const browser = await browserType.launch();
  const context = await browser.newContext({
    ...contextOptions,
    baseURL: baseUrl,
    timezoneId: "Europe/Berlin",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  const state = createState();
  await installMocks(page, state);
  try {
    await page.goto("./");
    const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
    assert(Number(build) === 71, `${label}: Build ${build}, erwartet 71`);
    await login(page);
    await page.evaluate(async () => {
      const { setRememberLocationOnOpen } = await import("./js/settings-store.js");
      await setRememberLocationOnOpen(false);
    });

    await page.click('[data-action="new"]');
    await page.fill('[name="title"]', "Kachelwand");
    await page.click('[data-action="pick-dates"]');
    await page.waitForSelector('[data-testid="calendar-earlier"]');
    await page.waitForTimeout(500);
    const earlier = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="calendar-earlier"]');
      const scroller = document.querySelector(".calendar-scroll");
      const b = btn.getBoundingClientRect();
      const s = scroller.getBoundingClientRect();
      const months = [...document.querySelectorAll(".calendar-month")].map((el) => el.dataset.yearMonth);
      return {
        text: btn.textContent,
        visible: b.bottom > s.top + 1 && b.top < s.bottom - 1,
        first: months[0] || "",
      };
    });
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    assert(earlier.text === "Frühere Monate" && earlier.visible, `${label}: Knopf nicht sichtbar ${JSON.stringify(earlier)}`);
    assert(earlier.first === yearMonth, `${label}: erster Monat ${earlier.first}`);

    await page.click('.calendar-day[data-date="2026-11-06"]');
    await page.click('.calendar-day[data-date="2026-11-08"]');
    await page.click('button[data-action="apply"]');
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-testid="trip-content"]');
    const tripId = await page.locator(".screen--trip").getAttribute("data-vacation-id");
    const placeId = await page.evaluate(async (id) => {
      const { putPlace } = await import("./js/db.js");
      const { createPlace } = await import("./js/places.js");
      const place = await putPlace(
        createPlace({
          vacationId: id,
          day: "2026-11-06",
          ts: new Date("2026-11-06T13:00:00+01:00").getTime(),
          lat: 45.44,
          lng: 10.73,
          name: "Malcesine",
          soft: false,
          source: "test",
        })
      );
      return place.id;
    }, tripId);
    for (let i = 0; i < 3; i += 1) {
      const id = crypto.randomUUID();
      state.media.push({
        id,
        trip_id: tripId,
        waypoint_id: placeId,
        day: "2026-11-06",
        taken_at: "2026-11-06T12:00:00.000Z",
        kind: "photo",
        storage_path: `${tripId}/${id}.jpg`,
        thumb_path: `${tripId}/${id}.jpg`,
        mime: "image/jpeg",
        upload_status: "uploaded",
        deleted_at: null,
        created_by: state.userId,
        created_at: "2026-11-06T12:00:00.000Z",
        updated_at: "2026-11-06T12:00:00.000Z",
      });
    }
    await page.reload();
    await page.waitForSelector('[data-testid="add-place-note"]');
    const note = await page.evaluate(() => {
      const button = document.querySelector('[data-testid="add-place-note"]');
      const hint = document.querySelector(".place-note-add__hint");
      const rows = document.querySelector(".photo-rows");
      return {
        text: button?.textContent || "",
        hint: hint?.textContent || "",
        underPhotos: Boolean(rows && button && rows.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    assert(note.text === "+ Notiz zum Ort", `${label}: Notizknopf «${note.text}»`);
    assert(note.hint.includes("ganzen Ort") && note.underPhotos, `${label}: Hinweis ${JSON.stringify(note)}`);
    await page.click('[data-testid="add-place-note"]');
    await page.waitForSelector('[data-testid="note-sheet"]');
    await page.click('[data-testid="note-sheet"] [data-action="cancel"]');
    await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);

    await page.evaluate((id) => {
      window.location.hash = `#/urlaub/${id}/mediathek`;
    }, tripId);
    await page.waitForSelector(".library-place .library-thumb");
    const library = await page.evaluate(() => {
      const place = document.querySelector(".library-place");
      const grid = getComputedStyle(place.querySelector(".library-grid"));
      const thumb = getComputedStyle(place.querySelector(".library-thumb"));
      const bg = getComputedStyle(place).backgroundColor;
      return {
        name: place.querySelector(".oc__title")?.textContent || "",
        card: place.classList.contains("oc"),
        columns: grid.gridTemplateColumns.split(" ").filter(Boolean).length,
        radius: thumb.borderRadius,
        bg,
        thumbs: place.querySelectorAll(".library-thumb").length,
      };
    });
    assert(library.name === "Malcesine" && !library.card, `${label}: Kachel ${JSON.stringify(library)}`);
    assert(library.columns === 3 && library.radius === "0px" && library.thumbs === 3, `${label}: Raster ${JSON.stringify(library)}`);
    assert(library.bg === "rgba(0, 0, 0, 0)" || library.bg === "transparent", `${label}: Karte ${library.bg}`);

    await page.evaluate((id) => {
      window.location.hash = `#/urlaub/${id}/tagebuch`;
    }, tripId);
    await page.waitForSelector('[data-testid="diary-action"]');
    const empty = (await page.locator('[data-testid="diary-action"]').innerText()).replace(/\s+/g, " ");
    assert(empty.includes("Aus Zwischenablage einfügen"), `${label}: leerer Hauptknopf «${empty}»`);
    assert(!(await page.locator('[data-testid="diary-action"]').isDisabled()), `${label}: Hauptknopf gesperrt`);
    assert(await page.locator('[data-testid="diary-paste"]').isHidden(), `${label}: kleiner Einfügen-Knopf bleibt sichtbar`);
    await page.fill('[data-testid="diary-source"]', "Freitag\nFähre über den See.");
    await page.waitForFunction(() => (document.querySelector('[data-testid="diary-action"]')?.textContent || "").includes("Tage erkennen"));
    assert(!(await page.locator('[data-testid="diary-paste"]').isHidden()), `${label}: Einfügen fehlt bei Text`);

    const unexpected = errors.filter((err) => !err.includes("access control checks"));
    assert(unexpected.length === 0, `${label}: ${unexpected.join(" | ")}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

const { server, baseUrl } = await startServer();
try {
  await runCase(chromium, { viewport: { width: 390, height: 844 } }, baseUrl);
  await runCase(webkit, { ...devices["iPhone 12"] }, baseUrl);
} finally {
  server.close();
}
console.log("Playwright Mediathek/Tagebuch OK (Build 71)");
