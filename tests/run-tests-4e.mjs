import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const USER_ID = "11111111-1111-1111-1111-111111111111";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

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

/** Erster klickbarer Tag im Kalender-Overlay (Datum relativ zum „heute“ der App). */
async function firstPickerDayIso(page) {
  return page.evaluate(() => {
    const day = document.querySelector(".sheet--calendar .calendar-day[data-date]:not([disabled])");
    return day?.dataset?.date || "";
  });
}

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      const filePath = path.join(root, rel.replace(/^\//, ""));
      try {
        const data = await readFile(filePath);
        const ext = path.extname(filePath);
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/` });
    });
  });
}

function createMockSupabaseState() {
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
  return {
    trips,
    waypoints,
    notes,
    media,
    handleAuth(url, method, body) {
      const p = url.pathname;
      if (p.endsWith("/otp") && method === "POST") return { status: 200, json: {} };
      if (p.endsWith("/verify") && method === "POST") {
        const b = JSON.parse(body || "{}");
        if (b.token !== "123456") return { status: 400, json: { message: "Invalid" } };
        return { status: 200, json: session };
      }
      if (p.endsWith("/token") && method === "POST") return { status: 200, json: session };
      if (p.endsWith("/user") && method === "GET") return { status: 200, json: session.user };
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
          return {
            status: 200,
            json: payload.paths.map((one) => ({
              error: null,
              path: one,
              signedURL: `/object/sign/mock?token=${encodeURIComponent(one)}`,
            })),
          };
        }
        const token = encodeURIComponent(pathName.split("/object/sign/")[1] || "1");
        return { status: 200, json: { signedURL: `/object/sign/mock?token=${token}` } };
      }
      if (pathName.includes("/object/sign/mock") && method === "GET") {
        return { status: 200, raw: TINY_PNG, contentType: "image/png" };
      }
      if (pathName.includes("/object/") && (method === "POST" || method === "PUT")) {
        return { status: 200, json: { Key: pathName, Id: "obj" } };
      }
      return { status: 404, json: {} };
    },
    handleRest(url, method, body, headers) {
      const table = url.pathname.split("/").filter(Boolean).pop();
      const prefer = String(headers?.prefer || headers?.Prefer || "");
      const accept = String(headers?.accept || headers?.Accept || "");

      const represent = (row) => {
        if (accept.includes("application/vnd.pgrst.object+json")) return row;
        return [row];
      };

      const applyFilters = (rows) => {
        let out = rows.slice();
        for (const [key, value] of url.searchParams.entries()) {
          if (["select", "order", "offset", "limit", "on_conflict"].includes(key)) continue;
          if (value === "is.null") out = out.filter((row) => row[key] == null);
          else if (value === "not.is.null") out = out.filter((row) => row[key] != null);
          else if (value.startsWith("eq.")) out = out.filter((row) => String(row[key]) === value.slice(3));
        }
        return out;
      };

      const qp = (key) => {
        for (const [k, v] of url.searchParams.entries()) {
          if (k === key || k.startsWith(`${key}=`)) return v.replace(/^eq\./, "");
        }
        return url.searchParams.get(key)?.replace(/^eq\./, "");
      };
      const upsertRow = (list, row, extra) => {
        const id = row.id || crypto.randomUUID();
        const hit = list.find((x) => x.id === id);
        const full = {
          created_by: USER_ID,
          created_at: hit?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null,
          ...extra,
          ...row,
          id,
        };
        if (hit) Object.assign(hit, full);
        else list.push(full);
        return full;
      };
      if (table === "trips") {
        if (method === "POST") {
          const row = JSON.parse(body || "{}");
          const full = upsertRow(trips, row, { companions: row.companions || [] });
          return { status: 201, json: prefer.includes("return=representation") ? [full] : null };
        }
        if (method === "GET") {
          const id = qp("id");
          if (id) {
            const t = trips.find((x) => x.id === id);
            return { status: 200, json: t ? [t] : [] };
          }
          return { status: 200, json: trips };
        }
      }
      if (table === "waypoints") {
        if (method === "GET") {
          const tripId = qp("trip_id");
          return { status: 200, json: waypoints.filter((w) => w.trip_id === tripId && !w.deleted_at) };
        }
        if (method === "POST") {
          const row = JSON.parse(body || "{}");
          upsertRow(waypoints, row, {});
          return { status: 201, json: [waypoints[waypoints.length - 1]] };
        }
      }
      if (table === "notes" && method === "GET") return { status: 200, json: [] };
      if (table === "media") {
        if (method === "GET") return { status: 200, json: applyFilters(media) };
        if (method === "POST") {
          const parsed = JSON.parse(body || "{}");
          const full = upsertRow(media, parsed, {});
          return { status: 201, json: represent(full) };
        }
        if (method === "PATCH") {
          const rows = applyFilters(media);
          const patch = JSON.parse(body || "{}");
          if (!rows[0]) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
          Object.assign(rows[0], patch, { updated_at: new Date().toISOString() });
          return { status: 200, json: represent(rows[0]) };
        }
      }
      if (table === "trip_members" && method === "GET") {
        const tripId = qp("trip_id");
        const userId = qp("user_id");
        return { status: 200, json: [{ role: "owner", trip_id: tripId || "", user_id: userId || USER_ID }] };
      }
      return { status: 200, json: [] };
    },
  };
}

async function installSupabaseMocks(page, state) {
  await page.route(`**/${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders(req) });
      return;
    }
    const url = new URL(req.url());
    const method = req.method();
    const body = req.method() === "GET" || req.method() === "HEAD" ? null : req.postData();
    const headers = req.headers();
    let result;
    if (url.pathname.includes("/auth/v1/")) result = state.handleAuth(url, method, body);
    else if (url.pathname.includes("/storage/v1/")) result = state.handleStorage(url, method, body);
    else if (url.pathname.includes("/rest/v1/")) result = state.handleRest(url, method, body, headers);
    else result = { status: 404, json: {} };
    if (result.raw) {
      await route.fulfill({
        status: result.status,
        headers: { ...corsHeaders(req), "content-type": result.contentType || "application/octet-stream" },
        body: result.raw,
      });
      return;
    }
    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      headers: corsHeaders(req),
      body: result.json == null ? "" : JSON.stringify(result.json),
    });
  });
  await page.route("**/*", async (route) => {
    const u = route.request().url();
    if (u.startsWith("http://127.0.0.1") || u.startsWith("http://localhost")) {
      await route.continue();
      return;
    }
    if (u.includes(SUPABASE_HOST)) {
      await route.fallback();
      return;
    }
    await route.abort();
  });
}

