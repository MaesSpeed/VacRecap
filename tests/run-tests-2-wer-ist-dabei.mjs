import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";
import { tripRowToVacation, vacationToTripRow } from "../js/cloud-mappers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const USER = "11111111-1111-1111-1111-111111111111";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

const VIEWPORTS = [
  { width: 375, height: 667 },
  { width: 360, height: 740 },
  { width: 390, height: 844 },
];

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const sql = await readFile(path.join(root, "docs/supabase/paket-2-wer-ist-dabei.sql"), "utf8");
assert(sql.includes("add column if not exists companion_tags text[] not null default '{}'"), "SQL: Spalte");
assert(sql.includes("drop constraint if exists trips_companion_tags_check"), "SQL: Constraint nicht idempotent");
assert(
  sql.includes("companion_tags <@ array['allein', 'partner', 'familie', 'freunde']::text[]"),
  "SQL: Check"
);
assert(sql.includes("notify pgrst, 'reload schema'"), "SQL: Schema-Reload");
assert(/nicht ausgeführt/i.test(sql), "SQL: Hinweis fehlt, dass die Datei nicht ausgeführt wurde");

const mixed = tripRowToVacation({
  id: "1",
  title: "Rom",
  start_date: "2026-05-01",
  end_date: "2026-05-03",
  companions: ["Ada"],
  companion_tags: ["freunde", "allein", "nope"],
  cover_preset: "stadt",
  created_at: "2026-05-01T00:00:00.000Z",
  updated_at: "2026-05-01T00:00:00.000Z",
});
assert(mixed.companions.tags.join() === "allein", `Lesen mischt Allein (${mixed.companions.tags})`);
assert(mixed.companions.names.join() === "Ada", "Namen bleiben beim Lesen erhalten");

const bare = tripRowToVacation({
  id: "2",
  title: "Oslo",
  start_date: "2026-06-01",
  end_date: "2026-06-02",
  companions: [],
  cover_preset: "stadt",
  created_at: "2026-06-01T00:00:00.000Z",
  updated_at: "2026-06-01T00:00:00.000Z",
});
assert(bare.companions.tags.length === 0, "Lesen ohne companion_tags");

