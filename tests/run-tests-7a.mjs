import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";

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

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      if (rel.startsWith("/mock-media/")) {
        res.writeHead(200, { "Content-Type": "image/jpeg" });
        res.end(TINY_PNG);
        return;
      }
      if (rel.endsWith("/")) rel += "index.html";
      try {
        let filePath = path.join(root, rel.replace(/^\//, ""));
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

function createMockSupabaseState(baseUrl) {
  const userId = "11111111-1111-1111-1111-111111111111";
  const session = {
    access_token: "test-access",
    refresh_token: "test-refresh",
    user: { id: userId, email: "test@example.com" },
  };
  const trips = [];
  const waypoints = [];
  const notes = [];
  const media = [];
  const storageObjects = new Map();
  const uploadLog = [];
  let otp = "123456";
  let failOriginalUploads = 0;
  let failAllOriginalUploads = false;
  let failMediaList = false;
  let failNextOriginalOffline = 0;

  return {
    userId,
    session,
    trips,
    waypoints,
    notes,
    media,
    uploadLog,
    setFailOriginalUploads(n) {
      failOriginalUploads = n;
    },
    setFailAllOriginalUploads(v) {
      failAllOriginalUploads = Boolean(v);
    },
    setFailMediaList(v) {
      failMediaList = Boolean(v);
    },
    setFailNextOriginalOffline(n) {
      failNextOriginalOffline = Math.max(0, Number(n) || 0);
    },
    setOtp(code) {
      otp = code;
    },
    handleAuth(url, method, body) {
      const p = url.pathname;
      if (p.endsWith("/otp") && method === "POST") return { status: 200, json: {} };
      if (p.endsWith("/verify") && method === "POST") {
        const b = JSON.parse(body || "{}");
        if (b.token !== otp) {
          return {
            status: 400,
            json: { error: "invalid_otp", error_description: "Invalid OTP", message: "Invalid" },
          };
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
      if (p.endsWith("/token") && method === "POST") return { status: 200, json: session };
      if (p.endsWith("/user") && method === "GET") return { status: 200, json: session.user };
      return { status: 404, json: {} };
    },
    handleStorage(url, method, body, base) {
      const p = url.pathname;
      if (p.includes("/object/sign/") && method === "POST") {
        const rest = p.split("/object/sign/")[1] || "";
        const slash = rest.indexOf("/");
        const bucket = slash >= 0 ? rest.slice(0, slash) : rest;
        const objectPath = slash >= 0 ? decodeURIComponent(rest.slice(slash + 1)) : "";
        const key = objectPath ? `${bucket}/${objectPath}` : bucket;
        if (objectPath && !storageObjects.has(`${bucket}/${objectPath}`)) {
          storageObjects.set(`${bucket}/${objectPath}`, TINY_PNG);
        }
        const token = encodeURIComponent(key || bucket);
        return { status: 200, json: { signedURL: `/object/sign/mock?token=${token}` } };
      }
      if (p.includes("/object/sign/mock") && method === "GET") {
        return { status: 200, raw: TINY_PNG, contentType: "image/jpeg" };
      }
      if (p.includes("/object/") && (method === "POST" || method === "PUT")) {
        const rest = p.split("/object/")[1] || "";
        const slash = rest.indexOf("/");
        const bucket = rest.slice(0, slash);
        const objectPath = decodeURIComponent(rest.slice(slash + 1));
        const key = `${bucket}/${objectPath}`;
        if (bucket === "media-originals" && failNextOriginalOffline > 0) {
          failNextOriginalOffline -= 1;
          return { abort: "connectionfailed", setOffline: true };
        }
        if (bucket === "media-originals" && (failAllOriginalUploads || failOriginalUploads > 0)) {
          if (failOriginalUploads > 0) failOriginalUploads -= 1;
          return { status: 500, json: { message: "mock upload fail" } };
        }
        storageObjects.set(key, body ? Buffer.from(body, "binary") : TINY_PNG);
        uploadLog.push(key);
        return { status: 200, json: { Key: objectPath } };
      }
      return { status: 404, json: {} };
    },
    handleRest(url, method, body, headers) {
      const table = url.pathname.split("/").filter(Boolean).pop();
      const prefer = headers.prefer || "";
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
          created_by: userId,
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
          const row = JSON.parse(body);
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
          const rows = waypoints.filter((w) => w.trip_id === tripId && !w.deleted_at);
          return { status: 200, json: rows };
        }
        if (method === "POST") {
          const row = JSON.parse(body);
          const full = upsertRow(waypoints, row, {});
          return { status: 201, json: [full] };
        }
        if (method === "PATCH") {
          const id = qp("id");
          const row = JSON.parse(body);
          const w = waypoints.find((x) => x.id === id);
          if (!w) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
          Object.assign(w, row, { updated_at: new Date().toISOString() });
          return { status: 200, json: [w] };
        }
      }
      if (table === "notes") {
        if (method === "GET") {
          const wp = qp("waypoint_id");
          const rows = notes.filter((n) => n.waypoint_id === wp && !n.deleted_at);
          return { status: 200, json: rows };
        }
        if (method === "POST") {
          const row = JSON.parse(body);
          const full = upsertRow(notes, row, {});
          return { status: 201, json: [full] };
        }
        if (method === "PATCH") {
          const id = qp("id");
          const row = JSON.parse(body);
          const n = notes.find((x) => x.id === id);
          if (!n) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
          Object.assign(n, row, { updated_at: new Date().toISOString() });
          return { status: 200, json: [n] };
        }
      }
      if (table === "media") {
        if (method === "GET") {
          const tripId = qp("trip_id");
          if (tripId && failMediaList) {
            return { status: 500, json: { message: "mock media list fail" } };
          }
          const wp = qp("waypoint_id");
          if (wp) {
            const rows = media.filter((m) => m.waypoint_id === wp && !m.deleted_at);
            return { status: 200, json: rows };
          }
          const id = qp("id");
          if (id) {
            const m = media.find((x) => x.id === id);
            return { status: 200, json: m ? [m] : [] };
          }
          return { status: 200, json: media.filter((m) => !m.deleted_at) };
        }
        if (method === "POST") {
          const row = JSON.parse(body);
          const full = upsertRow(media, row, { kind: row.kind || "photo", upload_status: row.upload_status || "pending" });
          return { status: 201, json: [full] };
        }
        if (method === "PATCH") {
          const id = qp("id");
          const row = JSON.parse(body);
          const m = media.find((x) => x.id === id);
          if (!m) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
          Object.assign(m, row, { updated_at: new Date().toISOString() });
          return { status: 200, json: [m] };
        }
      }
      if (table === "trip_members") {
        if (method === "GET") {
          return { status: 200, json: [{ role: "owner" }] };
        }
      }
      return { status: 404, json: { message: "not found" } };
    },
  };
}

async function installSupabaseMocks(page, state, baseUrl) {
  await page.route(`**/${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const body = req.postDataBuffer()?.toString("binary") ?? req.postData();
    const headers = req.headers();
    let result;
    if (url.pathname.includes("/auth/v1/")) {
      result = state.handleAuth(url, method, body);
    } else if (url.pathname.includes("/storage/v1/")) {
      result = state.handleStorage(url, method, body, baseUrl);
      if (result?.abort) {
        if (result.setOffline) {
          await page.evaluate(() => {
            Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
          });
        }
        await route.abort(result.abort);
        return;
      }
    } else if (url.pathname.includes("/rest/v1/")) {
      result = state.handleRest(url, method, body, headers);
    } else {
      result = { status: 404, json: {} };
    }
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

async function seedTripWithPlace(page) {
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
  const wp = await page.evaluate(
    async ({ tripId, day }) => {
      const { putPlace } = await import("./js/db.js");
      const { createPlace } = await import("./js/places.js");
      const place = await putPlace(
        createPlace({
          vacationId: tripId,
          day,
          ts: Date.now(),
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
  return { tripId, day, placeId: wp };
}

async function runPhotoSuite(page, baseUrl, state, fixturePaths, label) {
  const [fixturePath, fixturePathB, fixturePathC] = fixturePaths;
  await page.goto(baseUrl);
  const v = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  if (Number(v) !== 50) throw new Error(`${label}: Build ${v} != 50`);
  await login(page);
  const { tripId, day, placeId } = await seedTripWithPlace(page);

  state.setFailMediaList(true);
  await page.evaluate(() => {
    location.hash = "#/urlaube";
  });
  await page.waitForSelector(".screen--urlaube", { timeout: 15_000 });
  const cloudBlocked = await page.locator("text=Cloud ist gerade nicht erreichbar").count();
  if (cloudBlocked > 0) {
    throw new Error(`${label}: Reisen-Übersicht blockiert bei Media-500`);
  }
  state.setFailMediaList(false);
  await page.evaluate(
    (id) => {
      location.hash = `#/urlaub/${id}`;
    },
    tripId
  );
  await page.waitForSelector('[data-testid="trip-content"]', { timeout: 15_000 });

  await page.setInputFiles('[data-testid="gallery-input"]', [
    { name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.from([0, 0, 0, 0]) },
    { name: "mix.png", mimeType: "image/png", buffer: TINY_PNG },
  ]);
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="app-toast"]')?.textContent?.includes("Videos kommen") ||
      document.body.innerText.includes("Videos kommen"),
    null,
    { timeout: 10_000 }
  );
  await page.waitForSelector('[data-testid="photo-upload-sheet"]', { state: "visible", timeout: 15_000 });
  await page.waitForFunction(
    () => {
      const items = document.querySelectorAll(".photo-upload-item__status");
      return items.length >= 1 && [...items].every((el) => el.textContent?.includes("✓"));
    },
    null,
    { timeout: 60_000 }
  );
  await page.click('[data-testid="photo-upload-sheet"] [data-action="close"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden, null, {
    timeout: 10_000,
  });
  state.media.length = 0;

  const offlineErrOk = await page.evaluate(async () => {
    const { CloudOfflineError } = await import("./js/cloud-errors.js");
    const { CloudUploadFailedError } = await import("./js/cloud-photo-upload.js");
    const wrapped = new CloudUploadFailedError("fail", { id: "x" }, { cause: new CloudOfflineError() });
    const withRecord = new CloudOfflineError("off", { mediaRecord: { id: "keep-me" } });
    return (
      wrapped.cause instanceof CloudOfflineError && withRecord.mediaRecord?.id === "keep-me"
    );
  });
  if (!offlineErrOk) throw new Error(`${label}: CloudOfflineError nicht als cause erhalten`);

  const resize = await page.evaluate(async () => {
    const blob = await (await fetch("./tests/fixtures/test-photo.png")).blob();
    const file = new File([blob], "test.png", { type: "image/png" });
    const { processPhotoForCloud } = await import("./js/media-process.js");
    const r = await processPhotoForCloud(file);
    return { w: r.w, h: r.h, blobSize: r.blob.size, thumbSize: r.thumbBlob.size };
  });
  if (resize.w > 2048 || resize.h > 2048) {
    throw new Error(`${label}: resize max edge > 2048 (${resize.w}x${resize.h})`);
  }
  if (resize.blobSize > 1_000_000) {
    throw new Error(`${label}: JPEG blob > 1MB`);
  }
  if (resize.thumbSize > 100_000) {
    throw new Error(`${label}: thumb > 100KB`);
  }

  state.uploadLog.length = 0;
  state.media.length = 0;
  const fixtures = [fixturePath, fixturePathB, fixturePathC];
  await page.setInputFiles('[data-testid="gallery-input"]', fixtures);
  await page.waitForSelector('[data-testid="photo-upload-sheet"]', { timeout: 15_000 });
  await page.waitForFunction(
    () => {
      const items = document.querySelectorAll(".photo-upload-item__status");
      return items.length >= 3 && [...items].every((el) => el.textContent?.includes("✓"));
    },
    null,
    { timeout: 60_000 }
  );
  if (state.media.length !== 3) {
    throw new Error(`${label}: erwartet 3 media-Zeilen, got ${state.media.length}`);
  }
  if (state.media.some((m) => !m.height || !m.width)) {
    throw new Error(`${label}: width/height fehlt in media (${JSON.stringify(state.media.map((m) => ({ w: m.width, h: m.height })))})`);
  }

  const thumbBefore = state.uploadLog.filter((k) => k.startsWith("media-thumbs/")).length;
  const origAfter = state.uploadLog.filter((k) => k.startsWith("media-originals/")).length;
  if (thumbBefore < 3 || origAfter < 3) {
    throw new Error(`${label}: upload log unvollständig (${state.uploadLog.join(",")})`);
  }
  const firstThumb = state.uploadLog.findIndex((k) => k.startsWith("media-thumbs/"));
  const firstOrig = state.uploadLog.findIndex((k) => k.startsWith("media-originals/"));
  if (firstThumb >= firstOrig) {
    throw new Error(`${label}: Original vor Thumb hochgeladen`);
  }

  await page.click('[data-testid="photo-upload-sheet"] [data-action="close"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden, null, {
    timeout: 10_000,
  });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("vacrecap:data-changed")));
  await page.waitForSelector(".tile__img", { timeout: 20_000 });

  await page.click(".tile[data-media-id]");
  await page.waitForSelector('[data-testid="media-viewer"]');
  await page.waitForSelector('[data-testid="media-viewer-img"]');
  await page.click('[data-testid="media-viewer-close"]');

  state.setFailAllOriginalUploads(true);
  state.uploadLog.length = 0;
  const mediaBeforeRetry = state.media.length;
  await page.setInputFiles('[data-testid="gallery-input"]', [fixturePathB]);
  await page.waitForSelector('[data-testid="photo-upload-sheet"]');
  await page.waitForSelector('.photo-upload-item [data-action="retry"]', { timeout: 60_000 });
  if (state.media.length !== mediaBeforeRetry + 1) {
    throw new Error(`${label}: Retry legte extra media an (${mediaBeforeRetry} -> ${state.media.length})`);
  }
  const failedId = state.media[state.media.length - 1]?.id;
  state.setFailAllOriginalUploads(false);
  await page.click('.photo-upload-item [data-action="retry"]');
  await page.waitForFunction(
    () => document.querySelector(".photo-upload-item__status")?.textContent?.includes("✓"),
    null,
    { timeout: 60_000 }
  );
  if (state.media.filter((m) => m.id === failedId).length !== 1) {
    throw new Error(`${label}: media_id nach Retry nicht wiederverwendet`);
  }
  await page.click('[data-testid="photo-upload-sheet"] [data-action="close"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);

  const mediaBeforeMidOffline = state.media.length;
  state.setFailNextOriginalOffline(1);
  await page.setInputFiles('[data-testid="gallery-input"]', [fixturePathC]);
  await page.waitForSelector('[data-testid="photo-upload-sheet"]', { state: "visible" });
  await page.waitForFunction(
    () => document.querySelector(".photo-upload-item__status")?.textContent?.includes("Offline"),
    null,
    { timeout: 60_000 }
  );
  if (state.media.length !== mediaBeforeMidOffline + 1) {
    throw new Error(
      `${label}: Offline-Abbriff legte ${state.media.length - mediaBeforeMidOffline} Zeilen an (erwartet 1)`
    );
  }
  const midOfflineId = state.media[state.media.length - 1]?.id;
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
    window.dispatchEvent(new Event("online"));
  });
  await page.waitForFunction(
    () => document.querySelector(".photo-upload-item__status")?.textContent?.includes("✓"),
    null,
    { timeout: 60_000 }
  );
  if (state.media.length !== mediaBeforeMidOffline + 1) {
    throw new Error(
      `${label}: online-Retry legte Duplikat an (${mediaBeforeMidOffline} -> ${state.media.length})`
    );
  }
  if (state.media.filter((m) => m.id === midOfflineId).length !== 1) {
    throw new Error(`${label}: media_id nach Offline-Retry nicht wiederverwendet`);
  }
  const ghostFailed = state.media.filter(
    (m) => !m.deleted_at && m.upload_status === "failed" && m.id !== midOfflineId
  );
  if (ghostFailed.length > 0) {
    throw new Error(`${label}: failed-Geisterzeilen nach Offline-Retry (${ghostFailed.length})`);
  }
  await page.click('[data-testid="photo-upload-sheet"] [data-action="close"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("vacrecap:data-changed")));
  const midRow = state.media.find((m) => m.id === midOfflineId);
  if (midRow?.upload_status !== "uploaded") {
    throw new Error(`${label}: Offline-Retry-Zeile nicht uploaded`);
  }

  await page.evaluate(
    async ({ tripId, day, placeId }) => {
      Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
      const blob = await fetch("./tests/fixtures/test-photo.png").then((r) => r.blob());
      const file = new File([blob], "offline.png", { type: "image/png" });
      const { openPhotoUploadSheet } = await import("./js/ui-photo-upload-sheet.js");
      openPhotoUploadSheet({
        files: [file],
        place: { id: placeId, vacationId: tripId, day, name: "Foto-Ort" },
        vacationId: tripId,
        day,
      });
    },
    { tripId, day, placeId }
  );
  await page.waitForSelector('[data-testid="photo-upload-sheet"]');
  await page.waitForFunction(
    () => document.querySelector(".photo-upload-item__status")?.textContent?.includes("Offline"),
    null,
    { timeout: 30_000 }
  );
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
  });
  await page.click('[data-testid="photo-upload-sheet"] [data-action="close"]');
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden, null, {
    timeout: 10_000,
  });
  await page.evaluate(
    (id) => {
      location.hash = `#/urlaub/${id}`;
    },
    tripId
  );
  await page.waitForSelector('[data-testid="trip-content"]', { timeout: 15_000 });

  const overflow = await page.evaluate(() => {
    const wrap = document.querySelector(".place-list-wrap");
    return (wrap?.scrollWidth ?? 0) <= (wrap?.clientWidth ?? 9999) + 1;
  });
  if (!overflow) throw new Error(`${label}: horizontal overflow`);

  const heapBefore = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  for (let i = 0; i < 20; i++) {
    await page.setInputFiles('[data-testid="gallery-input"]', [fixturePath]);
    await page.waitForSelector('[data-testid="photo-upload-sheet"]');
    await page.waitForFunction(
      () => document.querySelector(".photo-upload-item__status")?.textContent?.includes("✓"),
      null,
      { timeout: 60_000 }
    );
    await page.click('[data-testid="photo-upload-sheet"] [data-action="close"]');
    await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden);
  }
  const heapAfter = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  const heapDelta = heapAfter - heapBefore;
  console.log(`${label}: heap delta after 20 sequential uploads: ${heapDelta} bytes (Chromium only)`);
}