async function loginIfNeeded(page) {
  await page.waitForFunction(
    () => {
      const app = document.getElementById("app");
      if (!app) return false;
      if (app.classList.contains("screen--urlaube")) return true;
      if (app.querySelector('[data-testid="login-screen"]')) return true;
      if (app.querySelector('[data-testid="cloud-load-error"]')) return true;
      return false;
    },
    { timeout: 30_000 }
  );
  if (await page.locator('[data-testid="cloud-load-error"]').count()) {
    throw new Error("Start: Cloud-Ladefehler (getAllVacations) statt Login/Urlaube");
  }
  if (!(await page.locator('[data-testid="login-screen"]').count())) return;
  await page.fill('input[name="email"]', "test@example.com");
  await page.click('form[data-step="email"] button[type="submit"]');
  await page.waitForSelector('form[data-step="otp"]');
  await page.fill('input[name="otp"]', "123456");
  await page.click('form[data-step="otp"] button[type="submit"]');
  await page.waitForSelector(".screen--urlaube", { timeout: 15_000 });
}

function leafMock() {
  return () => {
    window.L = {
      map: () => ({
        remove: () => {},
        invalidateSize: () => {},
        setView: () => {},
        fitBounds: () => {},
        closePopup: () => {},
      }),
      tileLayer: () => ({ addTo: () => ({ on: () => {} }), on: () => {} }),
      layerGroup: () => ({ addTo: () => {}, clearLayers: () => {} }),
      control: {
        attribution: () => ({
          addAttribution: () => ({ addTo: () => {} }),
        }),
      },
      divIcon: (o) => o,
      marker: () => ({
        addTo: () => {},
        bindPopup: () => {},
        on: () => {},
        getPopup: () => ({ getElement: () => null }),
      }),
      polyline: () => ({ addTo: () => {} }),
      latLngBounds: () => ({}),
    };
  };
}

async function seedTrip(page) {
  await page.goto("./", { waitUntil: "load" });
  await loginIfNeeded(page);
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', "Paris");
  await page.click('[data-action="pick-dates"]');
  await page.waitForSelector(".sheet--calendar");
  const dayIso = await firstPickerDayIso(page);
  if (!dayIso) throw new Error("Kalender: kein klickbarer Tag");
  await page.click(`.calendar-day[data-date="${dayIso}"]`);
  await page.click(`.calendar-day[data-date="${dayIso}"]`);
  await page.waitForFunction(() => {
    const btn = document.querySelector('button[data-action="apply"]');
    return btn && !btn.disabled;
  });
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  const vacationId = await page.locator(".screen--trip").getAttribute("data-vacation-id");
  return { vacationId, dayIso };
}

async function galleryFileBuffer(page) {
  return page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#336699";
    ctx.fillRect(0, 0, 64, 48);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
}

