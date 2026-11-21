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
  const qp = (url, key) => url.searchParams.get(key)?.replace(/^eq\./, "") || "";
  return {
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
      if (table === "trip_members" && method === "GET") {
        return { status: 200, json: [{ trip_id: qp(url, "trip_id"), user_id: userId, role: "owner" }] };
      }
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
    else if (url.pathname.includes("/rest/v1/")) result = state.handleRest(url, method, body, headers);
    else result = { status: 200, json: {} };
    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      body: result.json == null ? "" : JSON.stringify(result.json),
    });
  });
}

async function login(page) {
  await page.waitForSelector('[data-testid="login-screen"]');
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
  await installMocks(page, createState());
  try {
    await page.goto("./");
    await page.waitForSelector('[data-testid="login-hero"]');
    const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
    assert(Number(build) === 71, `${label}: Build ${build}, erwartet 71`);

    const loginUi = await page.evaluate(() => {
      const hero = document.querySelector('[data-testid="login-hero"]');
      const form = document.querySelector('form[data-step="email"]');
      return {
        src: hero?.getAttribute("src") || "",
        pitch: document.querySelector('[data-testid="login-pitch"]')?.textContent || "",
        lead: document.querySelector(".login-lead")?.textContent || "",
        email: Boolean(form?.querySelector('input[name="email"]')),
        submit: form?.querySelector('button[type="submit"]')?.textContent?.trim() || "",
        heroBeforeLead: Boolean(hero && form && hero.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    assert(loginUi.src.includes("assets/covers/strand.jpg"), `${label}: Titelbild ${loginUi.src}`);
    assert(loginUi.pitch === "Orte, Fotos und Notizen einer Reise an einem Ort.", `${label}: Satz «${loginUi.pitch}»`);
    assert(loginUi.lead.includes("Melde dich mit deiner E-Mail an."), `${label}: Anmeldungstext geändert`);
    assert(loginUi.email && loginUi.submit === "Code senden", `${label}: Anmeldung «${loginUi.submit}»`);
    assert(loginUi.heroBeforeLead, `${label}: Titelbild steht nicht über der Anmeldung`);

    await login(page);
    await page.evaluate(async () => {
      const { setRememberLocationOnOpen } = await import("./js/settings-store.js");
      await setRememberLocationOnOpen(false);
    });
    await page.click('[data-action="new"]');
    await page.fill('[name="title"]', "Schnelle Fixes");
    await page.click('[data-action="pick-dates"]');
    await page.waitForSelector('.calendar-day[data-date="2026-11-06"]');
    await page.click('.calendar-day[data-date="2026-11-06"]');
    await page.click('.calendar-day[data-date="2026-11-08"]');
    await page.click('button[data-action="apply"]');
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-testid="trip-content"]');
    const tripId = await page.locator(".screen--trip").getAttribute("data-vacation-id");
    await page.evaluate(async (id) => {
      const { putPlace } = await import("./js/db.js");
      const { createPlace } = await import("./js/places.js");
      await putPlace(
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
    }, tripId);
    await page.reload();
    await page.waitForSelector(".oc--selected .qa__label");

    const footer = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll(".trip-footer [data-footer-action]")];
      return buttons.map((btn) => {
        const icon = btn.querySelector('[data-testid="footer-icon"] svg');
        const label = btn.querySelector('[data-testid="footer-label"]');
        const ir = icon.getBoundingClientRect();
        const lr = label.getBoundingClientRect();
        return {
          action: btn.dataset.footerAction,
          text: label.textContent,
          svg: Math.round(ir.width),
          labelBelow: lr.top >= ir.bottom - 1,
        };
      });
    });
    assert(
      footer.map((item) => item.text).join("|") === "Ort merken|Notiz|Kamera|Mediathek",
      `${label}: Fußleiste «${footer.map((item) => item.text).join("|")}»`
    );
    assert(footer.every((item) => item.svg === 32 && item.labelBelow), `${label}: Symbole ${JSON.stringify(footer)}`);

    const place = await page.evaluate(() => {
      const meta = document.querySelector(".oc--selected .oc__meta");
      const qa = document.querySelector(".oc--selected .qa");
      const style = getComputedStyle(meta);
      const line = Math.ceil(parseFloat(style.lineHeight) || 16);
      return {
        meta: meta.textContent,
        nowrap: style.whiteSpace,
        lines: meta.getClientRects().length,
        tall: meta.scrollHeight > line + 2,
        labels: [...qa.querySelectorAll(".qa__label")].map((el) => el.textContent),
        below: qa.getBoundingClientRect().top >= meta.getBoundingClientRect().bottom - 1,
      };
    });
    assert(place.meta.includes("13:00") && place.nowrap === "nowrap" && place.lines === 1 && !place.tall, `${label}: Kopfzeile ${JSON.stringify(place)}`);
    assert(place.labels.join("|") === "Bearbeiten|Fotos|Kamera" && place.below, `${label}: Knöpfe ${JSON.stringify(place)}`);
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
console.log("Playwright schnelle Fixes OK (Build 71)");
