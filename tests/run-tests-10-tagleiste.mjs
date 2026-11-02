import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, webkit } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const START = "2026-10-26";
const END = "2026-11-01";
const LAST = "2026-11-01";
const OUTSIDE = "2020-01-01";
const SHORT_START = "2026-11-02";
const SHORT_END = "2026-11-03";

function resolveShotDir() {
  const candidates = [
    process.env.VACRECAP_SHOTS,
    path.join(__dirname, "artifacts"),
    path.join(os.tmpdir(), "vacrecap-paket10"),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      /* nächster Kandidat */
    }
  }
  return os.tmpdir();
}

const SHOTS = resolveShotDir();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const DESKTOP = [
  { width: 375, height: 667, name: "375" },
  { width: 390, height: 844, name: "390" },
  { width: 1366, height: 768, name: "1366" },
  { width: 1920, height: 1080, name: "1920" },
];

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function expectedChipWidth(viewportWidth) {
  return (Math.min(viewportWidth, 480) - 28 - 24) / 4;
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
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: { id: userId, aud: "authenticated", role: "authenticated", email: "test@example.com" },
  };
  const trips = [];
  const qp = (url, key) => {
    const raw = url.searchParams.get(key);
    return raw ? raw.replace(/^eq\./, "") : "";
  };
  return {
    handleAuth(url, method, body) {
      const pathName = url.pathname;
      if (pathName.endsWith("/otp") && method === "POST") return { status: 200, json: {} };
      if (pathName.endsWith("/verify") && method === "POST") {
        const parsed = JSON.parse(body || "{}");
        if (parsed.token !== "123456") return { status: 400, json: { error: "invalid_otp" } };
        return { status: 200, json: session };
      }
      if (pathName.endsWith("/token") && method === "POST") return { status: 200, json: session };
      if (pathName.endsWith("/user") && method === "GET") return { status: 200, json: session.user };
      return { status: 404, json: {} };
    },
    handleRest(url, method, body, headers) {
      const table = url.pathname.split("/").filter(Boolean).pop();
      const prefer = headers.prefer || "";
      if (table === "trips") {
        if (method === "POST") {
          const row = JSON.parse(body || "{}");
          const id = row.id || crypto.randomUUID();
          const full = {
            created_by: userId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            companions: [],
            ...row,
            id,
          };
          const hit = trips.find((t) => t.id === id);
          if (hit) Object.assign(hit, full);
          else trips.push(full);
          return { status: 201, json: prefer.includes("return=representation") ? [full] : null };
        }
        if (method === "GET") {
          const id = qp(url, "id");
          if (id) {
            const trip = trips.find((t) => t.id === id);
            return { status: 200, json: trip ? [trip] : [] };
          }
          return { status: 200, json: trips };
        }
      }
      if (method === "GET" && ["waypoints", "notes", "media", "trip_members", "profiles"].includes(table)) {
        return { status: 200, json: [] };
      }
      if (method === "GET") return { status: 200, json: [] };
      return { status: 200, json: null };
    },
  };
}

