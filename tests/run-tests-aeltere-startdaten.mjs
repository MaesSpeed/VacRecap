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

function createMockSupabaseState() {
  const userId = "11111111-1111-1111-1111-111111111111";
  const session = {
    access_token: "test-access",
    refresh_token: "test-refresh",
    user: { id: userId, email: "test@example.com" },
  };
  const trips = [];
  return {
    userId,
    trips,
    handleAuth(url, method, body) {
      const authPath = url.pathname;
      if (authPath.endsWith("/otp") && method === "POST") return { status: 200, json: {} };
      if (authPath.endsWith("/verify") && method === "POST") {
        const parsed = JSON.parse(body || "{}");
        if (parsed.token !== "123456") {
          return { status: 400, json: { error: "invalid_otp", message: "Invalid" } };
        }
        return {
          status: 200,
          json: {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            user: session.user,
          },
        };
      }
      if (authPath.endsWith("/token") && method === "POST") return { status: 200, json: session };
      if (authPath.endsWith("/user") && method === "GET") return { status: 200, json: session.user };
      return { status: 404, json: {} };
    },
    handleRest(url, method, body, headers) {
      const table = url.pathname.split("/").filter(Boolean).pop();
      const prefer = headers.prefer || "";
      const accept = headers.accept || "";
      const qp = (key) => {
        const raw = url.searchParams.get(key);
        return raw?.replace(/^eq\./, "") || "";
      };
      const represent = (row) => {
        if (!prefer.includes("return=representation") && method !== "GET") return null;
        return accept.includes("vnd.pgrst.object") ? row : [row];
      };
      if (table === "trips") {
        if (method === "POST") {
          const row = JSON.parse(body || "{}");
          const id = row.id || crypto.randomUUID();
          const hit = trips.find((item) => item.id === id);
          const full = {
            created_by: userId,
            created_at: hit?.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString(),
            companions: [],
            ...row,
            id,
          };
          if (hit) Object.assign(hit, full);
          else trips.push(full);
          return { status: 201, json: represent(full) };
        }
        if (method === "GET") {
          const id = qp("id");
          const rows = id ? trips.filter((item) => item.id === id) : trips;
          return { status: 200, json: rows };
        }
        if (method === "PATCH") {
          const id = qp("id");
          const row = JSON.parse(body || "{}");
          const hit = trips.find((item) => item.id === id);
          if (!hit) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
          Object.assign(hit, row, { updated_at: new Date().toISOString() });
          return { status: 200, json: represent(hit) ?? [hit] };
        }
      }
      if (table === "trip_members" && method === "GET") {
        return { status: 200, json: [{ trip_id: qp("trip_id"), user_id: userId, role: "owner" }] };
      }
      if (method === "GET" || method === "HEAD") return { status: 200, json: [] };
      return { status: 200, json: null };
    },
  };
}

