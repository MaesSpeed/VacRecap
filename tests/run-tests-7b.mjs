import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";
import { groupLibraryPhotos, isLibraryPhoto, libraryDayTitle } from "../js/library-groups.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";

const VIEWPORTS = [
  { name: "375x667", width: 375, height: 667 },
  { name: "390x844", width: 390, height: 844 },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function assertGrouping() {
  const vacation = { startDate: "2026-11-06", endDate: "2026-11-08" };
  const places = [
    { id: "a", name: "Hafen" },
    { id: "b", name: "Markt" },
  ];
  const photos = [
    {
      id: "late",
      type: "photo",
      uploadStatus: "uploaded",
      placeId: "a",
      ts: new Date(2026, 10, 6, 18, 0, 0).getTime(),
      day: "2026-11-08",
    },
    {
      id: "early",
      type: "photo",
      uploadStatus: "uploaded",
      placeId: "b",
      ts: new Date(2026, 10, 6, 9, 0, 0).getTime(),
      day: "2026-11-06",
    },
    {
      id: "vid",
      type: "video",
      uploadStatus: "uploaded",
      placeId: "a",
      ts: new Date(2026, 10, 6, 10, 0, 0).getTime(),
      day: "2026-11-06",
    },
    {
      id: "pend",
      type: "photo",
      uploadStatus: "pending",
      placeId: "a",
      ts: new Date(2026, 10, 6, 11, 0, 0).getTime(),
      day: "2026-11-06",
    },
    {
      id: "next",
      type: "photo",
      uploadStatus: "uploaded",
      placeId: "a",
      ts: new Date(2026, 10, 7, 12, 0, 0).getTime(),
      day: "2026-11-07",
    },
  ];
  if (isLibraryPhoto(photos[2]) || isLibraryPhoto(photos[3]) || !isLibraryPhoto(photos[0])) {
    throw new Error("7b: isLibraryPhoto filter falsch");
  }
  const groups = groupLibraryPhotos(photos, places);
  if (groups.length !== 2 || groups[0].day !== "2026-11-06" || groups[1].day !== "2026-11-07") {
    throw new Error(`7b: Tagesgruppen falsch (${groups.map((g) => g.day).join(",")})`);
  }
  if (groups[0].places[0].placeName !== "Markt" || groups[0].places[0].photos[0].id !== "early") {
    throw new Error("7b: Ort-Reihenfolge falsch");
  }
  if (groups[0].places[1].photos.some((p) => p.id !== "late")) {
    throw new Error("7b: Gruppierung muss taken_at nutzen, nicht die day-Spalte");
  }
  const title = libraryDayTitle(vacation, "2026-11-06");
  if (!title.includes("Anreise") || !title.includes("06.11")) {
    throw new Error(`7b: Tagesüberschrift falsch (${title})`);
  }
}

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      if (rel.endsWith("/")) rel += "index.html";
      try {
        const filePath = path.join(root, rel.replace(/^\//, ""));
        const data = await readFile(filePath);
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
    expires_at: Math.round(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: { id: userId, email: "test@example.com" },
  };
  const trips = [];
  const waypoints = [];
  const notes = [];
  const media = [];
  const storageObjects = new Map();
  const removedStorage = [];
  let signCount = 0;
  let role = "owner";
  let failMedia = false;
  let failOriginalSign = false;
  let lastMediaQuery = "";

  const qp = (url, key) => {
    for (const [k, v] of url.searchParams.entries()) {
      if (k === key || k.startsWith(`${key}=`)) return v.replace(/^eq\./, "");
    }
    return url.searchParams.get(key)?.replace(/^eq\./, "") ?? "";
  };

  return {
    userId,
    trips,
    waypoints,
    media,
    storageObjects,
    removedStorage,
    get signCount() {
      return signCount;
    },
    set signCount(n) {
      signCount = n;
    },
    get role() {
      return role;
    },
    set role(v) {
      role = v;
    },
    get failMedia() {
      return failMedia;
    },
    set failMedia(v) {
      failMedia = Boolean(v);
    },
    get failOriginalSign() {
      return failOriginalSign;
    },
    set failOriginalSign(v) {
      failOriginalSign = Boolean(v);
    },
    get lastMediaQuery() {
      return lastMediaQuery;
    },
    handleAuth(url, method, body) {
      const p = url.pathname;
      if (p.endsWith("/otp") && method === "POST") return { status: 200, json: {} };
      if (p.endsWith("/verify") && method === "POST") {
        const b = JSON.parse(body || "{}");
        if (b.token !== "123456") {
          return { status: 400, json: { error: "invalid_otp", message: "Invalid" } };
        }
        return { status: 200, json: session };
      }
      if (p.endsWith("/token") && method === "POST") return { status: 200, json: session };
      if (p.endsWith("/user") && method === "GET") return { status: 200, json: session.user };
      return { status: 404, json: {} };
    },
    handleStorage(url, method, body) {
      const p = url.pathname;
      if (p.includes("/object/sign/") && method === "POST") {
        if (failOriginalSign && p.includes("media-originals")) {
          return { status: 400, json: { message: "missing" } };
        }
        signCount += 1;
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
        const rest = p.split("/object/sign/")[1] || "";
        const token = encodeURIComponent(rest || "x");
        return { status: 200, json: { signedURL: `/object/sign/mock?token=${token}` } };
      }
      if (p.includes("/object/sign/mock") && method === "GET") {
        return { status: 200, raw: TINY_PNG, contentType: "image/jpeg" };
      }
      if (method === "DELETE" && p.includes("/object/")) {
        const bucket = decodeURIComponent(p.split("/object/")[1] || "").split("?")[0];
        let payload = {};
        try {
          payload = JSON.parse(body || "{}");
        } catch {
          payload = {};
        }
        const prefixes = Array.isArray(payload.prefixes) ? payload.prefixes : [];
        for (const pref of prefixes) {
          const key = `${bucket}/${pref}`;
          storageObjects.delete(key);
          removedStorage.push(key);
        }
        return { status: 200, json: prefixes };
      }
      if (p.includes("/object/") && (method === "POST" || method === "PUT")) {
        const rest = p.split("/object/")[1] || "";
        const slash = rest.indexOf("/");
        const bucket = rest.slice(0, slash);
        const objectPath = decodeURIComponent(rest.slice(slash + 1));
        storageObjects.set(`${bucket}/${objectPath}`, TINY_PNG);
        return { status: 200, json: { Key: objectPath } };
      }
      return { status: 404, json: {} };
    },
    handleRest(url, method, body, headers = {}) {
      const one = (row) =>
        String(headers.accept || "").includes("application/vnd.pgrst.object+json") ? row : [row];
      const table = url.pathname.split("/").filter(Boolean).pop();
      if (table === "trips") {
        if (method === "POST") {
          const row = JSON.parse(body);
          const full = {
            id: row.id || crypto.randomUUID(),
            created_by: userId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            companions: row.companions || [],
            ...row,
          };
          trips.push(full);
          return { status: 201, json: one(full) };
        }
        if (method === "GET") {
          const id = qp(url, "id");
          if (id) return { status: 200, json: trips.filter((t) => t.id === id) };
          return { status: 200, json: trips };
        }
      }
      if (table === "waypoints") {
        if (method === "GET") {
          const tripId = qp(url, "trip_id");
          return {
            status: 200,
            json: waypoints.filter((w) => w.trip_id === tripId && !w.deleted_at),
          };
        }
        if (method === "POST") {
          const row = JSON.parse(body);
          const full = {
            id: row.id || crypto.randomUUID(),
            created_by: userId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            deleted_at: null,
            ...row,
          };
          const hit = waypoints.find((w) => w.id === full.id);
          if (hit) Object.assign(hit, full);
          else waypoints.push(full);
          return { status: 201, json: one(full) };
        }
      }
      if (table === "notes" && method === "GET") {
        return { status: 200, json: notes };
      }
      if (table === "media") {
        if (method === "GET") {
          lastMediaQuery = url.search;
          if (failMedia) return { status: 500, json: { message: "mock media fail" } };
          const id = qp(url, "id");
          if (id) {
            const row = media.find((m) => m.id === id && !m.deleted_at);
            return { status: 200, json: row ? [row] : [] };
          }
          let rows = media.filter((m) => !m.deleted_at);
          const tripId = qp(url, "trip_id");
          const kind = qp(url, "kind");
          const status = qp(url, "upload_status");
          const wp = qp(url, "waypoint_id");
          if (tripId) rows = rows.filter((m) => m.trip_id === tripId);
          if (kind) rows = rows.filter((m) => m.kind === kind);
          if (status) rows = rows.filter((m) => m.upload_status === status);
          if (wp) rows = rows.filter((m) => m.waypoint_id === wp);
          const offset = Number(url.searchParams.get("offset") || 0);
          const limit = Number(url.searchParams.get("limit") || rows.length);
          return { status: 200, json: rows.slice(offset, offset + limit) };
        }
        if (method === "PATCH") {
          const id = qp(url, "id");
          const row = JSON.parse(body || "{}");
          const m = media.find((x) => x.id === id);
          if (!m) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
          Object.assign(m, row, { updated_at: new Date().toISOString() });
          return { status: 200, json: one(m) };
        }
        if (method === "POST") {
          const row = JSON.parse(body);
          const full = {
            id: row.id || crypto.randomUUID(),
            created_by: userId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            deleted_at: null,
            kind: "photo",
            upload_status: "pending",
            ...row,
          };
          media.push(full);
          return { status: 201, json: one(full) };
        }
      }
      if (table === "trip_members" && method === "GET") {
        return { status: 200, json: [{ role }] };
      }
      return { status: 404, json: { message: "not found" } };
    },
  };
}

function addMedia(state, fields) {
  const id = crypto.randomUUID();
  const isVideo = fields.kind === "video";
  const row = {
    id,
    trip_id: fields.tripId,
    waypoint_id: fields.placeId,
    day: fields.day,
    taken_at: fields.takenAt,
    kind: fields.kind || "photo",
    storage_path: isVideo ? null : `${fields.tripId}/${id}.jpg`,
    thumb_path: isVideo ? null : `${fields.tripId}/${id}.jpg`,
    mime: isVideo ? "video/mp4" : "image/jpeg",
    upload_status: fields.status || "uploaded",
    deleted_at: null,
    created_by: state.userId,
    created_at: fields.takenAt,
    updated_at: fields.takenAt,
    width: 32,
    height: 32,
  };
  state.media.push(row);
  if (row.storage_path) {
    state.storageObjects.set(`media-originals/${row.storage_path}`, TINY_PNG);
    state.storageObjects.set(`media-thumbs/${row.thumb_path}`, TINY_PNG);
  }
  return row;
}

async function installSupabaseMocks(page, state) {
  await page.route(`**/${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const body = req.postDataBuffer()?.toString("utf8") ?? req.postData();
    const headers = req.headers();
    let result;
    if (url.pathname.includes("/auth/v1/")) result = state.handleAuth(url, method, body);
    else if (url.pathname.includes("/storage/v1/")) result = state.handleStorage(url, method, body);
    else if (url.pathname.includes("/rest/v1/")) result = state.handleRest(url, method, body, headers);
    else result = { status: 404, json: {} };
    if (result.raw) {
      await route.fulfill({
        status: result.status,
        contentType: result.contentType || "application/octet-stream",
        body: result.raw,
      });
      return;
    }
    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      body: result.json ? JSON.stringify(result.json) : "",
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

async function seedTrip(page) {
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', "Foto-Reise");
  await page.click('[data-action="pick-dates"]');
  await page.click('.calendar-day[data-date="2026-11-06"]');
  await page.click('.calendar-day[data-date="2026-11-08"]');
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  const tripId = await page.locator(".screen--trip").getAttribute("data-vacation-id");
  const day = "2026-11-06";
  const placeId = await page.evaluate(
    async ({ tripId, day }) => {
      const { putPlace } = await import("./js/db.js");
      const { createPlace } = await import("./js/places.js");
      const place = await putPlace(
        createPlace({
          vacationId: tripId,
          day,
          ts: new Date(2026, 10, 6, 8, 0, 0).getTime(),
          lat: 48.8566,
          lng: 2.3522,
          name: "Foto-Ort",
          soft: false,
          source: "test",
        })
      );
      window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
      return place.id;
    },
    { tripId, day }
  );
  await page.waitForSelector(".place-list .oc", { timeout: 20_000 });
  const placeB = await page.evaluate(
    async ({ tripId }) => {
      const { putPlace } = await import("./js/db.js");
      const { createPlace } = await import("./js/places.js");
      const place = await putPlace(
        createPlace({
          vacationId: tripId,
          day: "2026-11-06",
          ts: new Date(2026, 10, 6, 14, 0, 0).getTime(),
          lat: 48.86,
          lng: 2.36,
          name: "Zweiter Ort",
          soft: false,
          source: "test",
        })
      );
      return place.id;
    },
    { tripId }
  );
  return { tripId, placeId, placeB };
}

async function swipeTripDay(page, direction) {
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-testid="trip-content"]');
    return root?.dataset.canNext === "1" || root?.dataset.canPrev === "1";
  });
  const box = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="trip-content"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (!box?.width) throw new Error("Tag-Inhalt ohne Fläche");
  const y = box.y + Math.min(120, box.height / 2);
  const startX = direction === "next" ? box.x + box.width - 24 : box.x + 24;
  const endX = direction === "next" ? box.x + 24 : box.x + box.width - 24;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(endX, y, { steps: 12 });
  await page.mouse.up();
}

async function openLibrary(page) {
  await page.click('[data-footer-action="gallery"]');
  await page.waitForSelector('[data-testid="trip-library-screen"]');
}

async function swipeNext(page) {
  await page.evaluate(() => {
    const stage = document.querySelector('[data-role="stage"]');
    if (!stage) throw new Error("no stage");
    const fire = (type, x) => {
      const touch = { clientX: x, clientY: 240, identifier: 1, target: stage };
      const ev = new Event(type, { bubbles: true, cancelable: true });
      ev.touches = type === "touchend" ? [] : [touch];
      ev.changedTouches = [touch];
      stage.dispatchEvent(ev);
    };
    fire("touchstart", 280);
    fire("touchend", 40);
  });
}

async function runLibrarySuite(page, state, label, shotPath) {
  await page.goto(state.baseUrl || "/");
  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  if (Number(build) !== 65) throw new Error(`${label}: Build ${build} != 65`);
  await login(page);
  const { tripId, placeId, placeB } = await seedTrip(page);

  await page.waitForSelector('[data-testid="place-gallery"]');
  const [placeChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click('[data-testid="place-gallery"]'),
  ]);
  const placeInput = await placeChooser.element();
  const placeInputMeta = await placeInput.evaluate((node) => ({
    testid: node.dataset.testid,
    capture: node.getAttribute("capture"),
    multiple: node.multiple,
    accept: node.getAttribute("accept") || "",
  }));
  if (placeInputMeta.testid !== "gallery-input" || placeInputMeta.capture) {
    throw new Error(`${label}: Ort-Karte öffnet nicht den Galerie-Input (${JSON.stringify(placeInputMeta)})`);
  }
  if (!placeInputMeta.multiple || !placeInputMeta.accept.includes("image")) {
    throw new Error(`${label}: Galerie-Input ohne Mehrfachauswahl (${JSON.stringify(placeInputMeta)})`);
  }
  await placeChooser.setFiles({
    name: "clip.mov",
    mimeType: "video/quicktime",
    buffer: Buffer.from([0, 0, 0, 1]),
  });
  await page.waitForFunction(
    () => document.body.innerText.includes("Videos kommen"),
    null,
    { timeout: 10_000 }
  );
  await page.waitForFunction(() => document.querySelector(".screen--trip")?.dataset.captureBusy !== "1");
  await page.waitForTimeout(500);

  await openLibrary(page);
  await page.waitForSelector('[data-testid="library-empty"]');
  if ((await page.locator('[data-testid="library-add-photos"]').count()) !== 1) {
    throw new Error(`${label}: + Fotos fehlt im Kopf`);
  }
  if ((await page.locator('[data-testid="library-add-photos-empty"]').count()) !== 1) {
    throw new Error(`${label}: + Fotos fehlt im Leerzustand`);
  }
  const galleryMeta = await page.locator('[data-testid="library-gallery-input"]').evaluate((node) => ({
    capture: node.getAttribute("capture"),
    multiple: node.multiple,
    accept: node.getAttribute("accept") || "",
  }));
  if (galleryMeta.capture || !galleryMeta.multiple || !galleryMeta.accept.includes("image")) {
    throw new Error(`${label}: Mediathek-Galerie-Input falsch (${JSON.stringify(galleryMeta)})`);
  }
  const [addChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click('[data-testid="library-add-photos-empty"]'),
  ]);
  await addChooser.setFiles({
    name: "aus-fotos.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });
  await page.waitForSelector('[data-testid="photo-upload-sheet"]', { timeout: 15_000 });
  await page.waitForFunction(
    () => document.querySelector(".photo-upload-item__status")?.textContent?.includes("✓"),
    null,
    { timeout: 60_000 }
  );
  await page.click('[data-testid="photo-upload-sheet"] [data-action="close"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);
  state.media.length = 0;
  state.storageObjects.clear();
  await page.click('[data-testid="library-back"]');
  await page.waitForSelector('[data-testid="trip-content"]');

  const spiaggiaId = await page.evaluate(async ({ tripId }) => {
    const { putPlace } = await import("./js/db.js");
    const { createPlace } = await import("./js/places.js");
    const place = await putPlace(
      createPlace({
        vacationId: tripId,
        day: "2026-11-07",
        ts: new Date(2026, 10, 7, 12, 0, 0).getTime(),
        lat: 41.2,
        lng: 9.2,
        name: "Spiaggia Baia",
        soft: false,
        source: "test",
      })
    );
    window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
    return place.id;
  }, { tripId });
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-testid="trip-content"]');
    return root?.dataset.activeDay === "2026-11-06" && root.dataset.canNext === "1";
  });
  await swipeTripDay(page, "next");
  await page.waitForFunction(
    () => document.querySelector('.day-chip[aria-selected="true"]')?.dataset.day === "2026-11-07",
    null,
    { timeout: 8_000 }
  );
  await page.waitForFunction(
    () => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2026-11-07"
  );
  await page.waitForFunction(() => document.body.innerText.includes("Spiaggia Baia"));
  await openLibrary(page);
  const [dayChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click('[data-testid="library-add-photos"], [data-testid="library-add-photos-empty"]'),
  ]);
  await dayChooser.setFiles({
    name: "tag-foto.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });
  await page.waitForSelector('[data-testid="photo-upload-target"]');
  const targetText = await page.locator('[data-testid="photo-upload-target"]').innerText();
  if (!targetText.includes("07.11") || !targetText.includes("Spiaggia Baia")) {
    throw new Error(`${label}: Upload-Ziel falsch (${targetText})`);
  }
  await page.waitForFunction(
    () => document.querySelector(".photo-upload-item__status")?.textContent?.includes("✓"),
    null,
    { timeout: 60_000 }
  );
  const landed = state.media.find((m) => m.waypoint_id === spiaggiaId && !m.deleted_at);
  if (!landed || landed.day !== "2026-11-07") {
    throw new Error(
      `${label}: Foto nicht am gewischten Tag (${JSON.stringify(state.media.map((m) => ({ day: m.day, wp: m.waypoint_id })))})`
    );
  }
  await page.click('[data-testid="photo-upload-sheet"] [data-action="close"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);
  state.media.length = 0;
  state.storageObjects.clear();
  await page.click('[data-testid="library-back"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  await swipeTripDay(page, "next");
  await page.waitForFunction(
    () => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2026-11-08"
  );
  await openLibrary(page);
  const [fallbackChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click('[data-testid="library-add-photos"], [data-testid="library-add-photos-empty"]'),
  ]);
  await fallbackChooser.setFiles({
    name: "ohne-ort.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });
  await page.waitForSelector('[data-testid="photo-upload-target"]');
  const fallbackText = await page.locator('[data-testid="photo-upload-target"]').innerText();
  if (!fallbackText.includes("08.11") || !fallbackText.includes("Ohne Ort")) {
    throw new Error(`${label}: Fallback-Ziel nicht sichtbar (${fallbackText})`);
  }
  await page.waitForFunction(
    () => document.querySelector(".photo-upload-item__status")?.textContent?.includes("✓"),
    null,
    { timeout: 60_000 }
  );
  const fallbackRow = state.media.find((m) => m.day === "2026-11-08" && !m.deleted_at);
  if (!fallbackRow) throw new Error(`${label}: Fallback-Foto nicht am leeren Tag`);
  await page.click('[data-testid="photo-upload-sheet"] [data-action="close"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);
  state.media.length = 0;
  state.storageObjects.clear();
  await page.click('[data-testid="library-back"]');
  await page.waitForSelector('[data-testid="trip-content"]');

  const morning = new Date(2026, 10, 6, 9, 30, 0).toISOString();
  const afternoon = new Date(2026, 10, 6, 16, 0, 0).toISOString();
  const secondDay = new Date(2026, 10, 7, 11, 0, 0).toISOString();
  const photoA = addMedia(state, {
    tripId,
    placeId,
    day: "2026-11-08",
    takenAt: morning,
    status: "uploaded",
  });
  const photoB = addMedia(state, {
    tripId,
    placeId: placeB,
    day: "2026-11-06",
    takenAt: afternoon,
    status: "uploaded",
  });
  const photoC = addMedia(state, {
    tripId,
    placeId,
    day: "2026-11-07",
    takenAt: secondDay,
    status: "uploaded",
  });
  addMedia(state, { tripId, placeId, day: "2026-11-06", takenAt: morning, status: "pending" });
  addMedia(state, { tripId, placeId, day: "2026-11-06", takenAt: morning, status: "failed" });
  const video = addMedia(state, {
    tripId,
    placeId,
    day: "2026-11-06",
    takenAt: afternoon,
    status: "uploaded",
    kind: "video",
  });
  for (let i = 0; i < 36; i += 1) {
    addMedia(state, {
      tripId,
      placeId,
      day: "2026-11-08",
      takenAt: new Date(2026, 10, 8, 10, i, 0).toISOString(),
      status: "uploaded",
    });
  }

  state.signCount = 0;
  await openLibrary(page);
  await page.waitForSelector(".library-thumb__img", { timeout: 15_000 });

  if (!state.lastMediaQuery.includes("upload_status=eq.uploaded") || !state.lastMediaQuery.includes("kind=eq.photo")) {
    throw new Error(`${label}: Query filter fehlt (${state.lastMediaQuery})`);
  }

  const structure = await page.evaluate(() => {
    const days = [...document.querySelectorAll(".library-day")].map((el) => ({
      day: el.dataset.day,
      title: el.querySelector(".library-day__title")?.textContent || "",
      places: [...el.querySelectorAll(".library-place")].map((p) => ({
        name: p.querySelector(".oc__title")?.textContent || "",
        ids: [...p.querySelectorAll(".library-thumb")].map((t) => t.dataset.mediaId),
      })),
    }));
    const thumbs = document.querySelectorAll(".library-thumb").length;
    const imgs = [...document.querySelectorAll(".library-thumb__img")];
    const blob = imgs.some((img) => (img.getAttribute("src") || "").startsWith("blob:"));
    const doc = document.documentElement;
    return {
      days,
      thumbs,
      loaded: imgs.length,
      blob,
      overflow: doc.scrollWidth > doc.clientWidth + 1,
      idb: window.__idbOpens || 0,
    };
  });

  if (structure.thumbs !== 39) throw new Error(`${label}: erwartet 39 Fotos, got ${structure.thumbs}`);
  if (structure.blob) throw new Error(`${label}: Thumbnail nutzt Blob-URL`);
  if (structure.overflow) throw new Error(`${label}: horizontaler Overflow`);
  if (structure.idb) throw new Error(`${label}: IndexedDB wurde geöffnet (${structure.idb})`);
  if (structure.days[0]?.day !== "2026-11-06") throw new Error(`${label}: erster Tag falsch`);
  if (!structure.days[0].title.includes("Anreise")) throw new Error(`${label}: Anreise fehlt (${structure.days[0].title})`);
  if (structure.days[0].places[0]?.name !== "Foto-Ort") throw new Error(`${label}: erster Ort falsch`);
  if (structure.days[0].places[0].ids[0] !== photoA.id) {
    throw new Error(`${label}: Foto liegt nicht nach taken_at im ersten Ort`);
  }
  if (structure.days[0].places[1]?.name !== "Zweiter Ort" || structure.days[0].places[1].ids[0] !== photoB.id) {
    throw new Error(`${label}: zweiter Ort falsch`);
  }
  const day8 = structure.days.find((d) => d.day === "2026-11-08");
  const day8ids = day8?.places.flatMap((p) => p.ids) || [];
  if (day8ids.includes(photoA.id)) throw new Error(`${label}: day-Spalte hat die Gruppe bestimmt`);
  const allIds = structure.days.flatMap((d) => d.places.flatMap((p) => p.ids));
  if (allIds.includes(video.id)) throw new Error(`${label}: Video wird angezeigt`);
  if (structure.loaded >= structure.thumbs) {
    throw new Error(`${label}: alle ${structure.thumbs} Thumbs sofort geladen (${structure.loaded})`);
  }
  if (state.signCount <= 0 || state.signCount >= 39) {
    throw new Error(`${label}: Signed-URL-Anfragen nicht begrenzt (${state.signCount})`);
  }
  if ((await page.locator('[data-testid="library-add-photos"]').count()) !== 1) {
    throw new Error(`${label}: + Fotos fehlt bei gefüllter Mediathek`);
  }

  const thumbsBeforeOffline = await page.locator(".library-thumb").count();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    window.dispatchEvent(new Event("offline"));
  });
  await page.waitForSelector('[data-testid="library-offline"]');
  const offlineText = await page.locator('[data-testid="library-offline"]').innerText();
  if (!offlineText.includes("Du bist offline")) {
    throw new Error(`${label}: Offline-Text fehlt (${offlineText})`);
  }
  if ((await page.locator(".library-thumb").count()) !== thumbsBeforeOffline) {
    throw new Error(`${label}: Offline hat die Mediathek geleert`);
  }
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
    window.dispatchEvent(new Event("online"));
  });
  await page.waitForFunction(() => !document.querySelector('[data-testid="library-offline"]'));

  await page.waitForFunction(() => {
    const el = document.querySelector(".library-main");
    return el && el.scrollHeight > el.clientHeight + 40;
  });
  const signsBeforeScroll = state.signCount;
  const loadedBeforeScroll = await page.locator(".library-thumb__img").count();
  await page.locator(".library-main").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForFunction(
    (before) => document.querySelectorAll(".library-thumb__img").length > before,
    loadedBeforeScroll
  );
  if (state.signCount <= signsBeforeScroll && (await page.locator(".library-thumb__img").count()) <= loadedBeforeScroll) {
    throw new Error(`${label}: Scroll lädt keine weiteren Thumbs (${state.signCount})`);
  }

  if (shotPath) {
    await page.locator(".library-main").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: shotPath, fullPage: false });
  }

  const firstThumb = page.locator(`.library-thumb[data-media-id="${photoA.id}"]`);
  await firstThumb.scrollIntoViewIfNeeded();
  await firstThumb.click();
  await page.waitForSelector('[data-testid="media-viewer-img"]');
  const src1 = await page.locator('[data-testid="media-viewer-img"]').getAttribute("src");
  await swipeNext(page);
  await page.waitForFunction((prev) => {
    const img = document.querySelector('[data-testid="media-viewer-img"]');
    return img && img.getAttribute("src") && img.getAttribute("src") !== prev;
  }, src1);
  const src2 = await page.locator('[data-testid="media-viewer-img"]').getAttribute("src");
  if (!src2 || src2 === src1) throw new Error(`${label}: Wischen wechselt das Foto nicht`);
  if (await page.locator('[data-testid="media-viewer-delete"]').count() !== 1) {
    throw new Error(`${label}: Owner sieht keinen Löschen-Knopf`);
  }
  await page.click('[data-testid="media-viewer-close"]');
  await page.waitForSelector('[data-testid="trip-library"]');

  await page.locator(`.library-thumb[data-media-id="${photoC.id}"]`).click();
  await page.waitForSelector('[data-testid="media-viewer-delete"]');
  await page.click('[data-testid="media-viewer-delete"]');
  await page.waitForSelector('[data-testid="confirm-delete-media"]');
  await page.click('[data-testid="confirm-delete-media"] [data-action="cancel"]');
  if (!state.media.find((m) => m.id === photoC.id && !m.deleted_at)) {
    throw new Error(`${label}: Abbrechen hat gelöscht`);
  }
  await page.click('[data-testid="media-viewer-delete"]');
  await page.click('[data-testid="confirm-delete-media"] [data-action="confirm"]');
  await page.waitForFunction(
    (id) => !document.querySelector(`.library-thumb[data-media-id="${id}"]`),
    photoC.id
  );
  const deleted = state.media.find((m) => m.id === photoC.id);
  if (!deleted?.deleted_at) throw new Error(`${label}: DB-Eintrag nicht als gelöscht markiert`);
  const origKey = `media-originals/${photoC.storage_path}`;
  const thumbKey = `media-thumbs/${photoC.thumb_path}`;
  if (!state.storageObjects.has(origKey) || !state.storageObjects.has(thumbKey)) {
    throw new Error(`${label}: Storage schon vor Ablauf des Toasts gelöscht`);
  }
  await page.click('[data-action="undo"]');
  await page.waitForSelector(`.library-thumb[data-media-id="${photoC.id}"]`);
  const restored = state.media.find((m) => m.id === photoC.id);
  if (restored?.deleted_at) throw new Error(`${label}: Rückgängig hat deleted_at nicht geleert`);
  if (!state.storageObjects.has(origKey) || !state.storageObjects.has(thumbKey)) {
    throw new Error(`${label}: Rückgängig hat Storage-Dateien entfernt`);
  }
  if ((await page.locator('[data-testid="media-viewer-delete"]').count()) !== 1) {
    await page.locator(`.library-thumb[data-media-id="${photoC.id}"]`).click();
    await page.waitForSelector('[data-testid="media-viewer-delete"]');
  }
  await page.click('[data-testid="media-viewer-delete"]');
  await page.click('[data-testid="confirm-delete-media"] [data-action="confirm"]');
  await page.waitForFunction(
    (id) => !document.querySelector(`.library-thumb[data-media-id="${id}"]`),
    photoC.id
  );
  await page.waitForTimeout(6500);
  if (state.storageObjects.has(origKey) || state.storageObjects.has(thumbKey)) {
    throw new Error(`${label}: Storage bleibt nach Toast stehen (${state.removedStorage.join(",")})`);
  }
  if (!state.media.find((m) => m.id === photoC.id)?.deleted_at) {
    throw new Error(`${label}: Foto nach Ablauf nicht gelöscht`);
  }

  if ((await page.locator('[data-testid="media-viewer"]').count()) > 0) {
    await page.click('[data-testid="media-viewer-close"]');
    await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);
  }
  await page.locator(`.library-thumb[data-media-id="${photoB.id}"]`).click();
  await page.waitForSelector('[data-testid="media-viewer-delete"]');
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
  });
  await page.click('[data-testid="media-viewer-delete"]');
  await page.click('[data-testid="confirm-delete-media"] [data-action="confirm"]');
  await page.waitForFunction(() => document.body.innerText.includes("Offline, bitte später erneut versuchen."));
  if (state.media.find((m) => m.id === photoB.id)?.deleted_at) {
    throw new Error(`${label}: Offline-Löschen hat das Foto entfernt`);
  }
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
  });
  await page.click('[data-testid="media-viewer-close"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);

  await page.evaluate(async () => {
    const { clearSignedUrlCache } = await import("./js/media-signed-url-cache.js");
    clearSignedUrlCache();
  });
  state.failOriginalSign = true;
  await page.locator(`.library-thumb[data-media-id="${photoA.id}"]`).click();
  await page.waitForSelector('[data-testid="media-viewer-missing"]');
  if ((await page.locator('[data-testid="media-viewer-img"]').count()) !== 0) {
    throw new Error(`${label}: Fehlende Datei zeigt trotzdem ein Bild`);
  }
  state.failOriginalSign = false;
  await page.click('[data-testid="media-viewer-close"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);

  await page.click('[data-testid="library-back"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  state.failMedia = true;
  await openLibrary(page);
  await page.waitForSelector('[data-testid="library-error"]');
  const retryText = await page.locator('[data-testid="library-retry"]').innerText();
  if (!retryText.includes("Erneut versuchen")) throw new Error(`${label}: Retry-Text fehlt`);
  state.failMedia = false;
  await page.click('[data-testid="library-retry"]');
  await page.waitForSelector(".library-thumb");

  state.role = "viewer";
  await page.evaluate(async () => {
    const { clearTripRoleCache } = await import("./js/trip-role.js");
    clearTripRoleCache();
  });
  await page.click('[data-testid="library-back"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  await openLibrary(page);
  await page.waitForSelector(".library-thumb");
  await page.waitForSelector('[data-testid="library-add-photos"]');
  await page.locator(".library-thumb").first().click();
  await page.waitForSelector('[data-testid="media-viewer"]');
  if (await page.locator('[data-testid="media-viewer-delete"]').count() !== 1) {
    throw new Error(`${label}: Beitragender löscht das eigene Foto nicht`);
  }
  await page.click('[data-testid="media-viewer-close"]');

  const cache = await page.evaluate(async () => {
    const { clearSignedUrlCache, getSignedThumbUrl, signedUrlCacheCounts } = await import(
      "./js/media-signed-url-cache.js"
    );
    const { getSupabase } = await import("./js/supabase-client.js");
    clearSignedUrlCache();
    const supabase = getSupabase();
    for (let i = 0; i < 100; i += 1) {
      await getSignedThumbUrl(supabase, `cache-probe/${i}.jpg`);
    }
    return signedUrlCacheCounts();
  });
  if (cache.thumbs !== 80 || cache.thumbs > cache.max) {
    throw new Error(`${label}: Signed-URL-Cache ${cache.thumbs}/${cache.max}`);
  }
}

async function main() {
  assertGrouping();
  const { server, baseUrl } = await startServer();
  try {
    for (const browser of [
      { name: "chromium", launcher: chromium },
      { name: "webkit", launcher: webkit },
    ]) {
      for (const vp of VIEWPORTS) {
        const state = createMockSupabaseState();
        state.baseUrl = baseUrl;
        const userData = path.join("/tmp", `vacrecap-7b-${browser.name}-${vp.name}-${Date.now()}`);
        const ctx = await browser.launcher.launchPersistentContext(userData, {
          baseURL: baseUrl,
          ...devices["iPhone 8"],
          viewport: { width: vp.width, height: vp.height },
          geolocation: { latitude: 48.8566, longitude: 2.3522 },
          permissions: ["geolocation"],
        });
        await ctx.addInitScript(() => {
          window.__idbOpens = 0;
          const orig = indexedDB.open.bind(indexedDB);
          indexedDB.open = (...args) => {
            window.__idbOpens += 1;
            return orig(...args);
          };
        });
        const page = await ctx.newPage();
        page.setDefaultTimeout(20_000);
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await installSupabaseMocks(page, state);
        const shot =
          browser.name === "chromium" && vp.name === "375x667"
            ? "/tmp/vacrecap-7b-library-375.png"
            : "";
        await runLibrarySuite(page, state, `7b-${browser.name}-${vp.name}`, shot);
        await ctx.close();
      }
    }
  } finally {
    server.close();
  }
  console.log("Playwright 7b tests OK (Build 65)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