async function main() {
  const fixtureDir = path.join(root, "tests/fixtures");
  await mkdir(fixtureDir, { recursive: true });
  const fixturePath = path.join(fixtureDir, "test-photo.png");
  const fixturePathB = path.join(fixtureDir, "test-photo-b.png");
  const fixturePathC = path.join(fixtureDir, "test-photo-c.png");
  await writeFile(fixturePath, TINY_PNG);
  await writeFile(fixturePathB, Buffer.concat([TINY_PNG, Buffer.from([1])]));
  await writeFile(fixturePathC, Buffer.concat([TINY_PNG, Buffer.from([2, 3])]));

  const { server, baseUrl } = await startServer();

  for (const browser of [
    { name: "chromium", launcher: chromium },
    { name: "webkit", launcher: webkit },
  ]) {
    for (const vp of VIEWPORTS) {
      const state = createMockSupabaseState(baseUrl);
      const userData = path.join("/tmp", `vacrecap-7a-${browser.name}-${vp.name}-${Date.now()}`);
      const ctx = await browser.launcher.launchPersistentContext(userData, {
        baseURL: baseUrl,
        ...devices["iPhone 8"],
        geolocation: { latitude: 48.8566, longitude: 2.3522 },
        permissions: ["geolocation"],
      });
      const page = await ctx.newPage();
      page.setDefaultTimeout(30_000);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await installSupabaseMocks(page, state, baseUrl);
      await runPhotoSuite(page, baseUrl, state, [fixturePath, fixturePathB, fixturePathC], `7a-${browser.name}-${vp.name}`);
      await ctx.close();
    }
  }

  server.close();
  console.log("Playwright 7a tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
