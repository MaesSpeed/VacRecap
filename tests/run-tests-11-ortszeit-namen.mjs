import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, webkit } from "playwright";
import { ensureTripDetailDay, waitTripListPatch } from "./trip-detail-helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const START = "2026-10-26";
const END = "2026-11-01";
const DAY = "2026-10-27";
const CLOCK = Date.parse("2026-10-27T15:35:00.000Z");

function resolveShotDir() {
  const candidates = [
    process.env.VACRECAP_SHOTS,
    path.join(__dirname, "artifacts"),
    path.join(os.tmpdir(), "vacrecap-paket11"),
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

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function entry(tag, type, count, value) {
  return Buffer.concat([u16(tag), u16(type), u32(count), u32(value >>> 0)]);
}

function buildTiff(date) {
  const dateStr = Buffer.from(`${date}\0`, "ascii");
  return Buffer.concat([
    Buffer.from([0x49, 0x49]),
    u16(0x2a),
    u32(8),
    u16(1),
    entry(0x8769, 4, 1, 26),
    u32(0),
    u16(1),
    entry(0x9003, 2, 20, 44),
    u32(0),
    dateStr,
  ]);
}

function jpegWithExif(baseJpeg, date) {
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), buildTiff(date)]);
  const size = Buffer.alloc(2);
  size.writeUInt16BE(payload.length + 2);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), size, payload]);
  return Buffer.concat([baseJpeg.subarray(0, 2), app1, baseJpeg.subarray(2)]);
}

function buildDateTimeOnlyTiff(date) {
  const dateStr = Buffer.from(`${date}\0`, "ascii");
  return Buffer.concat([
    Buffer.from([0x49, 0x49]),
    u16(0x2a),
    u32(8),
    u16(1),
    entry(0x0132, 2, 20, 26),
    u32(0),
    dateStr,
  ]);
}

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
  const recaps = [];
  const profiles = [{ id: USER, display_name: "Domi", avatar_color: "#5D6D7E" }];
  const invites = [];
  const rpcLog = [];
  const diarySaves = [];
  let legacyInvite = false;
  let peopleExtra = [];

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
  function answer(rows, headers) {
    const accept = headers.accept || "";
    if (accept.includes("application/vnd.pgrst.object+json")) return rows[0] || null;
    return rows;
  }
  function represent(row, headers) {
    const accept = headers.accept || "";
    if (accept.includes("application/vnd.pgrst.object+json")) return row;
    return [row];
  }
  function upsert(list, row) {
    const id = row.id || crypto.randomUUID();
    const hit = list.find((item) => item.id === id);
    const full = {
      created_by: USER,
      created_at: hit?.created_at || new Date(CLOCK).toISOString(),
      updated_at: hit?.updated_at || new Date(CLOCK).toISOString(),
      updated_by: USER,
      deleted_at: null,
      ...row,
      id,
    };
    if (hit) Object.assign(hit, full);
    else list.push(full);
    return full;
  }

  return {
    trips,
    waypoints,
    media,
    recaps,
    profiles,
    invites,
    rpcLog,
    diarySaves,
    setLegacyInvite(value) {
      legacyInvite = Boolean(value);
    },
    setPeopleExtra(rows) {
      peopleExtra = rows;
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
      if (String(url).includes("/object/sign/") && method === "POST") {
        let payload = {};
        try {
          payload = JSON.parse(body || "{}");
        } catch {
          payload = {};
        }
        if (Array.isArray(payload.paths)) {
          return {
            status: 200,
            json: payload.paths.map((one) => ({ error: null, path: one, signedURL: `/object/sign/mock?token=${encodeURIComponent(one)}` })),
          };
        }
        return { status: 200, json: { signedURL: "/object/sign/mock?token=1" } };
      }
      return { status: 200, json: { Key: "ok" } };
    },
    handleRpc(url, body) {
      const name = url.pathname.split("/").filter(Boolean).pop();
      const args = JSON.parse(body || "{}");
      rpcLog.push({ name, args });
      if (name === "invite_to_trip") {
        const results = [];
        for (const item of args.p_invites || []) {
          const email = String(item.email || "").toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            results.push({ email, result: "invalid", invite_id: null });
            continue;
          }
          const row = {
            id: crypto.randomUUID(),
            trip_id: args.p_trip_id,
            email,
            role: item.role || "viewer",
            display_name: legacyInvite ? null : item.name || null,
            created_at: new Date(CLOCK).toISOString(),
            expires_at: new Date(CLOCK + 14 * 86400000).toISOString(),
          };
          invites.push(row);
          results.push({ email, result: "invited", invite_id: row.id });
        }
        return { status: 200, json: results };
      }
      if (name === "list_trip_people") {
        const members = [
          {
            person_kind: "member",
            user_id: USER,
            invite_id: null,
            display_name: profiles.find((row) => row.id === USER)?.display_name || "Domi",
            avatar_color: profiles.find((row) => row.id === USER)?.avatar_color || "#5D6D7E",
            role: "owner",
            status: "aktiv",
            email: "test@example.com",
            since: new Date(CLOCK).toISOString(),
          },
          ...peopleExtra,
        ];
        const open = invites
          .filter((row) => row.trip_id === args.p_trip_id)
          .map((row) => ({
            person_kind: "invite",
            user_id: null,
            invite_id: row.id,
            display_name: row.display_name,
            avatar_color: "#5D6D7E",
            role: row.role,
            status: "eingeladen",
            email: row.email,
            since: row.created_at,
          }));
        return { status: 200, json: [...members, ...open] };
      }
      if (name === "list_my_trip_invites" || name === "list_trip_presence") return { status: 200, json: [] };
      if (name === "touch_trip_presence" || name === "clear_trip_presence") return { status: 200, json: null };
      return { status: 200, json: [] };
    },
    handleRest(url, method, body, headers) {
      const table = url.pathname.split("/").filter(Boolean).pop();
      if (table === "trips") {
        if (method === "POST") return { status: 201, json: represent(upsert(trips, JSON.parse(body || "{}")), headers) };
        if (method === "GET") return { status: 200, json: answer(applyFilters(trips, url), headers) };
        if (method === "PATCH") {
          const rows = applyFilters(trips, url);
          if (!rows[0]) return { status: 200, json: [] };
          Object.assign(rows[0], JSON.parse(body || "{}"), { updated_at: new Date(CLOCK).toISOString() });
          return { status: 200, json: represent(rows[0], headers) };
        }
      }
      if (table === "waypoints") {
        if (method === "GET") return { status: 200, json: answer(applyFilters(waypoints, url), headers) };
        if (method === "POST") {
          const row = JSON.parse(body || "{}");
          return { status: 201, json: represent(upsert(waypoints, row), headers) };
        }
        if (method === "PATCH") {
          const rows = applyFilters(waypoints, url);
          if (!rows[0]) return { status: 200, json: [] };
          Object.assign(rows[0], JSON.parse(body || "{}"), {
            updated_at: new Date(CLOCK + 60000).toISOString(),
            updated_by: USER,
          });
          return { status: 200, json: represent(rows[0], headers) };
        }
      }
      if (table === "notes") {
        if (method === "GET") return { status: 200, json: answer(applyFilters(notes, url), headers) };
        if (method === "POST") return { status: 201, json: represent(upsert(notes, JSON.parse(body || "{}")), headers) };
      }
      if (table === "media") {
        if (method === "GET") return { status: 200, json: answer(applyFilters(media, url), headers) };
        if (method === "POST") {
          const row = JSON.parse(body || "{}");
          upsert(media, row);
          return { status: 201, json: represent(row, headers) };
        }
        if (method === "PATCH") {
          const rows = applyFilters(media, url);
          if (!rows[0]) return { status: 200, json: [] };
          Object.assign(rows[0], JSON.parse(body || "{}"));
          return { status: 200, json: represent(rows[0], headers) };
        }
      }
      if (table === "trip_members" && method === "GET") {
        return { status: 200, json: [{ trip_id: trips[0]?.id || null, user_id: USER, role: "owner" }] };
      }
      if (table === "profiles") {
        if (method === "GET") return { status: 200, json: answer(applyFilters(profiles, url), headers) };
        if (method === "PATCH") {
          const rows = applyFilters(profiles, url);
          const row = rows[0] || profiles[0];
          Object.assign(row, JSON.parse(body || "{}"));
          return { status: 200, json: represent(row, headers) };
        }
      }
      if (table === "trip_recaps") {
        if (method === "GET") return { status: 200, json: answer(applyFilters(recaps, url), headers) };
        if (method === "POST") {
          const saved = upsert(recaps, JSON.parse(body || "{}"));
          diarySaves.push(saved.source_text || "");
          return { status: 201, json: represent(saved, headers) };
        }
        if (method === "PATCH") {
          const rows = applyFilters(recaps, url);
          if (!rows[0]) return { status: 200, json: [] };
          Object.assign(rows[0], JSON.parse(body || "{}"), {
            updated_at: new Date(CLOCK + 120000).toISOString(),
            updated_by: USER,
          });
          diarySaves.push(rows[0].source_text || "");
          return { status: 200, json: represent(rows[0], headers) };
        }
      }
      if (method === "GET") return { status: 200, json: [] };
      return { status: 200, json: null };
    },
  };
}