async function installSupabaseMocks(page, state) {
  await page.context().route(`**/${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const result = url.pathname.includes("/auth/v1/")
      ? state.handleAuth(url, req.method(), req.postData())
      : url.pathname.includes("/rest/v1/")
        ? state.handleRest(url, req.method(), req.postData(), req.headers())
        : { status: 404, json: {} };
    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      body: result.json ? JSON.stringify(result.json) : "",
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

async function installPageScripts(page) {
  await page.addInitScript(() => {
    const deny = (_success, error) => {
      if (typeof error === "function") error({ code: 1, message: "denied" });
    };
    navigator.geolocation.getCurrentPosition = deny;
    navigator.geolocation.watchPosition = () => 1;

    const RealDate = Date;
    const fixed = Date.parse("2026-10-26T12:00:00.000Z");
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
}

async function login(page, baseUrl) {
  await page.goto(baseUrl);
  await page.waitForSelector('[data-testid="login-screen"]');
  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  assert(Number(build) === 68, `Build ${build}, erwartet 68`);
  await page.fill('input[name="email"]', "test@example.com");
  await page.click('form[data-step="email"] button[type="submit"]');
  await page.waitForSelector('form[data-step="otp"]');
  await page.fill('input[name="otp"]', "123456");
  await page.click('form[data-step="otp"] button[type="submit"]');
  await page.waitForSelector(".screen--urlaube");
}

async function createTrip(page, title, start, end, days) {
  if (await page.locator('[data-testid="trip-content"]').count()) {
    await page.click(".link-btn--back");
    await page.waitForSelector(".screen--urlaube");
  }
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
  await page.waitForFunction((n) => document.querySelectorAll(".day-chip").length === n, days);
  await page.evaluate(() => document.fonts.ready);
}

async function measure(page) {
  return page.evaluate(() => {
    const row = document.querySelector(".day-chips");
    const rr = row.getBoundingClientRect();
    const shown = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && !el.hasAttribute("hidden");
    };
    const prev = document.querySelector("[data-testid='day-chips-prev']");
    const next = document.querySelector("[data-testid='day-chips-next']");
    const after = next ? getComputedStyle(next, "::after") : null;
    const chips = [...row.querySelectorAll(".day-chip")].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        day: el.dataset.day,
        width: r.width,
        full: r.width > 40 && r.left >= rr.left - 2 && r.right <= rr.right + 2,
        active: el.classList.contains("day-chip--active"),
      };
    });
    return {
      rowWidth: row.clientWidth,
      scrollLeft: row.scrollLeft,
      maxScroll: row.scrollWidth - row.clientWidth,
      chips,
      fullCount: chips.filter((chip) => chip.full).length,
      prev: shown(prev),
      next: shown(next),
      prevHidden: Boolean(prev?.hasAttribute("hidden")),
      nextHidden: Boolean(next?.hasAttribute("hidden")),
      prevDisplay: prev ? getComputedStyle(prev).display : "",
      nextDisplay: next ? getComputedStyle(next).display : "",
      hitW: after ? parseFloat(after.width) : 0,
      hitH: after ? parseFloat(after.height) : 0,
      fine: window.matchMedia("(hover: hover) and (pointer: fine)").matches,
      activeDay: document.querySelector("[data-testid='trip-content']")?.dataset.activeDay || "",
      activeChip: chips.find((chip) => chip.active)?.day || "",
      follow: row.classList.contains("day-chips--follow"),
    };
  });
}

async function clickArrow(page, testId) {
  const box = await page.locator(`[data-testid='${testId}']`).boundingBox();
  assert(box && box.width > 0 && box.height > 0, `Pfeil ${testId} ohne Fläche`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

function assertChipWidth(sample, viewportWidth, label) {
  const expected = expectedChipWidth(viewportWidth);
  const widths = sample.chips.map((chip) => chip.width);
  assert(sample.chips.length === 7, `${label}: ${sample.chips.length} Chips, erwartet 7`);
  for (const width of widths) {
    assert(
      Math.abs(width - expected) <= 2,
      `${label}: Chip ${width.toFixed(2)} px, erwartet ${expected.toFixed(2)} px`
    );
  }
  assert(
    sample.fullCount === 4,
    `${label}: am Leistenanfang ${sample.fullCount} Chips voll sichtbar, erwartet 4 (Mitte: 3 voll und 2 angeschnitten)`
  );
  assert(Math.abs(sample.scrollLeft) <= 2, `${label}: Leiste startet bei ${sample.scrollLeft}`);
}

async function saveActiveDay(page, day) {
  await page.evaluate(async (iso) => {
    const id = document.querySelector(".screen")?.dataset.vacationId;
    const { loadTripSelection, saveTripSelection } = await import("./js/trip-selection-store.js");
    const prev = (await loadTripSelection(id)) || { selectedByDay: {} };
    await saveTripSelection(id, { selectedByDay: prev.selectedByDay || {}, activeDay: iso });
    return id;
  }, day);
}

async function reopen(page) {
  const id = await page.locator(".screen").getAttribute("data-vacation-id");
  await page.click(".link-btn--back");
  await page.waitForSelector(".screen--urlaube");
  await page.locator(`.card[data-vacation-id="${id}"]`).click();
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.waitForFunction(() => document.querySelectorAll(".day-chip").length === 7);
  return id;
}

async function waitChipVisible(page, iso) {
  await page.waitForFunction(
    (day) => {
      const row = document.querySelector(".day-chips");
      const chip = document.querySelector(`.day-chip[data-day="${day}"]`);
      const content = document.querySelector('[data-testid="trip-content"]');
      if (!row || !chip || content?.dataset.activeDay !== day) return false;
      if (!chip.classList.contains("day-chip--active")) return false;
      const c = row.getBoundingClientRect();
      const r = chip.getBoundingClientRect();
      return r.left >= c.left - 2 && r.right <= c.right + 2;
    },
    iso,
    { timeout: 8_000 }
  );
}

async function runDesktop(browserType, baseUrl, label) {
  const browser = await browserType.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, baseURL: baseUrl });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  const state = createMockSupabaseState();
  await installSupabaseMocks(page, state);
  await installPageScripts(page);
  await login(page, baseUrl);
  await createTrip(page, "Paket 10", START, END, 7);

  const widths = {};
  for (const vp of DESKTOP) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForFunction(
      (n) => document.querySelectorAll(".day-chip").length === n,
      7
    );
    const sample = await measure(page);
    assertChipWidth(sample, vp.width, `${label} ${vp.name}`);
    widths[vp.name] = sample.chips[0].width;
    if (label === "chromium") {
      await page.locator(".day-nav").screenshot({ path: path.join(SHOTS, `tagleiste-${vp.name}.png`) });
    }
    console.log(
      `10 ${label} ${vp.name}: Chip ${sample.chips[0].width.toFixed(1)} px, ${sample.fullCount} sichtbar, Leiste ${sample.rowWidth.toFixed(0)} px`
    );
  }

  assert(
    Math.abs(widths["1366"] - widths["1920"]) < 1,
    `${label}: PC-Breiten verschieden (${widths["1366"]} / ${widths["1920"]})`
  );
  assert(
    Math.abs(widths["375"] - expectedChipWidth(375)) <= 2,
    `${label}: 375 px nicht bei ca. 81 px (${widths["375"]})`
  );

  await page.setViewportSize({ width: 1366, height: 768 });
  const desktop = await measure(page);
  assert(desktop.fine, `${label}: Desktop meldet keinen Mauszeiger`);
  assert(desktop.next && !desktop.prev, `${label}: Pfeile am Anfang prev=${desktop.prev} next=${desktop.next}`);
  assert(desktop.hitW >= 44 && desktop.hitH >= 44, `${label}: Tippfläche ${desktop.hitW}x${desktop.hitH}`);

  const dayBefore = desktop.activeDay;
  const box = await page.locator(".day-chips").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 220);
  await page.waitForFunction(() => document.querySelector(".day-chips").scrollLeft > 80);
  const wheeled = await measure(page);
  assert(wheeled.activeDay === dayBefore && wheeled.activeChip === dayBefore, `${label}: Mausrad wechselt den Tag`);
  assert(wheeled.prev, `${label}: Pfeil links fehlt nach dem Mausrad`);
  await page.mouse.wheel(0, -800);
  await page.waitForFunction(() => document.querySelector(".day-chips").scrollLeft < 2);

  const beforeDrag = (await measure(page)).scrollLeft;
  const y = box.y + box.height / 2;
  const x1 = box.x + box.width * 0.72;
  await page.mouse.move(x1, y);
  await page.mouse.down();
  await page.mouse.move(x1 - 160, y, { steps: 12 });
  await page.mouse.up();
  const dragged = await measure(page);
  assert(dragged.scrollLeft > beforeDrag + 40, `${label}: Ziehen scrollt nicht (${beforeDrag} → ${dragged.scrollLeft})`);
  assert(dragged.activeDay === dayBefore, `${label}: Ziehen wechselt den Tag auf ${dragged.activeDay}`);

  await page.evaluate(() => {
    document.querySelector(".day-chips").scrollLeft = 0;
  });
  await page.waitForFunction(() => {
    const next = document.querySelector("[data-testid='day-chips-next']");
    return next && !next.hasAttribute("hidden");
  });
  const beforeStep = (await measure(page)).scrollLeft;
  await clickArrow(page, "day-chips-next");
  const stepped = await measure(page);
  const step = expectedChipWidth(1366) + 8;
  assert(
    Math.abs(stepped.scrollLeft - beforeStep - step) <= 3,
    `${label}: Pfeil schiebt um ${stepped.scrollLeft - beforeStep}, erwartet ${step}`
  );
  assert(stepped.activeDay === dayBefore, `${label}: Pfeil wechselt den Tag`);
  let guard = 0;
  while ((await measure(page)).next && guard < 8) {
    await clickArrow(page, "day-chips-next");
    guard += 1;
  }
  const atEnd = await measure(page);
  assert(!atEnd.next && atEnd.prev, `${label}: Pfeile am Ende next=${atEnd.next} prev=${atEnd.prev}`);
  assert(atEnd.fullCount === 4, `${label}: am Leistenende ${atEnd.fullCount} Chips voll sichtbar, erwartet 4`);
  assert(atEnd.scrollLeft > 80, `${label}: Pfeile erreichen das Ende nicht`);
  await clickArrow(page, "day-chips-prev");
  const back = await measure(page);
  assert(back.scrollLeft < atEnd.scrollLeft - 40, `${label}: Pfeil links scrollt nicht (${atEnd.scrollLeft} → ${back.scrollLeft})`);
  assert(back.next, `${label}: Pfeil rechts fehlt nach links`);
  if (label === "chromium") {
    await page.locator(".day-nav").screenshot({ path: path.join(SHOTS, "tagleiste-1366-scrolled.png") });
  }

  await page.setViewportSize({ width: 1366, height: 768 });
  await saveActiveDay(page, LAST);
  await reopen(page);
  await waitChipVisible(page, LAST);
  const shownLast = await measure(page);
  assert(shownLast.activeDay === LAST, `${label}: letzter Tag bleibt nicht aktiv`);
  console.log(`10 ${label}: aktiver Tag ${LAST} liegt im sichtbaren Bereich`);

  await saveActiveDay(page, OUTSIDE);
  await reopen(page);
  await page.waitForFunction(
    (iso) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === iso,
    START
  );
  const fallback = await measure(page);
  assert(fallback.activeChip === START, `${label}: Tag außerhalb bleibt ${fallback.activeChip}`);
  assert(!fallback.chips.some((chip) => chip.day === OUTSIDE), `${label}: Tag außerhalb wird angezeigt`);
  console.log(`10 ${label}: Tag außerhalb fällt auf ${START} zurück`);

  const clickDay = await page.evaluate(() => {
    const row = document.querySelector(".day-chips").getBoundingClientRect();
    const chip = [...document.querySelectorAll(".day-chip")].find((el) => {
      if (el.classList.contains("day-chip--active")) return false;
      const r = el.getBoundingClientRect();
      return r.left > row.left + 50 && r.right < row.right - 50;
    });
    return chip?.dataset.day || "";
  });
  assert(clickDay, `${label}: kein Chip zum Antippen`);
  await page.locator(`.day-chip[data-day="${clickDay}"]`).click();
  await page.waitForFunction(
    (iso) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === iso,
    clickDay
  );

  await page.setViewportSize({ width: 1366, height: 768 });
  await page.locator('.day-chip[data-day="2026-10-29"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2026-10-29");
  await page.evaluate(() => {
    const row = document.querySelector(".day-chips");
    const chip = document.querySelector('.day-chip[data-day="2026-10-29"]');
    const c = row.getBoundingClientRect();
    const r = chip.getBoundingClientRect();
    row.scrollLeft += r.left + r.width / 2 - (c.left + c.width / 2);
  });
  const middle = await page.evaluate(() => {
    const row = document.querySelector(".day-chips").getBoundingClientRect();
    let full = 0;
    let partial = 0;
    for (const el of document.querySelectorAll(".day-chip")) {
      const r = el.getBoundingClientRect();
      const overlaps = r.right > row.left + 1 && r.left < row.right - 1;
      const inside = r.left >= row.left - 2 && r.right <= row.right + 2 && r.width > 40;
      if (inside) full += 1;
      else if (overlaps && r.width > 40) partial += 1;
    }
    return { full, partial };
  });
  assert(
    middle.full === 3 && middle.partial === 2,
    `${label}: mittig ${middle.full} voll und ${middle.partial} angeschnitten, erwartet 3 voll + 2 angeschnitten`
  );
  console.log(`10 ${label}: Mitte 3 voll + 2 angeschnitten, Anfang/Ende 4 voll`);

  await createTrip(page, "Paket 10 kurz", SHORT_START, SHORT_END, 2);
  await page.setViewportSize({ width: 1366, height: 768 });
  const fill = await measure(page);
  assert(fill.maxScroll < 2, `${label}: kurze Reise läuft über (${fill.maxScroll})`);
  assert(!fill.prev && !fill.next, `${label}: Pfeile ohne Überlauf`);

  const realErrors = errors.filter((err) => !/access control checks/.test(err));
  assert(!realErrors.length, `${label}: ${realErrors[0]}`);
  await browser.close();
  console.log(`10 Tag-Leiste ${label} Desktop OK`);
}

async function runPhone(browserType, baseUrl, label) {
  const browser = await browserType.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices["iPhone 8"], baseURL: baseUrl });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  const state = createMockSupabaseState();
  await installSupabaseMocks(page, state);
  await installPageScripts(page);
  await login(page, baseUrl);
  await createTrip(page, "Paket 10 Handy", START, END, 7);

  for (const vp of [
    { width: 375, height: 667, name: "375" },
    { width: 390, height: 844, name: "390" },
  ]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const sample = await measure(page);
    assertChipWidth(sample, vp.width, `${label} Handy ${vp.name}`);
    assert(!sample.fine, `${label} Handy ${vp.name}: feiner Zeiger`);
    assert(sample.prevDisplay === "none" && sample.nextDisplay === "none", `${label} Handy ${vp.name}: Pfeile sichtbar`);
    if (label === "chromium" && vp.name === "375") {
      await page.locator(".day-nav").screenshot({ path: path.join(SHOTS, "tagleiste-handy-375.png") });
    }
    console.log(`10 ${label} Handy ${vp.name}: Chip ${sample.chips[0].width.toFixed(1)} px, Pfeile aus`);
  }

  const realErrors = errors.filter((err) => !/access control checks/.test(err));
  assert(!realErrors.length, `${label} Handy: ${realErrors[0]}`);
  await browser.close();
  console.log(`10 Tag-Leiste ${label} Handy OK`);
}

async function assertSource() {
  const css = await readFile(path.join(root, "css/styles.css"), "utf8");
  assert(
    css.includes("min-width: calc((min(100vw, 480px) - 28px - 24px) / 4);"),
    "CSS koppelt die Chip-Breite nicht an die App-Spalte"
  );
  const detail = await readFile(path.join(root, "js/ui-urlaub-detail.js"), "utf8");
  assert(detail.includes("days.includes(savedDay)"), "gespeicherter Tag wird nicht geprüft");
  assert(detail.includes("days.includes(state.activeDay)"), "aktiver Tag wird nicht geprüft");
}

async function main() {
  await assertSource();
  const { server, baseUrl } = await startServer();
  try {
    await runDesktop(chromium, baseUrl, "chromium");
    await runDesktop(webkit, baseUrl, "webkit");
    await runPhone(chromium, baseUrl, "chromium");
    await runPhone(webkit, baseUrl, "webkit");
  } finally {
    server.close();
  }
  console.log(`Playwright 10 Tag-Leiste OK (Build 68, Bilder in ${SHOTS})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