async function openMediathekCancel(page, vacationId, dayIso) {
  await page.evaluate(
    async ({ vacationId, dayIso }) => {
      const blob = await new Promise((resolve) => {
        const c = document.createElement("canvas");
        c.width = 40;
        c.height = 30;
        c.getContext("2d").fillStyle = "#5588aa";
        c.getContext("2d").fillRect(0, 0, 40, 30);
        c.toBlob((b) => resolve(b), "image/jpeg", 0.9);
      });
      const file = new File([blob], "m.jpg", { type: "image/jpeg" });
      const { createMediathekSession } = await import("./js/mediathek-session.js");
      const { navigate } = await import("./js/router.js");
      createMediathekSession({
        vacationId,
        day: dayIso,
        selectedPlaceId: null,
        files: [file],
      });
      navigate({ name: "urlaub-mediathek", id: vacationId }, { replace: true });
    },
    { vacationId, dayIso }
  );
  await page.waitForSelector('[data-testid="mediathek-screen"]');
  await page.click('[data-action="cancel"]');
  await page.waitForSelector('[data-testid="trip-content"]');
}

async function runSuite(deviceName, viewport, { baseUrl, browser }) {
  const state = createMockSupabaseState();
  const ctx = await browser.newContext({
    baseURL: baseUrl,
    viewport,
    ...devices[deviceName.includes("iPhone") ? "iPhone 8" : "Pixel 5"],
    permissions: ["geolocation"],
  });
  await ctx.addInitScript(leafMock());
  // Deterministicer Start: alte Supabase-Sitzung aus lokalem Storage verhindert
  // hängende Auth-Initialisierung oder kaputte Refresh-Versuche (Mock liefert nur
  // die API, nicht jeden Kantenfall aus dem Browser-Cache).
  await ctx.addInitScript(() => {
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.includes("supabase") || k.startsWith("sb-")) localStorage.removeItem(k);
      }
    } catch {
      /* ignore */
    }
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  await installSupabaseMocks(page, state);
  const { vacationId, dayIso } = await seedTrip(page);
  await page.goto(`./#/urlaub/${vacationId}`);
  await page.waitForSelector('[data-testid="trip-content"]');

  const h0 = await page.evaluate(() => history.length);
  for (let i = 0; i < 3; i++) {
    await openMediathekCancel(page, vacationId, dayIso);
  }
  const h1 = await page.evaluate(() => history.length);
  if (h1 > h0 + 2) {
    throw new Error(
      `${deviceName}: History nach 3× Mediathek ${h0}→${h1} (erwartet ≤${h0 + 2})`
    );
  }

  await page.goBack();
  await page.waitForTimeout(200);
  const onMediathek = await page.evaluate(() => window.location.hash.includes("/mediathek"));
  if (onMediathek) {
    throw new Error(`${deviceName}: Zurück landet noch auf Mediathek`);
  }

  const buf = await galleryFileBuffer(page);
  await page.locator('[data-role="capture-photo-input"]').setInputFiles({
    name: "p.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from(buf),
  });
  await page.waitForSelector(".tile[data-media-id]");
  if (await page.locator('[data-testid="photo-upload-sheet"]').count()) {
    await page.click('[data-testid="photo-upload-sheet"] [data-action="close"]');
    await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden, { timeout: 10_000 });
  }
  await page.locator(".tile[data-media-id]").first().click();
  await page.waitForSelector('[data-testid="media-viewer"]');
  const stroke = await page.locator(".media-viewer__back path").evaluate((p) => {
    const btn = p.closest(".media-viewer__back");
    return {
      stroke: getComputedStyle(p).stroke || p.getAttribute("stroke"),
      color: getComputedStyle(btn).color,
    };
  });
  if (stroke.color !== "rgb(255, 255, 255)" && stroke.stroke !== "rgb(255, 255, 255)") {
    throw new Error(`${deviceName}: Viewer-Zurück nicht weiß (${JSON.stringify(stroke)})`);
  }
  const backBox = await page.locator('[data-testid="media-viewer-close"]').boundingBox();
  if (!backBox || backBox.width < 44 || backBox.height < 44) {
    throw new Error(`${deviceName}: Viewer-Zurück Tippfläche < 44px`);
  }
  await page.click('[data-testid="media-viewer-close"]');
  await page.waitForSelector('[data-testid="media-viewer"]', { state: "hidden" });

  await page.evaluate(() => {
    const input = document.querySelector('[data-role="capture-photo-input"]');
    window.__captureInputOpens = 0;
    input?.addEventListener("click", () => {
      window.__captureInputOpens = (window.__captureInputOpens || 0) + 1;
    });
  });
  for (const ms of [80, 150, 250, 350]) {
    await page.evaluate(() => {
      window.__captureInputOpens = 0;
    });
    const cam = page.locator('[data-footer-action="camera"]');
    await cam.click();
    await page.waitForTimeout(ms);
    const box = await cam.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    const opens = await page.evaluate(() => window.__captureInputOpens ?? 0);
    if (opens > 1) {
      throw new Error(`${deviceName}: Kamera-Doppeltipp ${ms}ms öffnete Input mehrfach (${opens})`);
    }
    await page.waitForTimeout(Math.max(0, 460 - ms));
  }

  await ctx.close();
}

async function main() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();

  await runSuite("iPhone", { width: 375, height: 667 }, { baseUrl, browser });
  await runSuite("Android", { width: 360, height: 740 }, { baseUrl, browser });

  await browser.close();
  server.close();
  console.log("Playwright 4e tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