async function installMocks(page, state) {
  await page.context().route(`**/${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    let result;
    if (url.pathname.includes("/auth/v1/")) result = state.handleAuth(url, req.method(), req.postData());
    else if (url.pathname.includes("/storage/v1/")) result = state.handleStorage(url.pathname, req.method(), req.postData());
    else if (url.pathname.includes("/rest/v1/rpc/")) result = state.handleRpc(url, req.postData());
    else if (url.pathname.includes("/rest/v1/")) result = state.handleRest(url, req.method(), req.postData(), req.headers());
    else result = { status: 404, json: {} };
    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      body: result.json == null ? "" : JSON.stringify(result.json),
    });
  });
  await page.context().route("**/nominatim.openstreetmap.org/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ name: "Valeggio" }),
    });
  });
  await page.context().route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) return route.continue();
    if (url.includes(SUPABASE_HOST) || url.includes("nominatim.openstreetmap.org")) return route.fallback();
    await route.abort();
  });
}

async function freezeClock(page) {
  await page.addInitScript((fixed) => {
    const deny = (_success, error) => {
      if (typeof error === "function") error({ code: 1, message: "denied" });
    };
    navigator.geolocation.getCurrentPosition = deny;
    navigator.geolocation.watchPosition = () => 1;
    const RealDate = Date;
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
  }, CLOCK);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function login(page, baseUrl) {
  await page.goto(baseUrl);
  await page.waitForSelector('[data-testid="login-screen"]');
  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  assert(Number(build) === 69, `Build ${build}, erwartet 69`);
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
  await ensureTripDetailDay(page, start);
  await page.waitForFunction((n) => document.querySelectorAll(".day-chip").length === n, days);
}

async function openDay(page, iso) {
  await page.locator(`.day-chip[data-day="${iso}"]`).click();
  await page.waitForFunction(
    (day) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === day,
    iso
  );
}

async function closeUpload(page) {
  const close = page.locator('[data-testid="photo-upload-sheet"] [data-action="close"]');
  if (await close.count()) {
    await close.click();
    await page.waitForSelector("#overlay-root[hidden]", { state: "attached" });
  }
}

async function waitPlace(state, pred) {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const hit = state.waypoints.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("Ort nicht angelegt");
}

function dayOfIso(iso) {
  return String(iso || "").slice(0, 10);
}

async function plainJpeg(page) {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 24;
    canvas.height = 16;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#3d7ea6";
    ctx.fillRect(0, 0, 24, 16);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  return Buffer.from(bytes);
}

function intersects(a, b) {
  return a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
}

async function arrowClear(page, label) {
  const info = await page.evaluate(() => {
    const shown = (el) => el && getComputedStyle(el).display !== "none" && !el.hasAttribute("hidden");
    const arrows = [...document.querySelectorAll(".day-chips-arrow")].filter(shown).map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    const row = document.querySelector(".day-chips").getBoundingClientRect();
    const chips = [...document.querySelectorAll(".day-chip")].map((el) => {
      const r = el.getBoundingClientRect();
      const text = el.querySelector(".day-chip__date").getBoundingClientRect();
      const full = r.width > 40 && r.left >= row.left - 2 && r.right <= row.right + 2;
      return {
        full,
        box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        text: { left: text.left, right: text.right, top: text.top, bottom: text.bottom },
      };
    });
    return { arrows, chips };
  });
  for (const chip of info.chips.filter((chip) => chip.full)) {
    for (const arrow of info.arrows) {
      assert(!intersects(chip.text, arrow), `${label}: Text liegt unter einem Pfeil`);
    }
  }
}

function decodePng(buf) {
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
  };
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const rowStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? out[rowStart + x - bpp] : 0;
      const up = y ? out[rowStart - stride + x] : 0;
      const ul = y && x >= bpp ? out[rowStart - stride + x - bpp] : 0;
      const byte = raw[p++];
      let value = byte;
      if (filter === 1) value = (byte + left) & 255;
      else if (filter === 2) value = (byte + up) & 255;
      else if (filter === 3) value = (byte + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) value = (byte + paeth(left, up, ul)) & 255;
      out[rowStart + x] = value;
    }
  }
  return { width, height, data: out };
}

function lum(r, g, b) {
  const f = (c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

async function holdSwipe(page, ratio) {
  await page.evaluate((t) => {
    const el = document.querySelector('[data-testid="trip-content"]');
    const r = el.getBoundingClientRect();
    const x0 = r.left + r.width * 0.62;
    const y0 = r.top + Math.min(140, Math.max(24, r.height * 0.45));
    const x1 = x0 + t * r.width;
    let modern = true;
    try {
      new Touch({ identifier: 1, target: el, clientX: 0, clientY: 0, pageX: 0, pageY: 0, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 0.5 });
    } catch {
      modern = false;
    }
    const fire = (phase, x, y) => {
      const type = phase === "start" ? "touchstart" : phase === "move" ? "touchmove" : "touchend";
      if (modern) {
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
        el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: list, targetTouches: list, changedTouches: [touch] }));
        return;
      }
      const touch = document.createTouch(window, el, 1, x + window.scrollX, y + window.scrollY, x, y);
      const list = document.createTouchList(touch);
      const empty = document.createTouchList();
      el.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: phase === "end" ? empty : list,
          targetTouches: phase === "end" ? empty : list,
          changedTouches: list,
        })
      );
    };
    fire("start", x0, y0);
    fire("move", x1, y0);
    window.__holdTouch = { fire, x: x1, y: y0 };
  }, ratio);
  await page.waitForFunction(() => document.querySelector(".day-chips")?.classList.contains("day-chips--follow"));
}

async function releaseSwipe(page) {
  await page.evaluate(() => {
    window.__holdTouch?.fire("end", window.__holdTouch.x, window.__holdTouch.y);
  });
}

async function assertFollowContrast(page, label) {
  const box = await page.locator(".day-chips-wrap").boundingBox();
  const png = decodePng(await page.locator(".day-chips-wrap").screenshot());
  const mark = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="day-chip-mark"]');
    const host = document.querySelector(".day-chips-wrap").getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const covered = document.elementFromPoint(r.left + r.width * 0.5, r.top + r.height * 0.5);
    return {
      left: r.left - host.left,
      top: r.top - host.top,
      width: r.width,
      height: r.height,
      covered: covered?.className || "",
      z: getComputedStyle(el).zIndex,
    };
  });
  const scaleX = png.width / box.width;
  const scaleY = png.height / box.height;
  let blue = 0;
  for (const fx of [0.18, 0.82]) {
    const px = Math.round((mark.left + mark.width * fx) * scaleX);
    const py = Math.round((mark.top + mark.height * 0.5) * scaleY);
    const i = (py * png.width + px) * 4;
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    if (b > r + 15 && b > 50) blue += 1;
  }
  assert(blue > 0, `${label}: Markierung liegt unter dem Chip (${mark.covered})`);
  const dates = await page.evaluate(() => {
    const host = document.querySelector(".day-chips-wrap").getBoundingClientRect();
    const mark = document.querySelector('[data-testid="day-chip-mark"]').getBoundingClientRect();
    return {
      mark: { left: mark.left - host.left, top: mark.top - host.top, right: mark.right - host.left, bottom: mark.bottom - host.top },
      texts: [...document.querySelectorAll(".day-chip > .day-chip__date")].map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left - host.left, top: r.top - host.top, right: r.right - host.left, bottom: r.bottom - host.top };
      }),
    };
  });
  function at(x, y) {
    const px = Math.round(x * scaleX);
    const py = Math.round(y * scaleY);
    if (px < 0 || py < 0 || px >= png.width || py >= png.height) return null;
    const i = (py * png.width + px) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  }
  function insideMark(x, y) {
    return x >= dates.mark.left + 2 && x < dates.mark.right - 2 && y >= dates.mark.top + 2 && y < dates.mark.bottom - 2;
  }
  let markBlue = null;
  for (let x = dates.mark.left + 4; x < dates.mark.right - 4; x += 2) {
    const sample = at(x, dates.mark.top + 6);
    if (!sample || !(sample[2] > sample[0] + 25 && sample[2] > 80)) continue;
    if (!markBlue || lum(...sample) < lum(...markBlue)) markBlue = sample;
  }
  let ink = 0;
  for (const text of dates.texts) {
    const visL = Math.max(text.left, 0);
    const visR = Math.min(text.right, box.width);
    const visT = Math.max(text.top, 0);
    const visB = Math.min(text.bottom, box.height);
    if (visR - visL < 8 || visB - visT < 4) continue;
    const outsideLeft = Math.max(0, Math.min(visR, dates.mark.left) - visL);
    const outsideRight = Math.max(0, visR - Math.max(visL, dates.mark.right));
    let outsideNavy = 0;
    for (let y = visT + 1; y < visB - 1; y += 1) {
      for (let x = visL + 1; x < visR - 1; x += 1) {
        const rgb = at(x, y);
        if (!rgb) continue;
        const L = lum(...rgb);
        const onMark = insideMark(x, y);
        const navy = rgb[2] < 120 && rgb[0] < 50 && L < 0.2;
        if (onMark && navy && markBlue) {
          let onBlue = false;
          for (let dx = 2; dx <= 6 && !onBlue; dx += 2) {
            for (const sx of [x - dx, x + dx]) {
              const near = at(sx, y);
              if (near && near[2] > near[0] + 25 && near[2] > 80 && lum(...near) < 0.3) onBlue = true;
            }
          }
          if (!onBlue) continue;
          const ratio = (Math.max(L, lum(...markBlue)) + 0.05) / (Math.min(L, lum(...markBlue)) + 0.05);
          assert(ratio >= 4.5, `${label}: dunkle Schrift auf der Markierung, Kontrast ${ratio.toFixed(2)}`);
        }
        if (onMark && L > 0.8 && markBlue) {
          const ratio = (Math.max(L, lum(...markBlue)) + 0.05) / (Math.min(L, lum(...markBlue)) + 0.05);
          assert(ratio >= 4.5, `${label}: Schrift auf der Markierung, Kontrast ${ratio.toFixed(2)}`);
          ink += 1;
        }
        if (!onMark && navy) {
          outsideNavy += 1;
          ink += 1;
        }
      }
    }
    if ((outsideLeft >= 10 || outsideRight >= 10) && outsideNavy === 0) {
      assert(
        false,
        `${label}: weiße Schrift auf weißem Chip`
      );
    }
  }
  assert(ink > 0, `${label}: keine lesbare Schrift an der Markierung`);
}

async function runSuite(browserType, baseUrl, label) {
  const browser = await browserType.launch({ headless: true });
  const phone = await browser.newContext({ ...devices["iPhone 8"], baseURL: baseUrl });
  const page = await phone.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  const state = createState();
  await installMocks(page, state);
  await freezeClock(page);
  await login(page, baseUrl);
  const baseJpeg = await plainJpeg(page);
  const plain = { name: "ohne.jpg", mimeType: "image/jpeg", buffer: baseJpeg };

  await createTrip(page, "Gardasee", START, END, 7);
  await openDay(page, DAY);
  const beforeToday = state.waypoints.length;
  await page.locator('[data-testid="capture-photo-input"]').setInputFiles(plain);
  const todayPlace = await waitPlace(state, (row) => state.waypoints.indexOf(row) >= beforeToday);
  assert(dayOfIso(todayPlace.visited_at) === DAY, `${label}: heute ${todayPlace.visited_at}`);
  assert(todayPlace.visited_at.includes("T15:"), `${label}: heute soll jetzt sein, nicht 12:00 (${todayPlace.visited_at})`);
  await closeUpload(page);

  const exif = { name: "valeggio.jpg", mimeType: "image/jpeg", buffer: jpegWithExif(baseJpeg, "2026:10:26 15:37:00") };
  await openDay(page, "2026-10-26");
  const before = state.waypoints.length;
  await page.locator('[data-testid="capture-photo-input"]').setInputFiles(exif);
  const exifPlace = await waitPlace(state, (row) => state.waypoints.indexOf(row) >= before && String(row.visited_at).includes("T15:37"));
  assert(exifPlace.visited_at.startsWith("2026-10-26T15:37"), `${label}: EXIF-Zeit ${exifPlace.visited_at}`);
  await page.waitForTimeout(400);
  const exifMedia = state.media.find((row) => row.waypoint_id === exifPlace.id);
  assert(exifMedia?.taken_at?.startsWith("2026-10-26T15:37"), `${label}: taken_at ${exifMedia?.taken_at}`);
  await closeUpload(page);

  await openDay(page, "2026-10-28");
  const beforePlain = state.waypoints.length;
  await page.locator('[data-testid="capture-photo-input"]').setInputFiles(plain);
  const plainPlace = await waitPlace(state, (row) => state.waypoints.indexOf(row) >= beforePlain);
  assert(dayOfIso(plainPlace.visited_at) === "2026-10-28", `${label}: Fallback ${plainPlace.visited_at}`);
  assert(plainPlace.visited_at.includes("T12:00"), `${label}: erwartet 12:00 statt jetzt, ${plainPlace.visited_at}`);
  await page.waitForTimeout(500);
  const plainMedia = state.media.filter((row) => row.waypoint_id === plainPlace.id);
  assert(plainMedia.length && plainMedia.every((row) => row.taken_at == null), `${label}: taken_at ohne EXIF ${JSON.stringify(plainMedia.map((row) => row.taken_at))}`);
  await closeUpload(page);

  await openDay(page, "2026-10-30");
  const laterId = crypto.randomUUID();
  state.waypoints.push({
    id: laterId,
    trip_id: state.trips.at(-1).id,
    day: "2026-10-30",
    title: "Spaet",
    visited_at: "2026-10-30T18:00:00.000Z",
    lat: null,
    lng: null,
    is_soft: false,
    source: "manual",
    created_by: USER,
    created_at: new Date(CLOCK).toISOString(),
    updated_at: "2026-10-30T18:00:00.000Z",
    updated_by: USER,
    deleted_at: null,
  });
  await page.reload();
  await page.waitForSelector('[data-testid="trip-content"]');
  await openDay(page, "2026-10-30");
  await page.locator(`.oc[data-place-id="${laterId}"]`).click();
  const early = { name: "frueh.jpg", mimeType: "image/jpeg", buffer: jpegWithExif(baseJpeg, "2026:10:30 15:37:00") };
  await page.locator('[data-testid="capture-photo-input"]').setInputFiles(early);
  const startWait = Date.now();
  while (!String(state.waypoints.find((row) => row.id === laterId)?.visited_at || "").includes("T15:37") && Date.now() - startWait < 8000) {
    await new Promise((r) => setTimeout(r, 40));
  }
  assert(
    String(state.waypoints.find((row) => row.id === laterId)?.visited_at || "").includes("T15:37"),
    `${label}: früheres Foto zieht nicht vor`
  );
  await closeUpload(page);
  const stayed = state.waypoints.find((row) => row.id === laterId).visited_at;
  await page.locator('[data-testid="capture-photo-input"]').setInputFiles(plain);
  await page.waitForTimeout(700);
  assert(state.waypoints.find((row) => row.id === laterId).visited_at === stayed, `${label}: Foto ohne EXIF ändert die Ortszeit`);
  await closeUpload(page);

  await openDay(page, "2026-10-29");
  const multiId = crypto.randomUUID();
  state.waypoints.push({
    id: multiId,
    trip_id: state.trips.find((row) => row.title === "Gardasee").id,
    day: "2026-10-29",
    title: "Galerie",
    visited_at: "2026-10-29T18:00:00.000Z",
    is_soft: false,
    source: "manual",
    created_by: USER,
    created_at: new Date(CLOCK).toISOString(),
    updated_at: "2026-10-29T18:00:00.000Z",
    updated_by: USER,
    deleted_at: null,
  });
  await page.reload();
  await page.waitForSelector('[data-testid="trip-content"]');
  await openDay(page, "2026-10-29");
  await page.locator(`.oc[data-place-id="${multiId}"]`).click();
  await page.locator('[data-testid="gallery-input"]').setInputFiles([
    { name: "g17.jpg", mimeType: "image/jpeg", buffer: jpegWithExif(baseJpeg, "2026:10:29 17:00:00") },
    { name: "g16.jpg", mimeType: "image/jpeg", buffer: jpegWithExif(baseJpeg, "2026:10:29 16:00:00") },
    { name: "g15.jpg", mimeType: "image/jpeg", buffer: jpegWithExif(baseJpeg, "2026:10:29 15:00:00") },
  ]);
  const multiStart = Date.now();
  while (
    !String(state.waypoints.find((row) => row.id === multiId)?.visited_at || "").includes("T15:00") &&
    Date.now() - multiStart < 10000
  ) {
    await new Promise((r) => setTimeout(r, 40));
  }
  const multiAt = state.waypoints.find((row) => row.id === multiId)?.visited_at;
  assert(String(multiAt).includes("T15:00"), `${label}: frühestes von drei Fotos ist ${multiAt}`);
  await closeUpload(page);

  await openDay(page, DAY);
  const tripId = state.trips.find((row) => row.title === "Gardasee").id;
  const placeA = crypto.randomUUID();
  const placeB = crypto.randomUUID();
  state.waypoints.push(
    {
      id: placeA,
      trip_id: tripId,
      day: DAY,
      title: "A",
      visited_at: "2026-10-27T15:00:00.000Z",
      is_soft: false,
      source: "manual",
      created_by: USER,
      created_at: new Date(CLOCK).toISOString(),
      updated_at: "2026-10-27T15:00:00.000Z",
      updated_by: USER,
      deleted_at: null,
    },
    {
      id: placeB,
      trip_id: tripId,
      day: DAY,
      title: "B",
      visited_at: "2026-10-27T19:41:46.000Z",
      is_soft: false,
      source: "manual",
      created_by: USER,
      created_at: new Date(CLOCK).toISOString(),
      updated_at: "2026-10-27T19:00:00.000Z",
      updated_by: USER,
      deleted_at: null,
    }
  );
  await page.reload();
  await page.waitForSelector('[data-testid="trip-content"]');
  await openDay(page, DAY);
  if (await page.locator('[data-action="retry-day-load"]').count()) {
    await page.click('[data-action="retry-day-load"]');
  }
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".oc:not(.oc--skeleton) .oc__title")].some((el) => /A|B/.test(el.textContent || ""))
  );
  const orderBefore = await page.locator(".oc:not(.oc--skeleton) .oc__title").allTextContents();
  assert(orderBefore.findIndex((name) => name.includes("B")) < orderBefore.findIndex((name) => name.includes("A")), `${label}: Reihenfolge ${orderBefore.join("|")} waypoints=${state.waypoints.map((row) => row.title + "@" + row.day).join(",")}`);
  if (label === "chromium") await shot(page, "n2-liste-vorher");
  await page.locator(`.oc[data-place-id="${placeB}"]`).click();
  await page.locator(`[data-place-id="${placeB}"] [data-action="edit-place"]`).click();
  await page.waitForSelector('[data-testid="edit-place-time"]');
  await page.locator('[data-role="name"]').fill("B zwei");
  await page.locator('.sheet--place-edit [data-action="save"]').click();
  await page.waitForFunction(() => document.querySelector(".oc__title")?.textContent?.includes("B zwei"));
  const keptSeconds = state.waypoints.find((row) => row.id === placeB)?.visited_at;
  assert(keptSeconds === "2026-10-27T19:41:46.000Z", `${label}: Sekunde verloren ${keptSeconds}`);
  await page.locator(`.oc[data-place-id="${placeA}"]`).click();
  await page.locator(`[data-place-id="${placeA}"] [data-action="edit-place"]`).click();
  await page.waitForSelector('[data-testid="edit-place-time"]');
  const save = page.locator('.sheet--place-edit [data-action="save"]');
  assert(await save.isDisabled(), `${label}: Speichern ohne Änderung aktiv`);
  await page.locator('[data-testid="edit-place-time"]').fill("20:00");
  assert(!(await save.isDisabled()), `${label}: Speichern bei neuer Uhrzeit inaktiv`);
  assert((await page.locator('[data-testid="edit-place-day"]').innerText()).includes("27.10."), `${label}: Tag fehlt`);
  if (label === "chromium") await shot(page, "n2-sheet-uhrzeit");
  for (const vp of [
    { width: 360, height: 740 },
    { width: 375, height: 667 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(vp);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflow <= 2, `${label}: Überlauf bei ${vp.width} (${overflow})`);
    const box = await page.locator('[data-testid="edit-place-time"]').boundingBox();
    assert(box && box.height >= 44, `${label}: Uhrzeit-Tippfläche ${box?.height}`);
  }
  await page.setViewportSize({ width: 375, height: 667 });
  await save.click();
  await waitTripListPatch(page);
  await page.waitForFunction(
    (id) => document.querySelectorAll(".oc__title")[0]?.textContent?.includes("A") && document.querySelector(`[data-place-id="${id}"]`)?.textContent?.includes("20:00"),
    placeA
  );
  const saved = state.waypoints.find((row) => row.id === placeA);
  assert(saved.visited_at === "2026-10-27T20:00:00.000Z", `${label}: PATCH ${saved.visited_at}`);
  if (label === "chromium") await shot(page, "n2-liste-nachher");

  await page.locator(`.oc[data-place-id="${placeA}"]`).click();
  await page.locator(`[data-place-id="${placeA}"] [data-action="edit-place"]`).click();
  await page.waitForSelector('[data-testid="edit-place-time"]');
  saved.updated_at = "2026-10-27T21:00:00.000Z";
  saved.title = "Frischer Name";
  saved.visited_at = "2026-10-27T16:10:00.000Z";
  await page.locator('[data-testid="edit-place-time"]').fill("21:00");
  await save.click();
  await waitTripListPatch(page);
  await page.waitForSelector('[data-testid="conflict-dialog"]');
  await page.locator('[data-testid="conflict-dialog"] [data-action="cancel"]').click();
  await page.waitForFunction(() => document.querySelector('[data-role="name"]')?.value === "Frischer Name");
  assert((await page.locator('[data-testid="edit-place-time"]').inputValue()) === "16:10", `${label}: Neu laden setzt die Zeit nicht zurück`);
  await page.locator('.sheet--place-edit [data-action="cancel"]').click();

  await page.click('[data-action="settings"]');
  await page.click('[data-testid="settings-edit-trip"]');
  await page.waitForSelector('[data-testid="share-name-input"]');
  await page.fill('[data-testid="share-email-input"]', "zuerst@example.com");
  await page.locator('[data-testid="share-name-input"]').click();
  assert((await page.locator('[data-testid="share-chip"]').count()) === 0, `${label}: Chip entsteht schon beim Wechsel ins Namensfeld`);
  await page.fill('[data-testid="share-name-input"]', "Zuerst");
  await page.locator('[data-testid="share-name-input"]').press("Enter");
  await page.waitForSelector('[data-testid="share-chip"]');
  assert((await page.locator('[data-testid="share-chip"]').innerText()).includes("Zuerst"), `${label}: Name nach der E-Mail fehlt`);
  await page.fill('[data-testid="share-email-input"]', "danach@example.com");
  await page.locator('[data-testid="share-email-input"]').press("Enter");
  let chipTexts = await page.locator('[data-testid="share-chip"]').allInnerTexts();
  assert(chipTexts.length === 2, `${label}: zwei Chips ${chipTexts.join(" | ")}`);
  assert(chipTexts[0].includes("Zuerst"), `${label}: erster Chip verliert den Namen`);
  assert(!chipTexts[1].includes("Zuerst"), `${label}: Name landet auf der nächsten Adresse (${chipTexts[1]})`);
  while ((await page.locator('[data-testid="share-chip"]').count()) > 0) {
    await page.locator('[data-testid="share-chip"]').first().click();
  }
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="share-chip"]').length === 0);
  await page.fill('[data-testid="share-email-input"]', "offen@example.com");
  await page.locator('[data-testid="share-email-input"]').press("Enter");
  await page.waitForSelector('[data-testid="share-chip"]');
  assert(
    (await page.locator('[data-testid="share-chip"]').innerText()).includes("offen@example.com"),
    `${label}: Chip ohne Namen zeigt die Adresse`
  );
  await page.fill('[data-testid="share-name-input"]', "Haenger");
  assert((await page.locator('[data-testid="share-chip"]').innerText()).includes("Haenger"), `${label}: Name kommt nicht mehr am Chip an`);
  await page.fill('[data-testid="share-email-input"]', "andere@example.com");
  assert((await page.locator('[data-testid="share-name-input"]').inputValue()) === "", `${label}: liegengebliebener Name im Feld`);
  await page.locator('[data-testid="share-email-input"]').press("Enter");
  chipTexts = await page.locator('[data-testid="share-chip"]').allInnerTexts();
  assert(chipTexts[0].includes("Haenger"), `${label}: Name hängt nicht am ersten Chip (${chipTexts[0]})`);
  assert(
    chipTexts[1]?.includes("andere@example.com") && !chipTexts[1].includes("Haenger"),
    `${label}: Name landet auf der nächsten Adresse (${chipTexts[1]})`
  );
  while ((await page.locator('[data-testid="share-chip"]').count()) > 0) {
    await page.locator('[data-testid="share-chip"]').first().click();
  }
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="share-chip"]').length === 0);
  await page.fill('[data-testid="share-name-input"]', "Papa");
  await page.fill('[data-testid="share-email-input"]', "papa@example.com");
  await page.locator('[data-testid="share-email-input"]').press("Enter");
  await page.waitForSelector('[data-testid="share-chip"]');
  const chip = await page.locator('[data-testid="share-chip"]').innerText();
  assert(chip.includes("Papa"), `${label}: Chip zeigt ${chip}`);
  if (label === "chromium") await shot(page, "n3-einladung");
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="share-access-row"] .settings-item__title')].some((el) => el.textContent === "Papa")
  );
  const letter = await page.locator('[data-testid="share-access-row"]', { hasText: "Papa" }).locator(".fg-av").innerText();
  assert(letter.trim() === "P", `${label}: Initiale ${letter}`);
  const payload = state.rpcLog.find((row) => row.name === "invite_to_trip");
  assert(payload?.args?.p_invites?.[0]?.name === "Papa", `${label}: Payload ${JSON.stringify(payload?.args)}`);
  if (label === "chromium") await shot(page, "n3-liste");

  state.setLegacyInvite(true);
  state.invites.length = 0;
  await page.fill('[data-testid="share-email-input"]', "alt@example.com");
  await page.locator('[data-testid="share-email-input"]').press("Enter");
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="share-access-row"]')].some((row) => row.textContent.includes("alt@example.com")));
  assert(!errors.some((err) => /name/i.test(err)), `${label}: alte RPC wirft ${errors[0]}`);

  await page.evaluate(() => {
    location.hash = "#/urlaube";
  });
  await page.waitForSelector(".screen--urlaube");
  await page.click('[data-action="settings"]');
  await page.waitForSelector('[data-testid="display-name-row"]');
  await page.click('[data-testid="display-name-row"]');
  await page.waitForSelector('[data-testid="avatar-color"]');
  const swatch = page.locator('[data-testid="avatar-color"]').nth(3);
  const color = await swatch.getAttribute("data-color");
  const swatchBox = await swatch.boundingBox();
  assert(swatchBox && swatchBox.width >= 44 && swatchBox.height >= 44, `${label}: Farbkreis ${swatchBox?.width}`);
  await swatch.click();
  if (label === "chromium") await shot(page, "u6-farbe");
  await page.click('[data-testid="display-name-save"]');
  await page.waitForFunction(
    (value) => (document.querySelector('[data-testid="display-name-preview"]')?.getAttribute("style") || "").toLowerCase().includes(value.toLowerCase()),
    color
  );
  assert(
    state.profiles[0].avatar_color?.toLowerCase() === color.toLowerCase(),
    `${label}: PATCH Farbe ${state.profiles[0].avatar_color}`
  );

  state.setPeopleExtra([
    {
      person_kind: "member",
      user_id: OTHER,
      display_name: "Papa",
      avatar_color: "#d64541",
      role: "editor",
      status: "aktiv",
      email: "papa@example.com",
    },
  ]);
  const photoPlace = state.waypoints.find((row) => row.id === placeA);
  state.media.push({
    id: crypto.randomUUID(),
    trip_id: tripId,
    waypoint_id: photoPlace.id,
    day: DAY,
    taken_at: "2026-10-27T15:00:00.000Z",
    kind: "photo",
    upload_status: "uploaded",
    storage_path: "mock/a.jpg",
    thumb_path: "mock/a.jpg",
    mime: "image/jpeg",
    created_by: USER,
    created_at: new Date(CLOCK).toISOString(),
    updated_at: new Date(CLOCK).toISOString(),
    deleted_at: null,
  });
  await page.keyboard.press("Escape").catch(() => {});
  await page.locator(".card", { hasText: "Gardasee" }).click();
  await page.waitForSelector('[data-testid="member-bar"]');
  await openDay(page, DAY);
  await page.locator(`.oc[data-place-id="${photoPlace.id}"]`).click();
  await page.waitForSelector(".kr-av--xs");
  const hit = await page.evaluate(() => {
    const el = document.querySelector(".kr-av--xs");
    const after = getComputedStyle(el, "::after");
    return { w: parseFloat(after.width), h: parseFloat(after.height) };
  });
  assert(hit.w >= 44 && hit.h >= 44, `${label}: Kreis-Tippfläche ${hit.w}×${hit.h}`);
  const circle = await page.locator(".kr-av--xs").boundingBox();
  await page.mouse.click(circle.x + circle.width / 2 + 12, circle.y + circle.height / 2);
  await page.waitForSelector('[data-testid="member-tip"]');
  if (label === "chromium") await shot(page, "u5-tippflaeche");
  await page.mouse.click(2, 2);
  await page.click('[data-testid="photo-select-start"]');
  await page.waitForSelector('[data-testid="photo-select-bar"]');
  const circleAgain = await page.locator(".kr-av--xs").boundingBox();
  await page.mouse.click(circleAgain.x + circleAgain.width / 2 + 12, circleAgain.y + circleAgain.height / 2);
  await page.waitForFunction(() => document.querySelector('[data-testid="photo-select-count"]')?.textContent?.includes("1"));
  assert((await page.locator('[data-testid="member-tip"]').count()) === 0, `${label}: Tooltip im Auswahlmodus`);

  await page.click('[data-testid="photo-select-exit"]').catch(() => {});
  async function openDiary(local, server) {
    const id = state.trips.find((row) => row.title === "Gardasee").id;
    state.recaps.length = 0;
    state.diarySaves.length = 0;
    if (server) {
      state.recaps.push({
        id: "notes-1",
        trip_id: id,
        kind: "diary",
        status: "notes",
        version: 1,
        source_text: server.text,
        content: {},
        feedback: [],
        created_by: USER,
        updated_at: server.updatedAt,
        updated_by: server.updatedBy,
        deleted_at: null,
      });
    }
    await page.evaluate(
      ({ trip, payload }) => {
        localStorage.removeItem(`vr-diary-source:${trip}`);
        if (payload) localStorage.setItem(`vr-diary-source:${trip}`, JSON.stringify(payload));
      },
      { trip: id, payload: local }
    );
    if (await page.locator('[data-testid="trip-content"]').count()) {
      await page.click('[data-action="settings"]');
    }
    await page.click('[data-testid="settings-diary"]');
    await page.waitForSelector('[data-testid="diary-source"]');
    return id;
  }
  async function leaveDiary() {
    await page.click('[data-action="back"]');
    await page.waitForSelector('[data-testid="trip-content"]');
  }
  const me = USER;
  await openDiary(
    {
      text: "Entwurf zwei",
      pending: true,
      savedAt: "2026-11-02T09:00:00.000Z",
      remoteUpdatedAt: "2026-11-02T08:00:00.000Z",
    },
    { text: "Speichern eins", updatedAt: "2026-11-02T10:00:00.000Z", updatedBy: me }
  );
  assert((await page.locator('[data-testid="diary-source"]').inputValue()) === "Entwurf zwei", `${label}: Race verwirft den lokalen Text`);
  const raceStart = Date.now();
  while (!state.diarySaves.includes("Entwurf zwei") && Date.now() - raceStart < 4000) {
    await new Promise((r) => setTimeout(r, 40));
  }
  assert(state.diarySaves.includes("Entwurf zwei"), `${label}: lokaler Entwurf wird nicht hochgeladen`);
  await leaveDiary();
  await openDiary(
    {
      text: "Mein Tipp",
      pending: true,
      savedAt: "2026-11-02T09:00:00.000Z",
      remoteUpdatedAt: "2026-11-02T08:00:00.000Z",
    },
    { text: "Von jemand anderem", updatedAt: "2026-11-02T10:00:00.000Z", updatedBy: OTHER }
  );
  assert((await page.locator('[data-testid="diary-source"]').inputValue()) === "Von jemand anderem", `${label}: fremder Stand bleibt liegen`);
  await page.waitForSelector('[data-testid="app-toast"]');
  assert((await page.locator('[data-testid="app-toast"]').innerText()).includes("Neuerer Stand geladen"), `${label}: Toast fehlt`);
  await leaveDiary();
  await openDiary(
    {
      text: "Uhr zurück",
      pending: true,
      savedAt: "2026-11-02T09:55:00.000Z",
      remoteUpdatedAt: "2026-11-02T10:00:00.000Z",
    },
    { text: "Server trotz Uhr", updatedAt: "2026-11-02T10:00:00.000Z", updatedBy: me }
  );
  assert((await page.locator('[data-testid="diary-source"]').inputValue()) === "Uhr zurück", `${label}: nachgehende Uhr verwirft den Text`);
  await leaveDiary();
  await openDiary(
    { text: "Alt ohne Feld", pending: true, savedAt: "2026-11-02T09:00:00.000Z" },
    { text: "Server neuer", updatedAt: "2026-11-02T10:00:00.000Z", updatedBy: me }
  );
  assert((await page.locator('[data-testid="diary-source"]').inputValue()) === "Server neuer", `${label}: Alter Eintrag weicht vom Paket-9-Verhalten ab`);
  await leaveDiary();

  const realErrors = errors.filter((err) => !/access control checks|ResizeObserver/.test(err));
  assert(!realErrors.length, `${label}: ${realErrors[0]}`);
  await phone.close();

  if (label === "chromium") {
    const desk = await browser.newContext({ viewport: { width: 1366, height: 768 }, baseURL: baseUrl });
    const dpage = await desk.newPage();
    dpage.setDefaultTimeout(20000);
    const dstate = createState();
    await installMocks(dpage, dstate);
    await freezeClock(dpage);
    await login(dpage, baseUrl);
    await createTrip(dpage, "Leiste", START, END, 7);
    await arrowClear(dpage, "1366 Anfang");
    await dpage.locator(".day-nav").screenshot({ path: path.join(SHOTS, "u1-1366-anfang.png") });
    let guard = 0;
    while ((await dpage.locator("[data-testid='day-chips-next']").getAttribute("hidden")) == null && guard < 8) {
      await dpage.locator("[data-testid='day-chips-next']").click();
      guard += 1;
    }
    await arrowClear(dpage, "1366 Ende");
    await dpage.locator(".day-nav").screenshot({ path: path.join(SHOTS, "u1-1366-ende.png") });
    await dpage.setViewportSize({ width: 1920, height: 1080 });
    await dpage.evaluate(() => {
      document.querySelector(".day-chips").scrollLeft = 0;
    });
    await arrowClear(dpage, "1920 Anfang");
    await dpage.locator('.day-chip[data-day="2026-10-29"]').click();
    await dpage.waitForFunction(() => !document.querySelector(".day-chips")?.classList.contains("day-chips--follow"));
    await arrowClear(dpage, "1920 Mitte");
    await desk.close();

    const tab = await browser.newContext({
      viewport: { width: 768, height: 1024 },
      hasTouch: true,
      isMobile: true,
      baseURL: baseUrl,
    });
    const tpage = await tab.newPage();
    tpage.setDefaultTimeout(20000);
    const tstate = createState();
    await installMocks(tpage, tstate);
    await freezeClock(tpage);
    await login(tpage, baseUrl);
    await createTrip(tpage, "Tablet", START, END, 7);
    const tablet = await tpage.evaluate(() => {
      const row = document.querySelector(".day-chips").getBoundingClientRect();
      const chips = [...document.querySelectorAll(".day-chip")].map((el) => el.getBoundingClientRect());
      const full = chips.filter((r) => r.left >= row.left - 2 && r.right <= row.right + 2).length;
      const prev = getComputedStyle(document.querySelector("[data-testid='day-chips-prev']")).display;
      return { width: chips[0].width, full, prev };
    });
    assert(Math.abs(tablet.width - 107) <= 2, `${label}: Tablet-Chip ${tablet.width}`);
    assert(tablet.full >= 3, `${label}: Tablet sichtbare Chips ${tablet.full}`);
    assert(tablet.prev === "none", `${label}: Tablet zeigt Pfeile`);
    await tpage.locator(".day-nav").screenshot({ path: path.join(SHOTS, "u3-768.png") });
    await tab.close();
  }

  if (label === "webkit") {
    const swipe = await browser.newContext({ ...devices["iPhone 8"], baseURL: baseUrl });
    const spage = await swipe.newPage();
    spage.setDefaultTimeout(20000);
    const sstate = createState();
    await installMocks(spage, sstate);
    await freezeClock(spage);
    await login(spage, baseUrl);
    await createTrip(spage, "Wisch", START, END, 7);
    await openDay(spage, DAY);
    await holdSwipe(spage, -0.3);
    await spage.locator(".day-nav").screenshot({ path: path.join(SHOTS, "u4-30.png") });
    await assertFollowContrast(spage, "webkit 30%");
    await releaseSwipe(spage);
    await spage.waitForFunction(() => !document.querySelector(".day-chips")?.classList.contains("day-chips--follow"));
    await openDay(spage, DAY);
    await holdSwipe(spage, -0.6);
    await spage.locator(".day-nav").screenshot({ path: path.join(SHOTS, "u4-60.png") });
    await assertFollowContrast(spage, "webkit 60%");
    await releaseSwipe(spage);
    await swipe.close();
  }

  await browser.close();
  console.log(`11 Ortszeit/Namen ${label} OK`);
}

async function testNamesSql() {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create schema if not exists private;
    create table auth.session (uid uuid, email text);
    insert into auth.session values ('11111111-1111-1111-1111-111111111111', 'owner@example.com');
    create function auth.uid() returns uuid language sql stable as $$ select uid from auth.session $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select jsonb_build_object('email', email) from auth.session $$;
    create table auth.users (id uuid primary key, email text);
    create table public.profiles (id uuid primary key, display_name text, avatar_color text);
    create table public.trips (id uuid primary key);
    create table public.trip_members (trip_id uuid, user_id uuid, role text, created_at timestamptz default now(), primary key (trip_id, user_id));
    create table public.trip_invites (
      id uuid primary key default gen_random_uuid(), trip_id uuid, email text, role text,
      created_by uuid, invited_user_id uuid, token text, created_at timestamptz default now(),
      expires_at timestamptz default now() + interval '14 days', accepted_at timestamptz,
      accepted_by uuid, declined_at timestamptz, revoked_at timestamptz
    );
    create table private.invite_lookups (user_id uuid, at timestamptz default now());
    create table public.waypoints (trip_id uuid, created_by uuid);
    create table public.notes (trip_id uuid, created_by uuid);
    create table public.media (trip_id uuid, created_by uuid);
    create function private.has_trip_role(p_trip uuid, roles text[]) returns boolean language sql stable as $$ select true $$;
    create function private.is_trip_member(p_trip uuid) returns boolean language sql stable as $$ select true $$;
  `);
  const sql = await readFile(path.join(root, "docs/supabase/paket-11-namen.sql"), "utf8");
  await db.exec(sql);
  await db.exec(sql);
  const owner = "11111111-1111-1111-1111-111111111111";
  const papa = "22222222-2222-2222-2222-222222222222";
  const kept = "33333333-3333-3333-3333-333333333333";
  const open = "44444444-4444-4444-4444-444444444444";
  const trip = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  await db.exec(`
    insert into auth.users values ('${owner}', 'owner@example.com'), ('${papa}', 'papa@example.com'), ('${kept}', 'kept@example.com'), ('${open}', 'offen@example.com');
    insert into public.profiles values ('${owner}', 'Domi', '#0066b3'), ('${papa}', null, null), ('${kept}', 'Bestehend', '#5D6D7E'), ('${open}', null, null);
    insert into public.trips values ('${trip}');
    insert into public.trip_members (trip_id, user_id, role) values ('${trip}', '${owner}', 'owner');
  `);
  await db.query(`select * from public.invite_to_trip('${trip}', '[{"email":"papa@example.com","role":"viewer","name":"Papa"}]'::jsonb)`);
  await db.query(`select * from public.invite_to_trip('${trip}', '[{"email":"papa@example.com","role":"viewer","name":""}]'::jsonb)`);
  const keptInvite = (await db.query(`select display_name from public.trip_invites where email = 'papa@example.com'`)).rows[0].display_name;
  assert(keptInvite === "Papa", `erneutes Einladen ohne Namen löscht «${keptInvite}»`);
  await db.exec(`update auth.session set uid = '${papa}', email = 'papa@example.com'`);
  const id = (await db.query(`select id from public.trip_invites where email = 'papa@example.com'`)).rows[0].id;
  await db.query(`select public.accept_trip_invite_by_id('${id}')`);
  const papaName = (await db.query(`select display_name from public.profiles where id = '${papa}'`)).rows[0].display_name;
  assert(papaName === "Papa", `Annehmen setzt «${papaName}»`);
  await db.exec(`update auth.session set uid = '${owner}', email = 'owner@example.com'`);
  await db.query(`select * from public.invite_to_trip('${trip}', '[{"email":"kept@example.com","role":"editor","name":"Neu"}]'::jsonb)`);
  await db.exec(`update auth.session set uid = '${kept}', email = 'kept@example.com'`);
  const id2 = (await db.query(`select id from public.trip_invites where email = 'kept@example.com'`)).rows[0].id;
  await db.query(`select public.accept_trip_invite_by_id('${id2}')`);
  const keptName = (await db.query(`select display_name from public.profiles where id = '${kept}'`)).rows[0].display_name;
  assert(keptName === "Bestehend", `vorhandener Name wurde zu «${keptName}»`);
  await db.exec(`update auth.session set uid = '${owner}', email = 'owner@example.com'`);
  await db.query(`select * from public.invite_to_trip('${trip}', '[{"email":"offen@example.com","role":"viewer","name":"Offen"}]'::jsonb)`);
  await db.exec(`update public.profiles set display_name = '' where id = '${open}'`);
  const listed = (await db.query(`select display_name from public.list_trip_people('${trip}') where email = 'offen@example.com'`)).rows[0];
  assert(listed?.display_name === "Offen", `leerer Profilname verdeckt die Einladung (${listed?.display_name})`);
  console.log("11 SQL paket-11-namen zweimal in PGlite OK");
}

async function testExifDateTimeTag() {
  const { parseExifTiff } = await import("../js/exif-taken-at.js");
  const tiff = buildDateTimeOnlyTiff("2026:10:27 15:37:00");
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const parsed = parseExifTiff(view, 0);
  const date = new Date(parsed.takenAt);
  assert(date.getFullYear() === 2026 && date.getMonth() === 9 && date.getDate() === 27, "DateTime-Tag Tag");
  assert(date.getHours() === 15 && date.getMinutes() === 37, "DateTime-Tag Zeit");
  const empty = parseExifTiff(new DataView(new ArrayBuffer(8)), 0);
  assert(empty.takenAt == null, "ohne EXIF bleibt leer");
  console.log("11 EXIF DateTime-Fallback gelesen, JPEG ohne EXIF bleibt leer");
}

const { server, baseUrl } = await startServer();
try {
  await testNamesSql();
  await testExifDateTimeTag();
  await runSuite(chromium, baseUrl, "chromium");
  await runSuite(webkit, baseUrl, "webkit");
  console.log(`Playwright 11 Ortszeit/Namen OK (Build 69, Bilder in ${SHOTS})`);
} finally {
  server.close();
}
