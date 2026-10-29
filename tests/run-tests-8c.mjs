import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const FROM = "2026-10-15";
const NEXT = "2026-10-16";
const AFTER = "2026-10-17";
const FIRST = "2026-10-01";
const LAST = "2026-10-31";

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
      if (method === "GET" && ["waypoints", "notes", "media", "trip_members"].includes(table)) {
        return { status: 200, json: [] };
      }
      return { status: 404, json: { message: "not found" } };
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
}

function assertMark(info, day, label, what) {
  if (info.elapsed > 50) {
    throw new Error(`${label}: ${what} erst nach ${info.elapsed.toFixed(1)} ms`);
  }
  if (info.selected.length !== 1 || info.selected[0] !== day) {
    throw new Error(`${label}: ${what} aria-selected ${info.selected.join(",") || "—"}, erwartet ${day}`);
  }
  if (info.active.length !== 1 || info.active[0] !== day) {
    throw new Error(`${label}: ${what} day-chip--active ${info.active.join(",") || "—"}, erwartet ${day}`);
  }
}

async function waitForChipSettled(page, day) {
  await page.waitForFunction(
    (iso) => {
      const content = document.querySelector('[data-testid="trip-content"]');
      const row = document.querySelector(".day-chips");
      const chip = document.querySelector(`.day-chip[data-day="${iso}"]`);
      if (!content || !row || !chip) return false;
      if (content.dataset.activeDay !== iso) return false;
      if (chip.getAttribute("aria-selected") !== "true" || !chip.classList.contains("day-chip--active")) return false;
      if (document.querySelectorAll('.day-chip[aria-selected="true"]').length !== 1) return false;
      const c = row.getBoundingClientRect();
      const r = chip.getBoundingClientRect();
      const delta = r.left + r.width / 2 - (c.left + c.width / 2);
      const max = Math.max(0, row.scrollWidth - row.clientWidth);
      const clampedStart = row.scrollLeft <= 1 && delta <= 3;
      const clampedEnd = row.scrollLeft >= max - 1 && delta >= -3;
      const centered = Math.abs(delta) <= 3 || clampedStart || clampedEnd;
      if (!centered) {
        delete row.dataset.settleLeft;
        return false;
      }
      if (row.dataset.settleLeft == null || Math.abs(Number(row.dataset.settleLeft) - row.scrollLeft) > 0.5) {
        row.dataset.settleLeft = String(row.scrollLeft);
        row.dataset.settleAt = String(performance.now());
        return false;
      }
      return performance.now() - Number(row.dataset.settleAt) > 140;
    },
    day,
    { timeout: 8_000 }
  );
}

async function readChips(page) {
  return page.evaluate(() => {
    const row = document.querySelector(".day-chips");
    const chip = document.querySelector(".day-chip--active");
    const c = row.getBoundingClientRect();
    const r = chip.getBoundingClientRect();
    return {
      selected: [...document.querySelectorAll('.day-chip[aria-selected="true"]')].map((el) => el.dataset.day),
      active: [...document.querySelectorAll(".day-chip--active")].map((el) => el.dataset.day),
      scrollLeft: row.scrollLeft,
      delta: r.left + r.width / 2 - (c.left + c.width / 2),
      activeDay: document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay || "",
    };
  });
}