const written = vacationToTripRow({
  id: "1",
  title: "Rom",
  startDate: "2026-05-01",
  endDate: "2026-05-03",
  companions: { tags: ["familie", "partner", "fremd"], names: ["Ada", ""] },
  cover: { type: "preset", presetId: "stadt" },
});
assert(written.companion_tags.join() === "partner,familie", `Schreiben ${written.companion_tags}`);
assert(written.companions.join() === "Ada", "Leere Namen werden nicht geschrieben");
assert(written.cover_preset === "stadt", "Motiv bleibt beim Schreiben erhalten");

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
  const session = {
    access_token: "test-access",
    refresh_token: "test-refresh",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: { id: USER, aud: "authenticated", role: "authenticated", email: "test@example.com" },
  };
  const trips = [];
  const tripWrites = [];
  const tripReads = [];

  function forClient(row) {
    if (this.companionTagsColumn) return row;
    const copy = { ...row };
    delete copy.companion_tags;
    return copy;
  }

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
      else if (value === "not.is.null") out = out.filter((row) => row[key] != null);
      else if (value.startsWith("eq.")) out = out.filter((row) => String(row[key]) === value.slice(3));
      else if (value.startsWith("in.(") && value.endsWith(")")) {
        const set = new Set(value.slice(4, -1).split(",").map((part) => part.trim().replace(/^"|"$/g, "")));
        out = out.filter((row) => set.has(String(row[key])));
      }
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

  return {
    trips,
    tripWrites,
    tripReads,
    tripReadErrors: 0,
    companionTagsColumn: true,
    missingCode: "PGRST204",
    trip(id) {
      return trips.find((row) => row.id === id);
    },
    forClient,
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
      const upsert = (row) => {
        const id = row.id || crypto.randomUUID();
        const hit = trips.find((item) => item.id === id);
        const full = {
          created_by: USER,
          created_at: hit?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          cover_media_id: null,
          cover_preset: "stadt",
          companions: [],
          companion_tags: [],
          ...hit,
          ...row,
          id,
        };
        if (hit) Object.assign(hit, full);
        else trips.push(full);
        return full;
      };
      if (table === "trips" && (method === "POST" || method === "PATCH")) {
        const parsed = JSON.parse(body || "{}");
        tripWrites.push(parsed);
        if (!this.companionTagsColumn && Object.prototype.hasOwnProperty.call(parsed, "companion_tags")) {
          const code = this.missingCode || "PGRST204";
          return {
            status: 400,
            json: {
              code,
              message:
                code === "42703"
                  ? 'column "companion_tags" of relation "trips" does not exist'
                  : "Could not find the 'companion_tags' column of 'trips' in the schema cache",
              details: null,
              hint: null,
            },
          };
        }
        return { status: 201, json: represent(this.forClient(upsert(parsed)), headers) };
      }
      if (table === "trips" && method === "GET") {
        const select = url.searchParams.get("select") || "";
        tripReads.push(select);
        if (!this.companionTagsColumn && select.includes("companion_tags")) {
          this.tripReadErrors += 1;
          return {
            status: 400,
            json: {
              code: "PGRST204",
              message: "Could not find the 'companion_tags' column of 'trips' in the schema cache",
            },
          };
        }
        return sendRows(applyFilters(trips, url).map((row) => this.forClient(row)), headers);
      }
      if (table === "trip_members" && method === "GET") {
        const tripId = (url.searchParams.get("trip_id") || "").replace(/^eq\./, "");
        return sendRows([{ role: "owner", trip_id: tripId, user_id: USER }], headers);
      }
      if (method === "GET") return sendRows(applyFilters([], url), headers);
      return { status: 404, json: { message: `not found ${table} ${method}` } };
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
    const body = req.method() === "GET" || req.method() === "HEAD" ? null : req.postData();
    let result;
    if (url.pathname.includes("/auth/v1/")) result = state.handleAuth(url, req.method());
    else if (url.pathname.includes("/rest/v1/")) result = state.handleRest(url, req.method(), body, req.headers());
    else result = { status: 404, json: {} };
    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      headers: corsHeaders(req),
      body: result.json == null ? "" : JSON.stringify(result.json),
    });
  });
}

async function tagState(page) {
  const pairs = await page.locator('[data-role="tag-chips"] [data-tag]').evaluateAll((nodes) =>
    nodes.map((node) => [node.dataset.tag, node.getAttribute("aria-pressed")])
  );
  return Object.fromEntries(pairs);
}

async function clickTag(page, id) {
  const chip = page.locator(`[data-tag="${id}"]`);
  await chip.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await chip.click();
}

async function expectTags(page, on, label) {
  const state = await tagState(page);
  for (const id of ["allein", "partner", "familie", "freunde"]) {
    const want = on.includes(id) ? "true" : "false";
    assert(state[id] === want, `${label}: ${id} ist ${state[id]}, erwartet ${want}`);
  }
}

async function openEdit(page, tripId, title) {
  await page.evaluate((id) => {
    window.location.hash = `#/urlaub/${id}/bearbeiten`;
  }, tripId);
  await page.waitForFunction(
    ({ id, title: expected }) =>
      location.hash.includes(`/urlaub/${id}/bearbeiten`) &&
      document.querySelector('input[name="title"]')?.value === expected,
    { id: tripId, title }
  );
}