async function installSupabaseMocks(page, state) {
  await page.route(`**/${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const body = req.postData();
    const headers = req.headers();
    let result = { status: 404, json: {} };
    if (url.pathname.includes("/auth/v1/")) result = state.handleAuth(url, method, body);
    else if (url.pathname.includes("/rest/v1/rpc/")) result = { status: 200, json: [] };
    else if (url.pathname.includes("/rest/v1/")) result = state.handleRest(url, method, body, headers);
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

async function revealDate(page, iso) {
  for (let i = 0; i < 8; i += 1) {
    if ((await page.locator(`.calendar-day[data-date="${iso}"]`).count()) > 0) return;
    const earlier = page.locator('[data-testid="calendar-earlier"]');
    assert((await earlier.count()) === 1, "Frühere Monate fehlt");
    await earlier.click();
  }
  throw new Error(`${iso} nicht erreichbar`);
}

async function rangeState(page) {
  return page.evaluate(() => ({
    start: document.querySelector('[data-role="start-label"]')?.textContent?.trim() || "",
    end: document.querySelector('[data-role="end-label"]')?.textContent?.trim() || "",
    disabled: Boolean(document.querySelector('button[data-action="apply"]')?.disabled),
  }));
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
  const state = createMockSupabaseState();
  await installSupabaseMocks(page, state);
  try {
    await page.goto("./");
    await login(page);
    await page.click('[data-action="new"]');
    await page.waitForSelector(".form-header--minimal");
    await page.fill('[name="title"]', "Alte Reise");
    await page.click('[data-action="pick-dates"]');
    await page.waitForSelector(".calendar-month__title");

    const dates = await page.evaluate(() => {
      const now = new Date();
      const iso = (year, month, day) =>
        `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const year = now.getFullYear() - 2;
      const month = now.getMonth() + 1;
      return {
        yearMonth: `${now.getFullYear()}-${String(month).padStart(2, "0")}`,
        start: iso(year, month, 15),
        before: iso(year, month, 14),
        end: iso(year, month, 17),
        older: iso(year - 1, month, 15),
      };
    });

    const opened = await page.evaluate(() => {
      const months = [...document.querySelectorAll(".calendar-month")].map((el) => el.dataset.yearMonth);
      return {
        first: months[0] || "",
        count: months.length,
        earlier: document.querySelectorAll('[data-testid="calendar-earlier"]').length,
      };
    });
    assert(opened.earlier === 1, `${label}: Frühere Monate nicht da`);
    assert(opened.first === dates.yearMonth, `${label}: Kalender startet bei ${opened.first}`);
    assert(opened.count === 16, `${label}: ${opened.count} Monate statt 16`);
    assert(
      (await page.locator(`.calendar-day[data-date="${dates.start}"]`).count()) === 0,
      `${label}: Startdatum zwei Jahre zurück liegt schon in der ersten Ansicht`
    );

    await revealDate(page, dates.start);
    await revealDate(page, dates.before);
    const startBtn = page.locator(`.calendar-day[data-date="${dates.start}"]`);
    assert((await startBtn.count()) === 1, `${label}: Tag ${dates.start} fehlt`);
    assert(!(await startBtn.isDisabled()), `${label}: Tag ${dates.start} ist gesperrt`);

    await startBtn.click();
    await page.locator(`.calendar-day[data-date="${dates.before}"]`).click();
    const rejected = await rangeState(page);
    assert(rejected.end === "–", `${label}: Ende vor Start wurde übernommen (${rejected.end})`);
    assert(rejected.disabled, `${label}: Übernehmen ist trotz Ende vor Start aktiv`);

    // Der Klick vor dem Start setzt die Auswahl neu. Danach den Start erneut
    // wählen und ein späteres Ende setzen.
    await page.locator(`.calendar-day[data-date="${dates.start}"]`).click();
    await page.locator(`.calendar-day[data-date="${dates.start}"]`).click();
    await page.locator(`.calendar-day[data-date="${dates.end}"]`).click();
    await page.waitForFunction(() => !document.querySelector('button[data-action="apply"]')?.disabled);
    const accepted = await rangeState(page);
    assert(!accepted.disabled, `${label}: gültiger Zeitraum bleibt gesperrt`);
    assert(accepted.end !== "–", `${label}: Enddatum fehlt`);
    await page.click('button[data-action="apply"]');

    const dateLabel = await page.locator('[data-role="date-label"]').innerText();
    assert(dateLabel.includes("15.11."), `${label}: Zeitraum zeigt den Start nicht (${dateLabel})`);
    assert(dateLabel.includes("17.11."), `${label}: Zeitraum zeigt das Ende nicht (${dateLabel})`);
    assert(dateLabel.includes(String(dates.start.slice(0, 4))), `${label}: Jahr fehlt (${dateLabel})`);

    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-testid="trip-content"]');
    const saved = state.trips.find((row) => row.title === "Alte Reise");
    assert(saved, `${label}: Reise nicht gespeichert`);
    assert(saved.start_date === dates.start, `${label}: Start ${saved.start_date} statt ${dates.start}`);
    assert(saved.end_date === dates.end, `${label}: Ende ${saved.end_date} statt ${dates.end}`);
    assert(saved.end_date >= saved.start_date, `${label}: Ende liegt vor dem Start`);

    const tripId = await page.locator(".screen--trip").getAttribute("data-vacation-id");
    await page.evaluate((id) => {
      window.location.hash = `#/urlaub/${id}/bearbeiten`;
    }, tripId);
    await page.waitForSelector("h1.form-header__title");
    assert(
      (await page.locator("h1.form-header__title").innerText()) === "Reise bearbeiten",
      `${label}: Bearbeiten nicht offen`
    );
    await page.click('[data-action="pick-dates"]');
    await page.waitForSelector(".calendar-month__title");
    assert(
      (await page.locator('[data-testid="calendar-earlier"]').count()) === 0,
      `${label}: Bearbeiten erlaubt weitere Monate`
    );
    assert(
      (await page.locator(`.calendar-day[data-date="${dates.older}"]`).count()) === 0,
      `${label}: Bearbeiten zeigt ein Jahr vor dem Reisestart`
    );
    assert(
      (await page.locator(`.calendar-day[data-date="${dates.start}"]`).count()) === 1,
      `${label}: gespeicherter Start fehlt beim Bearbeiten`
    );
    assert(errors.length === 0, `${label}: ${errors.join(" | ")}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const { server, baseUrl } = await startServer();
  try {
    await runCase(chromium, { viewport: { width: 1280, height: 800 } }, baseUrl);
    await runCase(webkit, { ...devices["iPhone 12"] }, baseUrl);
  } finally {
    server.close();
  }
  console.log("Playwright ältere Startdaten OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