async function runSuite(browserType, baseUrl, label) {
  const browser = await browserType.launch({ headless: true });
  const ctx = await browser.newContext({
    ...devices["iPhone 8"],
    baseURL: baseUrl,
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  await page.addInitScript(() => {
    const deny = (_success, error) => {
      if (typeof error === "function") error({ code: 1, message: "denied" });
    };
    navigator.geolocation.getCurrentPosition = deny;
    navigator.geolocation.watchPosition = () => 1;

    window.__chipSnap = () => {
      const row = document.querySelector(".day-chips");
      const chip = document.querySelector(".day-chip--active");
      const selected = [...document.querySelectorAll('.day-chip[aria-selected="true"]')].map((el) => el.dataset.day);
      const active = [...document.querySelectorAll(".day-chip--active")].map((el) => el.dataset.day);
      const track = document.querySelector("[data-role='day-track']");
      const raw = track ? getComputedStyle(track).transitionDuration.split(",")[0].trim() : "0s";
      const duration = raw.endsWith("ms") ? parseFloat(raw) : raw.endsWith("s") ? parseFloat(raw) * 1000 : 0;
      let delta = null;
      if (row && chip) {
        const c = row.getBoundingClientRect();
        const r = chip.getBoundingClientRect();
        delta = r.left + r.width / 2 - (c.left + c.width / 2);
      }
      return {
        selected,
        active,
        scrollLeft: row ? row.scrollLeft : 0,
        delta,
        duration,
        activeDay: document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay || "",
        lock: document.querySelector('[data-testid="trip-content"]')?.dataset.swipeLock || "",
      };
    };

    window.__touchSwipe = (dx) => {
      const el = document.querySelector('[data-testid="trip-content"]');
      if (typeof Touch !== "function" || typeof TouchEvent !== "function") {
        throw new Error("Touch-Events fehlen");
      }
      const r = el.getBoundingClientRect();
      const x0 = r.left + Math.min(r.width / 2, 180);
      const y0 = r.top + Math.min(120, Math.max(24, r.height / 2));
      let modernTouch = true;
      try {
        new Touch({ identifier: 1, target: el, clientX: 0, clientY: 0, pageX: 0, pageY: 0 });
      } catch {
        modernTouch = false;
      }
      if (!modernTouch && typeof document.createTouch !== "function") {
        throw new Error("Touch-Events fehlen");
      }
      const fire = (phase, x, y) => {
        const touchType = phase === "start" ? "touchstart" : phase === "move" ? "touchmove" : "touchend";
        if (modernTouch) {
          const touch = new Touch({
            identifier: 1,
            target: el,
            clientX: x,
            clientY: y,
            pageX: x,
            pageY: y,
            radiusX: 2,
            radiusY: 2,
            rotationAngle: 0,
            force: 0.5,
          });
          const list = phase === "end" ? [] : [touch];
          el.dispatchEvent(
            new TouchEvent(touchType, {
              bubbles: true,
              cancelable: true,
              touches: list,
              targetTouches: list,
              changedTouches: [touch],
            })
          );
          return;
        }
        const touch = document.createTouch(window, el, 1, x + window.scrollX, y + window.scrollY, x, y);
        const list = document.createTouchList(touch);
        const empty = document.createTouchList();
        el.dispatchEvent(
          new TouchEvent(touchType, {
            bubbles: true,
            cancelable: true,
            touches: phase === "end" ? empty : list,
            targetTouches: phase === "end" ? empty : list,
            changedTouches: list,
          })
        );
      };
      fire("start", x0, y0);
      const steps = 8;
      for (let i = 1; i <= steps; i++) fire("move", x0 + (dx * i) / steps, y0);
      const t0 = performance.now();
      fire("end", x0 + dx, y0);
      return { elapsed: performance.now() - t0, ...window.__chipSnap() };
    };
  });

  const state = createMockSupabaseState();
  await installSupabaseMocks(page, state);
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto(baseUrl);
  await page.waitForSelector('[data-testid="login-screen"]');
  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  if (Number(build) !== 50) throw new Error(`${label}: Build ${build}, erwartet 50`);

  await page.fill('input[name="email"]', "test@example.com");
  await page.click('form[data-step="email"] button[type="submit"]');
  await page.waitForSelector('form[data-step="otp"]');
  await page.fill('input[name="otp"]', "123456");
  await page.click('form[data-step="otp"] button[type="submit"]');
  await page.waitForSelector(".screen--urlaube");

  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', "Paket 8c");
  await page.click('[data-action="pick-dates"]');
  await page.click(`.calendar-day[data-date="${FIRST}"]`);
  await page.click(`.calendar-day[data-date="${LAST}"]`);
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.waitForFunction(
    (n) => document.querySelectorAll(".day-chip").length === n,
    31,
    { timeout: 8_000 }
  );

  const box = await page.locator('[data-testid="trip-content"]').evaluate((el) => ({
    w: el.clientWidth,
    h: el.clientHeight,
  }));
  if (box.w < 200 || box.h < 80) {
    throw new Error(`${label}: Tagesfläche zu klein ${JSON.stringify(box)}`);
  }

  await page.click(`[data-day="${FROM}"]`);
  await waitForChipSettled(page, FROM);
  const tapped = await readChips(page);
  assertMark({ ...tapped, elapsed: 0 }, FROM, label, "Tipp");

  const beforeShort = await readChips(page);
  const short = await page.evaluate(() => window.__touchSwipe(-40));
  assertMark(short, FROM, label, "kurzer Wisch");
  if (short.duration >= 200 && short.duration <= 340) {
    throw new Error(`${label}: kurzer Wisch startet die Wechsel-Animation (${short.duration})`);
  }
  await page.waitForTimeout(420);
  const afterShort = await readChips(page);
  assertMark({ ...afterShort, elapsed: 0 }, FROM, label, "nach Zurückfedern");
  if (Math.abs(afterShort.scrollLeft - beforeShort.scrollLeft) > 1.5) {
    throw new Error(
      `${label}: Zurückfedern verschiebt die Chips (${beforeShort.scrollLeft} → ${afterShort.scrollLeft})`
    );
  }

  await page.click(`[data-day="${LAST}"]`);
  await waitForChipSettled(page, LAST);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="trip-content"]')?.dataset.canNext === "0"
  );
  const atEnd = await page.evaluate(() => window.__touchSwipe(-170));
  assertMark(atEnd, LAST, label, "Wisch am letzten Tag");
  await page.waitForTimeout(420);
  const atEndLater = await readChips(page);
  assertMark({ ...atEndLater, elapsed: 0 }, LAST, label, "letzter Tag danach");

  await page.click(`[data-day="${FIRST}"]`);
  await waitForChipSettled(page, FIRST);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="trip-content"]')?.dataset.canPrev === "0"
  );
  const atStart = await page.evaluate(() => window.__touchSwipe(170));
  assertMark(atStart, FIRST, label, "Wisch am ersten Tag");
  await page.waitForTimeout(420);
  const atStartLater = await readChips(page);
  assertMark({ ...atStartLater, elapsed: 0 }, FIRST, label, "erster Tag danach");

  await page.click(`[data-day="${FROM}"]`);
  await waitForChipSettled(page, FROM);

  const commit = await page.evaluate((target) => {
    const start = window.__chipSnap();
    const immediate = window.__touchSwipe(-170);
    const duringLock = window.__touchSwipe(-170);
    return new Promise((resolve) => {
      const track = document.querySelector("[data-role='day-track']");
      const row = document.querySelector(".day-chips");
      let finished = false;
      const finish = (via) => {
        if (finished) return;
        finished = true;
        const atEnd = window.__chipSnap();
        const samples = [];
        const t0 = performance.now();
        const tick = () => {
          samples.push({ t: performance.now() - t0, left: row.scrollLeft });
          if (performance.now() - t0 < 240) requestAnimationFrame(tick);
          else {
            const late = samples.filter((s) => s.t >= 100);
            const lateLeft = late.map((s) => s.left);
            const finalSnap = window.__chipSnap();
            resolve({
              via,
              startScroll: start.scrollLeft,
              immediate,
              duringLock,
              scrollAtEnd: atEnd.scrollLeft,
              dayAtEnd: atEnd.selected[0] || "",
              activeAtEnd: atEnd.active[0] || "",
              scrollFinal: finalSnap.scrollLeft,
              deltaFinal: finalSnap.delta,
              dayFinal: finalSnap.selected[0] || "",
              lateSpan: lateLeft.length ? Math.max(...lateLeft) - Math.min(...lateLeft) : 999,
            });
          }
        };
        requestAnimationFrame(tick);
      };
      const started = performance.now();
      const watch = () => {
        if (finished) return;
        const raw = getComputedStyle(track).transitionDuration.split(",")[0].trim();
        const duration = raw.endsWith("ms") ? parseFloat(raw) : raw.endsWith("s") ? parseFloat(raw) * 1000 : 0;
        if (duration < 20 && performance.now() - started > 40) {
          queueMicrotask(() => finish("settled"));
          return;
        }
        if (performance.now() - started > 800) finish("timeout");
        else requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
      if (immediate.selected[0] !== target) finish("early-mismatch");
    });
  }, NEXT);

  assertMark(commit.immediate, NEXT, label, "direkt nach Loslassen");
  if (commit.immediate.duration < 200 || commit.immediate.duration > 340) {
    throw new Error(`${label}: Seitenanimation läuft nicht (${commit.immediate.duration} ms)`);
  }
  if (commit.immediate.activeDay === NEXT) {
    throw new Error(`${label}: Inhalt ist schon vor Animationsende auf ${NEXT}`);
  }
  assertMark(commit.duringLock, NEXT, label, "zweiter Wisch während der Animation");
  if (commit.duringLock.selected[0] === AFTER) {
    throw new Error(`${label}: zweiter Wisch springt auf ${AFTER}`);
  }
  if (commit.via === "timeout" || commit.via === "early-mismatch") {
    throw new Error(`${label}: Animation nicht beendet (${commit.via})`);
  }
  if (commit.dayAtEnd !== NEXT || commit.activeAtEnd !== NEXT || commit.dayFinal !== NEXT) {
    throw new Error(`${label}: Markierung am Animationsende ${commit.dayAtEnd}/${commit.dayFinal}`);
  }
  if (Math.abs(commit.scrollAtEnd - commit.startScroll) < 30) {
    throw new Error(
      `${label}: Chips scrollen nicht mit der Seite (${commit.startScroll} → ${commit.scrollAtEnd})`
    );
  }
  if (Math.abs(commit.scrollFinal - commit.scrollAtEnd) > 12) {
    throw new Error(
      `${label}: Chips springen nach der Animation (${commit.scrollAtEnd} → ${commit.scrollFinal})`
    );
  }
  if (commit.lateSpan > 2) {
    throw new Error(`${label}: scrollLeft läuft nach (${commit.lateSpan.toFixed(2)} px)`);
  }
  if (Math.abs(commit.deltaFinal) > 4) {
    throw new Error(`${label}: Chip nicht mittig (${commit.deltaFinal.toFixed(1)} px)`);
  }

  await page.waitForFunction(
    (iso) => {
      const el = document.querySelector('[data-testid="trip-content"]');
      return el?.dataset.activeDay === iso && el.dataset.swipeLock !== "1";
    },
    NEXT,
    { timeout: 5_000 }
  );
  const followed = await readChips(page);
  assertMark({ ...followed, elapsed: 0 }, NEXT, label, "nach Finalisieren");
  if (Math.abs(followed.scrollLeft - commit.scrollFinal) > 2) {
    throw new Error(
      `${label}: Finalisieren setzt scrollLeft zurück (${commit.scrollFinal} → ${followed.scrollLeft})`
    );
  }

  const again = await page.evaluate(() => window.__touchSwipe(-170));
  assertMark(again, AFTER, label, "folgender Wisch");
  if (again.duration < 200) {
    throw new Error(`${label}: folgender Wisch ohne Animation (${again.duration})`);
  }
  await page.waitForFunction(
    (iso) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === iso,
    AFTER
  );
  const againLater = await readChips(page);
  assertMark({ ...againLater, elapsed: 0 }, AFTER, label, "folgender Tag bleibt markiert");

  const realErrors = errors.filter((err) => !/access control checks/.test(err));
  if (realErrors.length) throw new Error(`${label}: ${realErrors[0]}`);
  await browser.close();
  console.log(`8c ${label} OK`);
}

async function main() {
  const { server, baseUrl } = await startServer();
  try {
    await runSuite(chromium, baseUrl, "chromium");
    await runSuite(webkit, baseUrl, "webkit");
  } finally {
    server.close();
  }
  console.log("Playwright 8c tests OK (Build 50)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
