import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const LONG_START = "2026-10-01";
const LONG_END = "2026-10-31";
const MID = "2026-10-15";
const FILL_START = "2026-11-02";
const FILL_END = "2026-11-05";
const ONE = "2026-11-10";
const VIEWPORTS = [
  { width: 375, height: 667, name: "375x667" },
  { width: 360, height: 740, name: "360x740" },
  { width: 390, height: 844, name: "390x844" },
];

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

function shiftIso(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

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
  const hits = [];
  const qp = (url, key) => {
    const raw = url.searchParams.get(key);
    return raw ? raw.replace(/^eq\./, "") : "";
  };
  return {
    hits,
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
      hits.push({ method, table, search: url.search });
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

function chipOf(measure, iso) {
  return measure.chips.find((chip) => chip.day === iso);
}

function progressBetween(measure, from, to) {
  const a = chipOf(measure, from);
  const b = chipOf(measure, to);
  const span = b.center - a.center;
  return {
    a,
    b,
    span,
    got: span === 0 ? 0 : (measure.mark.center - a.center) / span,
  };
}

function assertLiveFollow(measure, from, to, frac, label) {
  const { a, b, got } = progressBetween(measure, from, to);
  const lo = Math.min(a.center, b.center);
  const hi = Math.max(a.center, b.center);
  assert(
    measure.mark.center > lo + 2 && measure.mark.center < hi - 2,
    `${label}: Markierung nicht zwischen den Chips (${measure.mark.center.toFixed(1)} nicht in ${lo.toFixed(1)}..${hi.toFixed(1)})`
  );
  assert(
    Math.abs(got - frac) <= 0.18,
    `${label}: Chip-Fortschritt ${got.toFixed(2)}, erwartet ${frac}`
  );
  assert(measure.mark.opacity >= 0.9, `${label}: Markierung nicht sichtbar`);
  assert(measure.follow, `${label}: Chip-Leiste folgt der Geste nicht`);
  assert(measure.active.length === 1 && measure.active[0] === from, `${label}: Tag springt schon während der Geste`);
  assert(measure.activeDay === from, `${label}: Inhalt wechselt schon während der Geste`);
  assert(
    Math.abs(measure.contentFrac - got) <= 0.14,
    `${label}: Inhalt (${measure.contentFrac.toFixed(2)}) und Chip (${got.toFixed(2)}) laufen nicht zusammen`
  );
  const row = measure.row;
  assert(
    b.right > row.left + 1 && b.left < row.right - 1,
    `${label}: Ziel-Chip bleibt nicht sichtbar`
  );
}

function assertRubber(measure, day, direction, label) {
  const chip = chipOf(measure, day);
  const shift = measure.mark.center - chip.center;
  assert(measure.active.length === 1 && measure.active[0] === day, `${label}: Randtag verliert die Markierung`);
  assert(measure.activeDay === day, `${label}: Randtag wechselt den Inhalt`);
  assert(measure.follow, `${label}: Gummiband ohne laufende Geste`);
  if (direction > 0) assert(shift >= 4, `${label}: kein Gummiband (${shift.toFixed(1)} px)`);
  else assert(shift <= -4, `${label}: kein Gummiband (${shift.toFixed(1)} px)`);
  assert(Math.abs(shift) <= chip.width * 0.4, `${label}: Markierung läuft über (${shift.toFixed(1)} px)`);
  assert(measure.contentFrac * direction > 0.02, `${label}: Inhalt federt nicht mit`);
  assert(Math.abs(measure.contentFrac) < 0.45, `${label}: Inhalt läuft über den Rand (${measure.contentFrac.toFixed(2)})`);
}

async function waitReady(page, day) {
  try {
    await page.waitForFunction(
    (iso) => {
      const content = document.querySelector('[data-testid="trip-content"]');
      const row = document.querySelector(".day-chips");
      const chip = document.querySelector(`.day-chip[data-day="${iso}"]`);
      if (!content || !row || !chip) return false;
      if (content.dataset.swipeLock === "1" || content.dataset.gesture === "1") return false;
      if (row.classList.contains("day-chips--follow")) return false;
      if (content.dataset.activeDay !== iso) return false;
      if (!chip.classList.contains("day-chip--active") || chip.getAttribute("aria-selected") !== "true") return false;
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
      return performance.now() - Number(row.dataset.settleAt) > 120;
    },
    day,
    { timeout: 8_000 }
  );
  } catch (err) {
    const snap = await page.evaluate((iso) => {
      const content = document.querySelector('[data-testid="trip-content"]');
      const row = document.querySelector(".day-chips");
      const chip = document.querySelector(`.day-chip[data-day="${iso}"]`);
      const c = row?.getBoundingClientRect();
      const r = chip?.getBoundingClientRect();
      const delta = c && r ? r.left + r.width / 2 - (c.left + c.width / 2) : null;
      return {
        activeDay: content?.dataset.activeDay || "",
        lock: content?.dataset.swipeLock || "",
        gesture: content?.dataset.gesture || "",
        follow: Boolean(row?.classList.contains("day-chips--follow")),
        active: document.querySelector(".day-chip--active")?.dataset.day || "",
        scrollLeft: row?.scrollLeft ?? null,
        max: row ? Math.max(0, row.scrollWidth - row.clientWidth) : null,
        delta,
      };
    }, day);
    throw new Error(`${day} nicht bereit ${JSON.stringify(snap)} (${err.message})`);
  }
}

async function gotoDay(page, iso) {
  const clicked = await page.evaluate(async (day) => {
    const row = document.querySelector(".day-chips");
    const chip = row?.querySelector(`[data-day="${day}"]`);
    if (!chip) return { ok: false, activeDay: "" };
    chip.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const max = Math.max(0, row.scrollWidth - row.clientWidth);
    const bounds = row.getBoundingClientRect();
    const rect = chip.getBoundingClientRect();
    const delta = rect.left + rect.width / 2 - (bounds.left + bounds.width / 2);
    row.scrollLeft = Math.max(0, Math.min(max, row.scrollLeft + delta));
    return {
      ok: true,
      activeDay: document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay || "",
    };
  }, iso);
  assert(clicked.ok, `${iso}: Chip fehlt`);
  assert(clicked.activeDay === iso, `Tipp auf ${iso} lässt den Tag auf ${clicked.activeDay || "—"}`);
  try {
    await waitReady(page, iso);
  } catch (err) {
    const snap = await page.evaluate(() => window.__measure());
    throw new Error(
      `Tag ${iso} nicht bereit (aktiv ${snap.activeDay}, follow ${snap.follow}, scroll ${snap.scrollLeft.toFixed(1)}): ${err.message}`
    );
  }
}

async function createTrip(page, title, start, end) {
  if (await page.locator('[data-testid="trip-content"]').count()) {
    await page.click(".link-btn--back");
    await page.waitForSelector(".screen--urlaube");
  }
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', title);
  await page.click('[data-action="pick-dates"]');
  await page.click(`.calendar-day[data-date="${start}"]`);
  await page.click(`.calendar-day[data-date="${end}"]`);
  await page.waitForFunction(() => {
    const btn = document.querySelector('button[data-action="apply"]');
    return btn && !btn.disabled;
  });
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');
}

async function quietHits(state) {
  let last = -1;
  for (let i = 0; i < 16; i += 1) {
    if (state.hits.length === last) {
      state.hits.length = 0;
      return;
    }
    last = state.hits.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  state.hits.length = 0;
}

async function runLongTrip(page, state, where, { reduced = false } = {}) {
  const count = await page.locator(".day-chip").count();
  assert(count >= 30, `${where}: erwartet mindestens 30 Tage, hat ${count}`);
  await gotoDay(page, MID);
  const next = shiftIso(MID, 1);
  const width = await page.evaluate(() => document.querySelector('[data-testid="trip-content"]').clientWidth);

  if (!reduced) {
    await quietHits(state);
    await page.evaluate(() => {
      window.__sawSkeleton = false;
      const root = document.querySelector('[data-testid="trip-content"]');
      window.__skObs?.disconnect();
      window.__skObs = new MutationObserver(() => {
        if (root.querySelector("[data-testid='day-skeleton']")) window.__sawSkeleton = true;
      });
      window.__skObs.observe(root, { childList: true, subtree: true });
    });
  }

  const beforeHalf = await page.evaluate(() => window.__measure());
  await page.evaluate(
    ({ dx, kind }) => {
      window.__down(kind);
      window.__move(dx);
    },
    { dx: -width / 2, kind: "touch" }
  );
  const mid = await page.evaluate(() => window.__measure());
  assertLiveFollow(mid, MID, next, 0.5, `${where}: Halber Wisch`);
  if (beforeHalf.maxScroll > 24) {
    assert(
      mid.scrollLeft - beforeHalf.scrollLeft > 12,
      `${where}: Chip-Leiste scrollt nicht mit (${beforeHalf.scrollLeft.toFixed(1)} → ${mid.scrollLeft.toFixed(1)})`
    );
  }
  await page.evaluate(() => window.__up());
  await waitReady(page, next);
  const snapped = await page.evaluate(() => window.__measure());
  assert(snapped.activeDay === next && snapped.active[0] === next, `${where}: rastet nicht auf dem Zieltag ein`);
  assert(!snapped.follow, `${where}: Markierung bleibt nach dem Einrasten hängen`);
  if (!reduced) {
    const sawSkeleton = await page.evaluate(() => window.__sawSkeleton);
    assert(!sawSkeleton, `${where}: Tagesinhalt flackert (Skeleton) beim Einrasten`);
    const notes = state.hits.filter((hit) => hit.table === "notes");
    const ways = state.hits.filter((hit) => hit.table === "waypoints");
    assert(ways.length === 0, `${where}: Wegpunkte werden beim Wisch erneut geladen (${ways.length})`);
    assert(notes.length <= 1, `${where}: Notizen doppelt geladen (${notes.length})`);
  }

  if (reduced) return;

  await gotoDay(page, MID);
  const beforeCancel = await page.evaluate(() => window.__measure());
  await page.evaluate(() => {
    window.__down("pointer");
    window.__move(-36);
  });
  const partial = await page.evaluate(() => window.__measure());
  const partialProg = progressBetween(partial, MID, next);
  assert(partialProg.got > 0.04 && partialProg.got < 0.4, `${where}: Abbruch-Geste folgt nicht (${partialProg.got.toFixed(2)})`);
  assert(partial.mark.center > Math.min(partialProg.a.center, partialProg.b.center) + 2, `${where}: Markierung klebt beim Abbruch`);
  assert(partial.activeDay === MID && partial.active[0] === MID, `${where}: Abbruch-Geste committet den Tag`);
  await page.evaluate(() => window.__up());
  await waitReady(page, MID);
  const cancelled = await page.evaluate(() => window.__measure());
  assert(cancelled.activeDay === MID && cancelled.active[0] === MID, `${where}: abgebrochene Geste springt nicht zurück`);
  assert(!cancelled.follow, `${where}: Follow bleibt nach Abbruch an`);
  assert(
    Math.abs(cancelled.scrollLeft - beforeCancel.scrollLeft) <= 1.5,
    `${where}: Chip-Leiste steht nach Abbruch woanders (${beforeCancel.scrollLeft} → ${cancelled.scrollLeft})`
  );

  const armed = await page.evaluate(() => {
    const current = document.querySelector("[data-page='current']");
    const spacer = document.createElement("div");
    spacer.dataset.testid = "scroll-spacer";
    spacer.style.height = "900px";
    current.appendChild(spacer);
    current.scrollTop = 160;
    return current.scrollTop;
  });
  assert(armed > 100, `${where}: Inhalt lässt sich nicht scrollen (${armed})`);
  await page.evaluate(() => {
    window.__down("touch");
    window.__move(-30);
    window.__up();
  });
  await waitReady(page, MID);
  const scrolled = await page.evaluate(() => {
    const current = document.querySelector("[data-page='current']");
    return {
      top: current.scrollTop,
      spacer: Boolean(current.querySelector("[data-testid='scroll-spacer']")),
    };
  });
  assert(scrolled.spacer, `${where}: Tagesinhalt wird beim Abbruch neu geladen`);
  assert(scrolled.top > 100, `${where}: Scrollposition geht beim Abbruch verloren (${scrolled.top})`);
  await page.evaluate(() => document.querySelector("[data-testid='scroll-spacer']")?.remove());

  await gotoDay(page, LONG_END);
  await page.evaluate(() => {
    window.__down("touch");
    window.__move(-160);
  });
  const atEnd = await page.evaluate(() => window.__measure());
  assertRubber(atEnd, LONG_END, 1, `${where}: letzter Tag`);
  await page.evaluate(() => window.__up());
  await waitReady(page, LONG_END);

  await gotoDay(page, LONG_START);
  await page.evaluate(() => {
    window.__down("touch");
    window.__move(160);
  });
  const atStart = await page.evaluate(() => window.__measure());
  assertRubber(atStart, LONG_START, -1, `${where}: erster Tag`);
  await page.evaluate(() => window.__up());
  await waitReady(page, LONG_START);

  await gotoDay(page, MID);
  const flicking = await page.evaluate(() => {
    window.__down("touch");
    window.__move(-12);
    const started = performance.now();
    while (performance.now() - started < 20) {}
    window.__move(-40);
    return window.__measure();
  });
  const flickProg = progressBetween(flicking, MID, next);
  assert(flickProg.got > 0.03 && flickProg.got < 0.45, `${where}: Flick folgt nicht (${flickProg.got.toFixed(2)})`);
  assert(flicking.activeDay === MID, `${where}: Flick committet vor dem Loslassen`);
  await page.evaluate(() => window.__up());
  await waitReady(page, next);
  const flicked = await page.evaluate(() => window.__measure());
  assert(flicked.activeDay === next && flicked.active[0] === next, `${where}: Flick landet nicht auf dem Nachbartag`);

  const tapped = await page.evaluate((iso) => {
    const t0 = performance.now();
    document.querySelector(`.day-chip[data-day="${iso}"]`).click();
    const content = document.querySelector('[data-testid="trip-content"]');
    return {
      dt: performance.now() - t0,
      activeDay: content.dataset.activeDay,
      selected: document.querySelector(".day-chip--active")?.dataset.day,
      count: document.querySelectorAll('.day-chip[aria-selected="true"]').length,
    };
  }, "2026-10-20");
  assert(tapped.dt < 250, `${where}: Chip-Tipp dauert ${tapped.dt.toFixed(0)} ms`);
  assert(tapped.activeDay === "2026-10-20" && tapped.selected === "2026-10-20", `${where}: Chip-Tipp zeigt nicht sofort den Tag`);
  assert(tapped.count === 1, `${where}: Chip-Tipp markiert mehrere Tage`);
  await waitReady(page, "2026-10-20");

  const during = "2026-10-18";
  const fromDuring = "2026-10-10";
  await gotoDay(page, fromDuring);
  const landed = await page.evaluate((iso) => {
    window.__down("touch");
    window.__move(-180);
    window.__up();
    document.querySelector(`.day-chip[data-day="${iso}"]`).click();
    return document.querySelector('[data-testid="trip-content"]').dataset.activeDay;
  }, during);
  assert(landed === during, `${where}: Tipp während des Einrastens landet auf ${landed}`);
  await page.waitForTimeout(700);
  const later = await page.evaluate(() => document.querySelector('[data-testid="trip-content"]').dataset.activeDay);
  assert(later === during, `${where}: Tipp während des Einrastens rutscht auf ${later}`);
  await waitReady(page, during);

  const origin = "2026-10-12";
  const preview = shiftIso(origin, 1);
  await gotoDay(page, origin);
  const previewTap = await page.evaluate((iso) => {
    window.__down("touch");
    window.__move(-180);
    window.__up();
    document.querySelector(`.day-chip[data-day="${iso}"]`).click();
    return document.querySelector('[data-testid="trip-content"]').dataset.activeDay;
  }, preview);
  assert(previewTap === preview, `${where}: Tipp auf den Ziel-Chip landet auf ${previewTap}`);
  await page.waitForTimeout(700);
  const previewLater = await page.evaluate(() => document.querySelector('[data-testid="trip-content"]').dataset.activeDay);
  assert(previewLater === preview, `${where}: Ziel-Chip rutscht nach dem Tipp auf ${previewLater}`);
  await waitReady(page, preview);

  await gotoDay(page, origin);
  const abortTap = await page.evaluate((iso) => {
    window.__down("touch");
    window.__move(-180);
    window.__up();
    document.querySelector(`.day-chip[data-day="${iso}"]`).click();
    return document.querySelector('[data-testid="trip-content"]').dataset.activeDay;
  }, origin);
  assert(abortTap === origin, `${where}: Tipp auf den Ausgangstag landet auf ${abortTap}`);
  await page.waitForTimeout(700);
  const abortLater = await page.evaluate(() => document.querySelector('[data-testid="trip-content"]').dataset.activeDay);
  assert(abortLater === origin, `${where}: Ausgangstag rutscht nach dem Tipp auf ${abortLater}`);
  await waitReady(page, origin);
}

async function runFillTrip(page, where) {
  const count = await page.locator(".day-chip").count();
  assert(count === 4, `${where}: Vier-Tage-Reise hat ${count} Chips`);
  const fill = await page.evaluate(() => document.querySelector(".day-chips").classList.contains("day-chips--fill"));
  assert(fill, `${where}: wenige Tage füllen die Leiste nicht`);
  await gotoDay(page, FILL_START);
  const next = shiftIso(FILL_START, 1);
  const before = await page.evaluate(() => window.__measure());
  const width = await page.evaluate(() => document.querySelector('[data-testid="trip-content"]').clientWidth);
  await page.evaluate((dx) => {
    window.__down("pointer");
    window.__move(dx);
  }, -width / 2);
  const mid = await page.evaluate(() => window.__measure());
  assertLiveFollow(mid, FILL_START, next, 0.5, `${where}: Pointer-Wisch`);
  assert(Math.abs(mid.scrollLeft - before.scrollLeft) <= 2, `${where}: volle Chip-Leiste scrollt ohne Bedarf`);
  await page.evaluate(() => window.__up());
  await waitReady(page, next);
}

async function runSingleTrip(page, where) {
  const count = await page.locator(".day-chip").count();
  assert(count === 1, `${where}: Ein-Tag-Reise hat ${count} Chips`);
  await waitReady(page, ONE);
  for (const dx of [-140, 140]) {
    await page.evaluate((delta) => {
      window.__down("touch");
      window.__move(delta);
    }, dx);
    const mid = await page.evaluate(() => window.__measure());
    const chip = chipOf(mid, ONE);
    const shift = mid.mark.center - chip.center;
    assert(mid.activeDay === ONE && mid.active[0] === ONE, `${where}: einzelner Tag wechselt`);
    assert(Math.abs(shift) >= 4, `${where}: einzelner Tag ohne Gummiband (${shift.toFixed(1)})`);
    assert(Math.abs(shift) <= chip.width * 0.4, `${where}: einzelner Tag läuft über (${shift.toFixed(1)})`);
    assert(Math.abs(mid.contentFrac) < 0.45 && Math.abs(mid.contentFrac) > 0.02, `${where}: Inhalt am einzelnen Tag falsch (${mid.contentFrac.toFixed(2)})`);
    await page.evaluate(() => window.__up());
    await waitReady(page, ONE);
  }
  await page.evaluate(() => {
    window.__down("pointer");
    window.__move(-80);
    window.__cancel();
  });
  await waitReady(page, ONE);
  const after = await page.evaluate(() => window.__measure());
  assert(after.activeDay === ONE && !after.follow, `${where}: Pointer-Abbruch am einzelnen Tag`);
}

async function runSuite(browserType, baseUrl, engine) {
  const browser = await browserType.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
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

    let gesture = null;
    let modernTouch = null;

    function touchMode() {
      if (modernTouch != null) return modernTouch;
      try {
        new Touch({ identifier: 1, target: document.body, clientX: 0, clientY: 0, pageX: 0, pageY: 0 });
        modernTouch = true;
      } catch {
        modernTouch = false;
      }
      if (!modernTouch && typeof document.createTouch !== "function") throw new Error("Touch-Events fehlen");
      return modernTouch;
    }

    function fireTouch(el, phase, x, y) {
      const touchType =
        phase === "start" ? "touchstart" : phase === "move" ? "touchmove" : phase === "cancel" ? "touchcancel" : "touchend";
      const ended = phase === "end" || phase === "cancel";
      if (touchMode()) {
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
        return;
      }
      const touch = document.createTouch(window, el, 1, x + window.scrollX, y + window.scrollY, x, y);
      const list = document.createTouchList(touch);
      const empty = document.createTouchList();
      el.dispatchEvent(
        new TouchEvent(touchType, {
          bubbles: true,
          cancelable: true,
          touches: ended ? empty : list,
          targetTouches: ended ? empty : list,
          changedTouches: list,
        })
      );
    }

    function firePointer(el, phase, x, y) {
      const type =
        phase === "start" ? "pointerdown" : phase === "move" ? "pointermove" : phase === "cancel" ? "pointercancel" : "pointerup";
      el.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
          buttons: phase === "end" || phase === "cancel" ? 0 : 1,
          clientX: x,
          clientY: y,
          width: 1,
          height: 1,
          pressure: phase === "end" || phase === "cancel" ? 0 : 0.5,
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
      gesture = {
        el,
        kind,
        x0: rect.left + rect.width / 2,
        y0: rect.top + Math.min(120, Math.max(28, rect.height / 2)),
        x: rect.left + rect.width / 2,
      };
      fire("start", gesture.x0, gesture.y0);
    };
    window.__move = (dx) => {
      gesture.x = gesture.x0 + dx;
      fire("move", gesture.x, gesture.y0);
    };
    window.__up = () => fire("end", gesture.x, gesture.y0);
    window.__cancel = () => fire("cancel", gesture.x, gesture.y0);
    window.__measure = () => {
      const row = document.querySelector(".day-chips");
      const mark = document.querySelector("[data-testid='day-chip-mark']");
      const host = document.querySelector('[data-testid="trip-content"]');
      const current = host?.querySelector("[data-page='current']");
      const markRect = mark.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      const pageRect = current.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      return {
        active: [...document.querySelectorAll(".day-chip--active")].map((el) => el.dataset.day),
        activeDay: host.dataset.activeDay || "",
        follow: row.classList.contains("day-chips--follow"),
        mark: {
          center: markRect.left + markRect.width / 2,
          opacity: Number(getComputedStyle(mark).opacity),
        },
        chips: [...document.querySelectorAll(".day-chip")].map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            day: el.dataset.day,
            center: rect.left + rect.width / 2,
            left: rect.left,
            right: rect.right,
            width: rect.width,
          };
        }),
        scrollLeft: row.scrollLeft,
        maxScroll: Math.max(0, row.scrollWidth - row.clientWidth),
        row: { left: rowRect.left, right: rowRect.right },
        contentFrac: hostRect.width ? (hostRect.left - pageRect.left) / hostRect.width : 0,
      };
    };
  });

  const state = createMockSupabaseState();
  await installSupabaseMocks(page, state);
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto(baseUrl);
  await page.waitForSelector('[data-testid="login-screen"]');
  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  assert(Number(build) === 62, `${engine}: Build ${build}, erwartet 62`);
  await page.fill('input[name="email"]', "test@example.com");
  await page.click('form[data-step="email"] button[type="submit"]');
  await page.waitForSelector('form[data-step="otp"]');
  await page.fill('input[name="otp"]', "123456");
  await page.click('form[data-step="otp"] button[type="submit"]');
  await page.waitForSelector(".screen--urlaube");

  await createTrip(page, "Paket 4", LONG_START, LONG_END);
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await runLongTrip(page, state, `${engine} ${vp.name}`);
    console.log(`4 chip-wisch ${engine} ${vp.name} OK`);
  }

  await page.setViewportSize({ width: 375, height: 667 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await runLongTrip(page, state, `${engine} reduced`, { reduced: true });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  console.log(`4 chip-wisch ${engine} reduced OK`);

  await createTrip(page, "Paket 4 vier Tage", FILL_START, FILL_END);
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await runFillTrip(page, `${engine} ${vp.name} vier Tage`);
  }

  await createTrip(page, "Paket 4 ein Tag", ONE, ONE);
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await runSingleTrip(page, `${engine} ${vp.name} ein Tag`);
  }

  const realErrors = errors.filter((err) => !/access control checks/.test(err));
  assert(!realErrors.length, `${engine}: ${realErrors[0]}`);
  await browser.close();
  console.log(`4 chip-wisch ${engine} OK`);
}

async function main() {
  const { server, baseUrl } = await startServer();
  try {
    await runSuite(chromium, baseUrl, "chromium");
    await runSuite(webkit, baseUrl, "webkit");
  } finally {
    server.close();
  }
  console.log("Playwright 4 chip-wisch tests OK (Build 62)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