async function runFlows(page, state, label, missingCode) {
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
  await page.waitForSelector('[data-role="tag-chips"]');
  await page.fill('input[name="title"]', "Gardasee");
  await page.click('[data-action="pick-dates"]');
  await page.click('.calendar-day[data-date="2026-10-28"]');
  await page.click('.calendar-day[data-date="2026-10-30"]');
  await page.click('button[data-action="apply"]');

  const labels = (await page.locator('[data-role="tag-chips"] [data-tag]').allInnerTexts()).map((text) => text.trim());
  assert(labels.join("|") === "Allein|Partner:in|Familie|Freunde", `${label}: Beschriftungen ${labels.join("|")}`);
  assert(
    (await page.locator('[data-role="name-input"]').getAttribute("enterkeyhint")) === "done",
    `${label}: enterkeyhint`
  );
  await expectTags(page, [], label);

  await clickTag(page, "partner");
  await clickTag(page, "familie");
  await expectTags(page, ["partner", "familie"], label);
  await clickTag(page, "allein");
  await expectTags(page, ["allein"], label);
  await clickTag(page, "freunde");
  await expectTags(page, ["freunde"], label);
  await clickTag(page, "partner");
  await expectTags(page, ["partner", "freunde"], label);
  await clickTag(page, "partner");
  await expectTags(page, ["freunde"], label);
  await clickTag(page, "allein");
  await expectTags(page, ["allein"], label);
  await clickTag(page, "allein");
  await expectTags(page, [], label);
  await clickTag(page, "familie");
  await clickTag(page, "freunde");
  await expectTags(page, ["familie", "freunde"], label);

  await page.fill('[data-role="name-input"]', "Anna");
  await page.locator('input[name="title"]').click();
  await page.waitForFunction(() => (document.querySelector('[data-role="name-chips"]')?.textContent || "").includes("Anna"));
  assert((await page.locator('[data-role="name-input"]').inputValue()) === "", `${label}: Name bleibt im Feld`);
  await page.fill('[data-role="name-input"]', "Ben");
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => {
    const toast = document.querySelector('[data-testid="app-toast"]')?.textContent || "";
    return toast.includes("angelegt") && !toast.includes("Wer ist dabei noch nicht verfügbar");
  });
  await page.waitForSelector(".screen--trip");
  const tripId = await page.locator(".screen--trip").getAttribute("data-vacation-id");
  const stored = state.trip(tripId);
  assert(JSON.stringify(stored.companion_tags) === JSON.stringify(["familie", "freunde"]), `${label}: Tags ${stored.companion_tags}`);
  assert(JSON.stringify(stored.companions) === JSON.stringify(["Anna", "Ben"]), `${label}: Namen ${stored.companions}`);
  assert(
    (await page.locator(".screen--trip [data-testid='companion-tags']").getAttribute("data-tags")) === "familie freunde",
    `${label}: Detail zeigt die Tags nicht`
  );
  assert((await page.locator("[data-testid='companion-names']").innerText()).includes("Ben"), `${label}: Detail ohne pending Name`);
  assert((await page.locator(".screen--trip [data-testid='companion-tags']").innerText()).includes("Familie"), `${label}: Text Familie fehlt`);
  assert(!(await page.locator(".screen--trip [data-testid='companion-tags']").innerText()).includes("Allein"), `${label}: Allein steht fälschlich im Detail`);

  state.trips.push({
    id: "trip-wien",
    title: "Wien",
    start_date: "2026-09-01",
    end_date: "2026-09-05",
    companions: ["Ida"],
    companion_tags: ["partner", "familie"],
    cover_preset: "stadt",
    cover_media_id: null,
    created_by: USER,
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-01T10:00:00.000Z",
  });
  await page.evaluate(() => {
    window.location.hash = "#/urlaube";
  });
  await page.waitForSelector('[data-vacation-id="trip-wien"] [data-testid="companion-tags"]');
  await page.waitForSelector(`[data-vacation-id="${tripId}"] [data-testid="companion-tags"]`);
  assert(
    (await page.locator('[data-vacation-id="trip-wien"] [data-testid="companion-tags"]').getAttribute("data-tags")) === "partner familie",
    `${label}: kompakte Karte liest die Tags nicht`
  );
  assert(
    (await page.locator(`[data-vacation-id="${tripId}"] [data-testid="companion-tags"]`).getAttribute("data-tags")) === "familie freunde",
    `${label}: Reisekarte liest die Tags nicht`
  );
  assert(
    (await page.locator('[data-vacation-id="trip-wien"] [data-testid="companion-tags"]').innerText()).includes("Partner:in"),
    `${label}: Karte ohne Partner:in`
  );

  await openEdit(page, "trip-wien", "Wien");
  await expectTags(page, ["partner", "familie"], `${label} lesen`);
  assert((await page.locator('[data-role="name-chips"]').innerText()).includes("Ida"), `${label}: Name Ida fehlt im Formular`);

  state.companionTagsColumn = false;
  state.missingCode = missingCode;
  const readsBefore = state.tripReads.length;
  const writesBefore = state.tripWrites.length;
  await openEdit(page, tripId, "Gardasee");
  await expectTags(page, [], `${label} ohne Spalte`);
  await page.fill('input[name="title"]', "Gardasee ohne Spalte");
  await clickTag(page, "allein");
  await expectTags(page, ["allein"], `${label} Fallback`);
  await page.fill('[data-role="name-input"]', "Cem");
  await page.click('button[type="submit"]');
  await page.waitForFunction(() =>
    (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Wer ist dabei noch nicht verfügbar")
  );
  await page.waitForFunction(() =>
    (document.querySelector(".trip-header__title")?.textContent || "").includes("Gardasee ohne Spalte")
  );
  const attempts = state.tripWrites.slice(writesBefore);
  assert(attempts.length === 2, `${label}: Fallback schreibt ${attempts.length} statt 2`);
  assert(JSON.stringify(attempts[0].companion_tags) === JSON.stringify(["allein"]), `${label}: erster Versuch ${attempts[0].companion_tags}`);
  assert(!Object.prototype.hasOwnProperty.call(attempts[1], "companion_tags"), `${label}: zweiter Versuch enthält companion_tags`);
  assert(attempts[0].cover_preset === "stadt" && attempts[1].cover_preset === "stadt", `${label}: Motiv geht im Fallback verloren`);
  assert(attempts[1].title === "Gardasee ohne Spalte", `${label}: Titel nicht gespeichert`);
  assert(attempts[1].companions.includes("Cem") && attempts[1].companions.includes("Anna"), `${label}: Namen ${attempts[1].companions}`);
  assert(state.trip(tripId).title === "Gardasee ohne Spalte", `${label}: Zeile ohne neuen Titel`);
  assert((await page.locator(".screen--trip [data-testid='companion-tags']").count()) === 0, `${label}: Tags trotz fehlender Spalte sichtbar`);
  assert((await page.locator("[data-testid='companion-names']").innerText()).includes("Cem"), `${label}: pending Name fehlt nach Fallback`);

  const parallel = await page.evaluate(async (id) => {
    const { getAllVacations, getVacation } = await import("./js/db.js");
    const [all, one, two] = await Promise.all([getAllVacations(), getVacation(id), getVacation(id)]);
    return {
      count: all.length,
      tags: one?.companions?.tags || [],
      again: two?.companions?.tags || [],
      title: one?.title || "",
    };
  }, tripId);
  assert(parallel.count >= 2, `${label}: paralleles Lesen liefert ${parallel.count}`);
  assert(parallel.title === "Gardasee ohne Spalte", `${label}: paralleles Lesen ${parallel.title}`);
  assert(parallel.tags.length === 0 && parallel.again.length === 0, `${label}: paralleles Lesen erfindet Tags`);
  assert(state.tripReadErrors === 0, `${label}: Lesen scheitert ohne Spalte (${state.tripReadErrors})`);
  const selects = state.tripReads.slice(readsBefore);
  assert(selects.length >= 1 && selects.every((select) => select === "*"), `${label}: Select ${selects.join(" | ")}`);
}

async function runSuite(browserType, baseUrl, label, viewport, missingCode) {
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

  const where = `${label} ${viewport.width}x${viewport.height} ${missingCode}`;
  await page.goto(baseUrl);
  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  assert(Number(build) === 58, `${where}: Build ${build}`);
  await runFlows(page, state, where, missingCode);
  const unexpected = pageErrors.filter((err) => !err.includes("access control checks"));
  assert(!unexpected.length, `${where}: Seitenfehler ${unexpected.join(" | ")}`);
  await browser.close();
  console.log(`Playwright Paket 2 Wer ist dabei OK (${where})`);
}

const { server, baseUrl } = await startServer();
try {
  for (const viewport of VIEWPORTS) {
    await runSuite(chromium, baseUrl, "Chromium", viewport, "PGRST204");
    await runSuite(webkit, baseUrl, "WebKit", viewport, "42703");
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
