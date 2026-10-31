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
  let failNotes = false;

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
    get failNotes() {
      return failNotes;
    },
    set failNotes(value) {
      failNotes = Boolean(value);
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
      if (table === "notes" && method === "GET") {
        if (failNotes) return { status: 500, json: { message: "network" } };
        return { status: 200, json: applyFilters(notes, url) };
      }
      if (table === "media" && method === "GET") return { status: 200, json: applyFilters(media, url) };
      if (table === "trip_members" && method === "GET") return { status: 200, json: [{ role: "owner", trip_id: url.searchParams.get("trip_id")?.replace(/^eq\./, "") || "", user_id: USER }] };
      return { status: 404, json: { message: "not found" } };
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
          headers: corsHeaders(req),
          body: result.raw,
        });
      } else {
        await route.fulfill({
          status: result.status,
          contentType: "application/json",
          headers: corsHeaders(req),
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
  if (!state.lastDone) state.lastDone = start;
  while (Date.now() - start < 30000) {
    if (state.inflight === 0 && Date.now() - state.lastDone > 350) return;
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
    placeRow("p-n3", tripId, NEIGHBOR, "Ufer Limone", "2026-10-29T08:00:00.000Z"),
    placeRow("p-n4", tripId, NEIGHBOR, "Gasse Limone", "2026-10-29T07:00:00.000Z"),
    placeRow("p-n5", tripId, NEIGHBOR, "Platz Limone", "2026-10-29T06:00:00.000Z"),
    placeRow("p-n6", tripId, NEIGHBOR, "Kirche Limone", "2026-10-29T05:00:00.000Z"),
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

const FOOT_VIEWPORTS = [
  { width: 375, height: 667 },
  { width: 360, height: 740 },
  { width: 390, height: 844 },
];

async function setSafeBottom(page, px) {
  await page.evaluate((value) => {
    let el = document.getElementById("test-safe-bottom");
    if (!el) {
      el = document.createElement("style");
      el.id = "test-safe-bottom";
      document.head.appendChild(el);
    }
    el.textContent = `:root { --safe-bottom: ${value}px !important; }`;
  }, px);
}

async function assertDayListFoot(page, label, { short }) {
  for (const safeBottom of [0, 34]) {
    await setSafeBottom(page, safeBottom);
    for (const vp of FOOT_VIEWPORTS) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(40);
      const box = await page.evaluate(() => {
        const pageEl = document.querySelector("[data-page='current']");
        const footer = document.querySelector(".trip-footer");
        const fade = document.querySelector(".place-list-fade");
        const host = document.getElementById("app");
        if (!pageEl || !footer || !fade || !host) {
          return { missing: { page: !pageEl, footer: !footer, fade: !fade, host: !host } };
        }
        pageEl.scrollTop = pageEl.scrollHeight;
        const cards = [...pageEl.querySelectorAll(".oc")];
        const last = cards[cards.length - 1];
        const pr = pageEl.getBoundingClientRect();
        const fr = footer.getBoundingClientRect();
        const fadeR = fade.getBoundingClientRect();
        const lr = last.getBoundingClientRect();
        const fadeCs = getComputedStyle(fade);
        const x = lr.left + Math.min(24, lr.width / 2);
        const y = Math.min(lr.bottom - 3, fr.top - 3);
        const hit = document.elementFromPoint(x, y);
        return {
          cards: cards.length,
          pageBottom: pr.bottom,
          footerTop: fr.top,
          fadeBottom: fadeR.bottom,
          fadeTop: fadeR.top,
          fadeH: fadeR.height,
          fadePos: fadeCs.position,
          fadeBg: fadeCs.backgroundImage,
          lastBottom: lr.bottom,
          lastTop: lr.top,
          gap: fr.top - lr.bottom,
          pad: parseFloat(getComputedStyle(pageEl).paddingBottom),
          hostPad: parseFloat(getComputedStyle(host).paddingBottom),
          hostClass: host.className,
          overflows: pageEl.scrollHeight > pageEl.clientHeight + 2,
          hitCard: Boolean(hit && (last.contains(hit) || hit === last)),
        };
      });
      const where = `${label} ${vp.width}x${vp.height} safe ${safeBottom}`;
      assert(!box.missing, `${where}: Layout fehlt ${JSON.stringify(box.missing)}`);
      assert(box.hostPad === 0 || box.hostClass.includes("screen--trip-swipe"), `${where}: Host ${box.hostClass} Abstand ${box.hostPad}`);
      assert(Math.abs(box.pageBottom - box.footerTop) <= 2, `${where}: Liste endet bei ${box.pageBottom}, Footer bei ${box.footerTop}`);
      assert(Math.abs(box.fadeBottom - box.footerTop) <= 2, `${where}: Verlauf endet bei ${box.fadeBottom}, Footer bei ${box.footerTop}`);
      assert(Math.abs(box.fadeH - 24) <= 1, `${where}: Verlaufhöhe ${box.fadeH}`);
      assert(box.fadePos === "absolute", `${where}: Verlauf ist ${box.fadePos}`);
      assert(box.fadeBg.includes("gradient") && !box.fadeBg.includes("38%"), `${where}: Verlauf ${box.fadeBg}`);
      assert(Math.abs(box.pad - 28) <= 0.5, `${where}: Seitenabstand ${box.pad}`);
      assert(box.lastTop < box.footerTop - 8, `${where}: Karte nicht sichtbar (${box.lastTop})`);
      assert(box.lastBottom <= box.footerTop + 1, `${where}: Karte ragt in den Footer (Abstand ${box.gap.toFixed(1)})`);
      assert(box.lastBottom <= box.fadeTop + 1, `${where}: Karte liegt unter dem Verlauf`);
      assert(box.hitCard, `${where}: letzte Karte nicht antippbar`);
      if (short) {
        assert(!box.overflows || box.gap >= 28, `${where}: kurze Liste Abstand ${box.gap.toFixed(1)}`);
      } else if (box.overflows) {
        assert(box.gap >= 22 && box.gap <= 36, `${where}: Luft ${box.gap.toFixed(1)} px, erwartet 28`);
      }
    }
  }
  await setSafeBottom(page, 0);
  await page.setViewportSize({ width: 375, height: 667 });
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
    assert(sync.thumbs >= thumbs && sync.gallery >= 1, `${label}: Cache ohne Thumbnails oder Mediathek (${sync.thumbs}/${sync.gallery})`);
  } else {
    assert(hasName || sync.skeleton, `${label}: weder Inhalt noch Skeleton, «${sync.text.slice(0, 100)}»`);
  }

  if (requireCached) await assertScrollStays(page, state, 73, label);

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
  if (!requireCached) {
    assert(state.signBatches.length >= 1, `${label}: keine Signed-URL-Anfrage`);
    assert(
      state.signBatches.every((n) => n >= 2),
      `${label}: Thumbnails einzeln geholt (${state.signBatches.join(",")})`
    );
    const y = await page.evaluate(() => document.querySelector("[data-page='current']").scrollTop);
    if (y > 0) assert(y === 73, `${label}: scrollTop ${y} nach dem Nachladen`);
  }
}

async function assertScrollStays(page, state, top, label) {
  const applied = await page.evaluate((y) => {
    const el = document.querySelector("[data-page='current']");
    el.scrollTop = y;
    return el.scrollTop;
  }, top);
  assert(applied === top, `${label}: scrollTop ${applied} statt ${top}`);
  const start = Date.now();
  while (Date.now() - start < 9000) {
    const y = await page.evaluate(() => document.querySelector("[data-page='current']").scrollTop);
    assert(y === top, `${label}: scrollTop ${y} nach ${Date.now() - start} ms`);
    if (Date.now() - start > 2500 && state.inflight === 0 && Date.now() - state.lastDone > 400) break;
    await page.waitForTimeout(80);
  }
}

async function installTouch(page) {
  await page.evaluate(() => {
    if (window.__touchSwipe) return;
    let modernTouch = true;
    try {
      new Touch({ identifier: 1, target: document.body, clientX: 0, clientY: 0, pageX: 0, pageY: 0 });
    } catch {
      modernTouch = false;
    }
    const fire = (el, phase, x, y) => {
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
    window.__touchSwipe = (dx) => {
      const el = document.querySelector('[data-testid="trip-content"]');
      const r = el.getBoundingClientRect();
      const x0 = r.left + Math.min(r.width / 2, 180);
      const y0 = r.top + Math.min(120, Math.max(24, r.height / 2));
      fire(el, "start", x0, y0);
      const steps = 8;
      for (let i = 1; i <= steps; i++) fire(el, "move", x0 + (dx * i) / steps, y0);
      fire(el, "end", x0 + dx, y0);
      return document.querySelector("[data-role='day-track']")?.style.transform || "";
    };
    window.__holdSwipe = (dx) => {
      const el = document.querySelector('[data-testid="trip-content"]');
      const r = el.getBoundingClientRect();
      const x0 = r.left + Math.min(r.width / 2, 180);
      const y0 = r.top + Math.min(120, Math.max(24, r.height / 2));
      fire(el, "start", x0, y0);
      fire(el, "move", x0 + dx, y0);
      window.__releaseSwipe = () => fire(el, "end", x0 + dx, y0);
      return document.querySelector("[data-role='day-track']")?.style.transform || "";
    };
  });
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
  assert(Number(build) === 59, `${label}: Build ${build}`);

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
  assert(
    state.signBatches.some((n) => n >= 4),
    `${label}: Nachbar-Thumbnails nicht gebündelt (${state.signBatches.join(",") || "—"})`
  );
  await assertDayListFoot(page, `${label} lang`, { short: false });

  await installTouch(page);
  await page.evaluate((iso) => document.querySelector(`[data-day="${iso}"]`).click(), FAR);
  const held = await page.evaluate(() => window.__holdSwipe(-12));
  assert(String(held).includes("calc("), `${label}: Wisch startet nicht (${held})`);
  const holdStart = Date.now();
  while (Date.now() - holdStart < 3000) {
    const transform = await page.evaluate(() => document.querySelector("[data-role='day-track']")?.style.transform || "");
    assert(transform.includes("calc("), `${label}: Wisch schnappt zurück (${transform})`);
    await page.waitForTimeout(100);
  }
  await page.evaluate(() => window.__releaseSwipe?.());
  await page.waitForFunction(
    (name) => {
      const root = document.querySelector("[data-page='current']");
      return root?.innerText?.includes(name) && root.querySelector(".tile__img[src]") && !root.querySelector("[data-testid='day-skeleton']");
    },
    "Strand Riva",
    { timeout: 20_000 }
  );
  await assertDayListFoot(page, `${label} kurz`, { short: true });

  state.failNotes = true;
  await page.evaluate(() => document.querySelector('[data-day="2026-10-28"]').click());
  await page.waitForSelector("[data-page='current'] [data-testid='day-load-error']");
  assert((await page.locator("[data-testid='day-skeleton']").count()) === 0, `${label}: Skeleton bleibt nach Netzfehler`);
  state.failNotes = false;
  await page.click("[data-action='retry-day-load']");
  await page.waitForSelector("[data-page='current'] [data-testid='trip-empty']");
  await waitQuiet(state);

  await tapDay(page, state, NEIGHBOR, {
    name: "Burg Limone",
    thumbs: 4,
    requireCached: true,
    label: `${label} Nachbar`,
  });
  await waitQuiet(state);
  await page.evaluate(() => window.__touchSwipe(-170));
  await page.waitForFunction(
    (day) => document.querySelector("[data-testid='trip-content']")?.dataset.activeDay === day,
    TODAY
  );
  await assertScrollStays(page, state, 61, `${label} Wisch`);
  await waitQuiet(state);

  const unexpected = pageErrors.filter((err) => !err.includes("access control checks"));
  assert(!unexpected.length, `${label}: Seitenfehler ${unexpected.join(" | ")}`);
  await browser.close();
  console.log(`Playwright 9b tests OK (${label}, Build 59)`);
}

const { server, baseUrl } = await startServer();
try {
  await runSuite(chromium, baseUrl, "Chromium");
  await runSuite(webkit, baseUrl, "WebKit");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
