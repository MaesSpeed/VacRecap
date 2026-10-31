import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";

const VIEWPORTS = [
  { name: "375x667", width: 375, height: 667 },
  { name: "360x740", width: 360, height: 740 },
  { name: "390x844", width: 390, height: 844 },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      if (rel.endsWith("/")) rel += "index.html";
      try {
        let filePath = path.join(root, rel.replace(/^\//, ""));
        const cinexRel = rel.replace(/^\//, "");
        if (cinexRel.startsWith("Cinex/")) {
          filePath = path.join(root, "tests/fixtures/cinex", cinexRel.slice("Cinex/".length));
        }
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
    user: { id: userId, email: "test@example.com" },
  };
  const trips = [];
  const waypoints = [];
  const notes = [];
  const media = [];
  let otp = "123456";
  return {
    userId,
    session,
    trips,
    waypoints,
    notes,
    media,
    setOtp(code) {
      otp = code;
    },
    handleAuth(url, method, body) {
      const path = url.pathname;
      if (path.endsWith("/otp") && method === "POST") {
        return { status: 200, json: {} };
      }
      if (path.endsWith("/verify") && method === "POST") {
        const b = JSON.parse(body || "{}");
        if (b.token !== otp) {
          return {
            status: 400,
            json: { error: "invalid_otp", error_description: "Invalid OTP", message: "Invalid" },
          };
        }
        return { status: 200, json: { access_token: session.access_token, refresh_token: session.refresh_token, user: session.user } };
      }
      if (path.endsWith("/token") && method === "POST") {
        return { status: 200, json: session };
      }
      if (path.endsWith("/user") && method === "GET") {
        return { status: 200, json: session.user };
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
        const raw = url.searchParams.get(key);
        return raw?.replace(/^eq\./, "");
      };
      const upsertRow = (list, row, extra) => {
        const id = row.id || crypto.randomUUID();
        const hit = list.find((x) => x.id === id);
        const full = {
          created_by: userId,
          created_at: hit?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
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
        if (method === "PATCH") {
          const id = qp("id");
          const row = JSON.parse(body);
          const t = trips.find((x) => x.id === id);
          if (!t) {
            return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
          }
          Object.assign(t, row, { updated_at: new Date().toISOString() });
          return { status: 200, json: [t] };
        }
        if (method === "DELETE") {
          const id = qp("id");
          const i = trips.findIndex((x) => x.id === id);
          if (i >= 0) trips.splice(i, 1);
          return { status: 204, json: null };
        }
      }
      if (table === "waypoints") {
        if (method === "GET") {
          const id = qp("id");
          if (id) {
            const w = waypoints.find((x) => x.id === id);
            return { status: 200, json: w ? [w] : [] };
          }
          const tripId = qp("trip_id");
          const rows = waypoints.filter((w) => w.trip_id === tripId && !w.deleted_at);
          return { status: 200, json: rows };
        }
        if (method === "POST") {
          const row = JSON.parse(body);
          const full = upsertRow(waypoints, row, { deleted_at: null });
          return { status: 201, json: [full] };
        }
        if (method === "PATCH") {
          const id = qp("id");
          const row = JSON.parse(body);
          const w = waypoints.find((x) => x.id === id);
          if (!w) {
            return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
          }
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
          const id = row.id || crypto.randomUUID();
          const hit = notes.find((x) => x.id === id);
          const created_at =
            hit?.created_at || new Date(Date.now() + notes.length * 500).toISOString();
          const full = {
            id,
            created_by: userId,
            created_at,
            updated_at: new Date().toISOString(),
            deleted_at: null,
            ...row,
            id,
            created_at,
          };
          if (hit) Object.assign(hit, full);
          else notes.push(full);
          return { status: 201, json: [full] };
        }
        if (method === "PATCH") {
          const id = qp("id");
          const row = JSON.parse(body);
          const n = notes.find((x) => x.id === id);
          if (!n) {
            return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
          }
          Object.assign(n, row, { updated_at: new Date().toISOString() });
          return { status: 200, json: [n] };
        }
        if (method === "GET") {
          const id = qp("id");
          if (id) {
            const n = notes.find((x) => x.id === id);
            return { status: 200, json: n ? [n] : [] };
          }
        }
      }
      if (table === "media") {
        if (method === "GET") {
          const wp = qp("waypoint_id");
          const rows = media.filter((m) => m.waypoint_id === wp && !m.deleted_at);
          return { status: 200, json: rows };
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

async function installSupabaseMocks(page, state) {
  await page.route(`**/${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const body = req.postData();
    const headers = req.headers();
    let result;
    if (url.pathname.includes("/auth/v1/")) {
      result = state.handleAuth(url, method, body);
    } else if (url.pathname.includes("/rest/v1/")) {
      result = state.handleRest(url, method, body, headers);
    } else {
      result = { status: 404, json: {} };
    }
    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      body: result.json ? JSON.stringify(result.json) : "",
    });
  });
}

async function assertLoginScreenInitial(page, label) {
  await page.waitForSelector('[data-testid="login-screen"]');
  const ui = await page.evaluate(() => {
    const emailForm = document.querySelector('form[data-step="email"]');
    const otpForm = document.querySelector('form[data-step="otp"]');
    const email = document.querySelector('input[name="email"]');
    const field = email?.closest(".field");
    return {
      otpHidden: Boolean(otpForm?.hidden),
      otpDisplay: otpForm ? getComputedStyle(otpForm).display : "",
      emailFormDisplay: emailForm ? getComputedStyle(emailForm).display : "",
      emailWidth: email?.offsetWidth ?? 0,
      fieldWidth: field?.clientWidth ?? 0,
    };
  });
  if (!ui.otpHidden || ui.otpDisplay !== "none") {
    throw new Error(`${label}: OTP-Schritt vor Code senden sichtbar`);
  }
  if (ui.emailFormDisplay === "none") {
    throw new Error(`${label}: E-Mail-Schritt nicht sichtbar`);
  }
  if (ui.emailWidth < ui.fieldWidth - 2) {
    throw new Error(`${label}: E-Mail-Feld zu schmal (${ui.emailWidth}/${ui.fieldWidth})`);
  }
}

async function login(page, email = "test@example.com") {
  await page.waitForSelector('[data-testid="login-screen"]');
  await page.fill('input[name="email"]', email);
  await page.click('form[data-step="email"] button[type="submit"]');
  await page.waitForSelector('form[data-step="otp"]');
  await page.fill('input[name="otp"]', "123456");
  await page.click('form[data-step="otp"] button[type="submit"]');
  await page.waitForSelector(".screen--urlaube", { timeout: 15_000 });
}

async function runFlow(page, baseUrl, label) {
  await page.goto(baseUrl);
  await login(page);
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', "Cloud-Reise");
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
      try {
        const { putPlace } = await import("./js/db.js");
        const { createPlace } = await import("./js/places.js");
        const place = await putPlace(
          createPlace({
            vacationId: tripId,
            day,
            ts: Date.now(),
            lat: 48.8566,
            lng: 2.3522,
            name: "Testort",
            soft: false,
            source: "test",
          })
        );
        window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
        return { ok: true, id: place.id };
      } catch (e) {
        return { ok: false, err: String(e?.message || e) };
      }
    },
    { tripId, day }
  );
  if (!wp?.ok) throw new Error(`${label}: Wegpunkt (${wp?.err})`);
  await page.waitForSelector(".place-list .oc", { timeout: 20_000 });
  await page.click('[data-footer-action="note"]');
  await page.waitForSelector('[data-testid="note-sheet"]', { timeout: 20_000 });
  await page.fill('[data-testid="note-sheet"] textarea', "Hallo Cloud UI");
  await page.locator('[data-testid="note-sheet"] [data-action="save"]').click();
  await page.waitForFunction(
    () => document.getElementById("overlay-root")?.hidden,
    null,
    { timeout: 15_000 }
  );
  const noteRes = await page.evaluate(
    async ({ tripId, day, placeId }) => {
      try {
        const { putNote } = await import("./js/db.js");
        const { createId } = await import("./js/utils.js");
        await putNote({
          id: createId(),
          vacationId: tripId,
          placeId,
          day,
          text: "Hallo Cloud",
          ts: Date.now(),
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, err: String(e?.message || e) };
      }
    },
    { tripId, day, placeId: wp.id }
  );
  if (!noteRes?.ok) throw new Error(`${label}: Notiz PUT (${noteRes?.err})`);
  const noteCount = await page.evaluate(async (placeId) => {
    const { getNotesForPlace } = await import("./js/db.js");
    return (await getNotesForPlace(placeId)).filter((n) => n.text.includes("Hallo Cloud")).length;
  }, wp.id);
  if (noteCount < 1) throw new Error(`${label}: Notiz nicht in Cloud`);
}

async function assertPlaceListUi(page, label) {
  await page.waitForSelector('[data-testid="place-list"]', { timeout: 15_000 });
  await page.waitForSelector(".place-list-fade", { timeout: 15_000 });
  await page.waitForSelector(".qa__btn", { timeout: 15_000 });
  const layout = await page.evaluate(() => {
    const wrap = document.querySelector(".place-list-wrap");
    return {
      overflow: (wrap?.scrollWidth ?? 0) <= (wrap?.clientWidth ?? 9999) + 1,
      hasQa: !!document.querySelector(".qa__btn"),
    };
  });
  if (!layout.overflow) throw new Error(`${label}: horizontal overflow`);
  if (!layout.hasQa) throw new Error(`${label}: qa__btn fehlt`);

  const meta = await page.evaluate(() => ({
    tripId: document.querySelector(".screen--trip")?.dataset.vacationId,
    placeId:
      document.querySelector(".oc--selected")?.dataset.placeId ||
      document.querySelector(".oc")?.dataset.placeId,
    day: document.querySelector("[data-testid=trip-content]")?.dataset.activeDay || "2026-11-06",
  }));

  await page.click('[data-action="add-note"]');
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.fill('[data-testid="note-sheet"] textarea', "6e Add Link");
  await page.locator('[data-testid="note-sheet"] [data-action="save"]').click();
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden, null, {
    timeout: 15_000,
  });

  await page.evaluate(async (m) => {
    const { getNotesForPlace, deleteNote } = await import("./js/db.js");
    const notes = await getNotesForPlace(m.placeId);
    for (const n of notes) {
      await deleteNote(n.id);
    }
    window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
  }, meta);
  await page.waitForFunction(() => document.querySelectorAll(".nr__text--btn").length === 0, null, {
    timeout: 15_000,
  });

  await page.evaluate(async (m) => {
    const { putNote } = await import("./js/db.js");
    const { createId } = await import("./js/utils.js");
    await putNote({
      id: createId(),
      vacationId: m.tripId,
      placeId: m.placeId,
      day: m.day,
      text: "Sort-Alt",
      ts: 1,
    });
    await new Promise((r) => setTimeout(r, 60));
    await putNote({
      id: createId(),
      vacationId: m.tripId,
      placeId: m.placeId,
      day: m.day,
      text: "Sort-Neu",
      ts: 2,
    });
    window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
  }, meta);

  await page.waitForFunction(
    () => document.querySelector(".nr__text--btn")?.textContent?.trim() === "Sort-Neu",
    null,
    { timeout: 15_000 }
  );

  await page.locator(".nr__text--btn", { hasText: "Sort-Neu" }).click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.fill('[data-testid="note-sheet"] textarea', "Sort-Neu-Edit");
  await page.locator('[data-testid="note-sheet"] [data-action="save"]').click();
  await page.waitForFunction(() => document.getElementById("overlay-root")?.hidden, null, {
    timeout: 15_000,
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll(".nr__text--btn")].some((b) => b.textContent.trim() === "Sort-Neu-Edit"),
    null,
    { timeout: 15_000 }
  );
  const firstAfterEdit = await page.locator(".nr__text--btn").allTextContents();
  const editedIdx = firstAfterEdit.findIndex((t) => t.trim() === "Sort-Neu-Edit");
  const altIdx = firstAfterEdit.findIndex((t) => t.trim() === "Sort-Alt");
  if (editedIdx < 0) throw new Error(`${label}: Bearbeiten nicht gespeichert`);
  if (altIdx >= 0 && editedIdx > altIdx) {
    throw new Error(`${label}: Reihenfolge nach Bearbeiten`);
  }

  await page.evaluate(async (m) => {
    const { putNote } = await import("./js/db.js");
    const { createId } = await import("./js/utils.js");
    for (let i = 0; i < 3; i++) {
      await putNote({
        id: createId(),
        vacationId: m.tripId,
        placeId: m.placeId,
        day: m.day,
        text: `Extra-${i}`,
        ts: 10 + i,
      });
      await new Promise((r) => setTimeout(r, 30));
    }
    window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
  }, meta);

  await page.waitForSelector('[data-action="expand-notes"]');
  await page.click('[data-action="expand-notes"]');
  await page.waitForSelector('[data-action="collapse-notes"]');
  await page.click('[data-action="collapse-notes"]');
  await page.waitForSelector('[data-action="expand-notes"]');
}

async function assertLegacyCleanup(page, baseUrl) {
  await page.goto(baseUrl);
  const result = await page.evaluate(async () => {
    await new Promise((r) => {
      const req = indexedDB.open("vacrecap", 6);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("media")) db.createObjectStore("media", { keyPath: "id" });
      };
      req.onsuccess = () => {
        req.result.close();
        r();
      };
      req.onerror = () => r();
    });
    if ("serviceWorker" in navigator) {
      await navigator.serviceWorker.register("./sw.js");
    }
    await caches.open("vacrecap-v38").then((c) => c.put("/x", new Response("1")));
    return true;
  });
  if (!result) throw new Error("legacy seed failed");
  await page.reload();
  await page.waitForSelector('[data-testid="login-screen"]', { timeout: 15_000 });
  const clean = await page.evaluate(async () => {
    const keys = await caches.keys();
    const sw = await navigator.serviceWorker.getRegistrations();
    return {
      caches: keys.filter((k) => k.startsWith("vacrecap-")),
      sw: sw.length,
    };
  });
  if (clean.caches.length) throw new Error(`Caches übrig: ${clean.caches.join(",")}`);
  if (clean.sw > 0) throw new Error("VacRecap-SW nicht deregistriert");
}

async function assertN1KillSwitch(browserType, baseUrl, label) {
  const v38Body = await readFile(path.join(root, "tests/fixtures/sw-v38-main.js"), "utf8");
  const cinexBody = await readFile(path.join(root, "tests/fixtures/cinex/sw.js"), "utf8");
  const userData = path.join("/tmp", `vacrecap-n1-${label}-${Date.now()}`);
  const ctx = await browserType.launchPersistentContext(userData, {
    baseURL: baseUrl,
    ...devices["iPhone 8"],
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45_000);

  await page.route("**/Cinex/sw.js", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/javascript", body: cinexBody });
  });
  await page.route("**/sw.js", async (route) => {
    const url = route.request().url();
    if (url.includes("/Cinex/")) return route.continue();
    await route.fulfill({ status: 200, contentType: "application/javascript", body: v38Body });
  });

  await page.goto(baseUrl);
  await page.evaluate(async () => {
    await caches.open("vacrecap-v38");
    await navigator.serviceWorker.register("./sw.js");
    await navigator.serviceWorker.register("/Cinex/sw.js", { scope: "/Cinex/" });
  });
  await page.waitForTimeout(800);
  await page.unroute("**/sw.js");
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
  });
  await page.waitForSelector('[data-testid="login-screen"]', { timeout: 30_000 });

  const afterSwitch = await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    return {
      vacrecapSw: regs.filter((r) => !r.scope.includes("/Cinex/")).length,
      cinexSw: regs.filter((r) => r.scope.includes("/Cinex/")).length,
      caches: (await caches.keys()).filter((k) => k.startsWith("vacrecap-")),
    };
  });

  async function waitVacrecapCachesClear(maxMs = 20_000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const keys = await page.evaluate(async () =>
        (await caches.keys()).filter((k) => k.startsWith("vacrecap-"))
      );
      if (!keys.length) return;
      await page.waitForTimeout(400);
    }
    const left = await page.evaluate(async () =>
      (await caches.keys()).filter((k) => k.startsWith("vacrecap-"))
    );
    throw new Error(`N1-${label}: vacrecap-Caches übrig (${left.join(",")})`);
  }

  if (afterSwitch.vacrecapSw > 0) throw new Error(`N1-${label}: VacRecap-SW noch aktiv`);
  await waitVacrecapCachesClear();
  if (afterSwitch.cinexSw < 1) throw new Error(`N1-${label}: Cinex-SW fehlt`);

  for (let i = 0; i < 3; i++) {
    await page.reload();
    await page.waitForSelector('[data-testid="login-screen"]', { timeout: 15_000 });
  }
  await page.waitForTimeout(2000);

  const afterPause = await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.filter((r) => !r.scope.includes("/Cinex/")).length;
  });
  if (afterPause > 0) throw new Error(`N1-${label}: VacRecap-SW nach Pause/Reloads zurück`);

  await ctx.close();
}

async function main() {
  const { server, baseUrl } = await startServer();
  const state = createMockSupabaseState();
  const chromiumUserData = path.join("/tmp", `vacrecap-6b-cr-${Date.now()}`);
  const ctx = await chromium.launchPersistentContext(chromiumUserData, {
    baseURL: baseUrl,
    ...devices["iPhone 8"],
    geolocation: { latitude: 48.8566, longitude: 2.3522 },
    permissions: ["geolocation"],
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  await installSupabaseMocks(page, state);

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(baseUrl);
    await assertLoginScreenInitial(page, `6d-login-chromium-${vp.name}`);
  }

  await runFlow(page, baseUrl, "6a-flow");
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const v = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
    if (Number(v) !== 58) throw new Error(`Version ${v} in ${vp.name}`);
  }

  for (const vp of [
    { name: "375x667", width: 375, height: 667 },
    { name: "390x844", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await assertPlaceListUi(page, `6e-place-chromium-${vp.name}`);
  }

  const offlineOk = await page.evaluate(async () => {
    const { setOfflineReadOnly } = await import("./js/local-cache.js");
    setOfflineReadOnly(true);
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
    const { putVacation } = await import("./js/db.js");
    try {
      await putVacation({
        title: "Offline",
        startDate: "2026-12-01",
        endDate: "2026-12-02",
        companions: { names: [], tags: [] },
      });
      return { banner: !!document.getElementById("vr-offline-banner"), blocked: false };
    } catch (e) {
      return {
        banner: !!document.getElementById("vr-offline-banner"),
        blocked: e?.name === "CloudOfflineError" || /offline|Internet/i.test(String(e.message)),
      };
    }
  });
  if (!offlineOk.blocked) throw new Error("6a-offline: Schreiben nicht blockiert");
  await page.evaluate(async () => {
    const { setOfflineReadOnly } = await import("./js/local-cache.js");
    setOfflineReadOnly(false);
    window.dispatchEvent(new Event("online"));
  });

  const authMsg = await page.evaluate(async () => {
    const { mapAuthError } = await import("./js/cloud-errors.js");
    return mapAuthError({ code: "invalid_otp", message: "invalid" });
  });
  if (!authMsg.includes("falsch oder abgelaufen")) throw new Error("6b-B8: Fehlermeldung fehlt");

  const rateMsg = await page.evaluate(async () => {
    const { mapAuthError } = await import("./js/cloud-errors.js");
    return mapAuthError({
      code: "over_request_rate_limit",
      message: "you can only request this after 42 seconds",
    });
  });
  if (!rateMsg.includes("Zu viele Anfragen")) throw new Error("6b-B12: Rate-Limit-Text fehlt");

  const n8Ok = await page.evaluate(async () => {
    const { isFetchNetworkFailure } = await import("./js/cloud-errors.js");
    return isFetchNetworkFailure({ message: "access control checks" });
  });
  if (!n8Ok) throw new Error("6d-N8: access control checks nicht als Netzfehler");

  await page.evaluate(async () => {
    const { setOfflineReadOnly } = await import("./js/local-cache.js");
    setOfflineReadOnly(false);
    location.hash = "#/urlaube";
  });
  await page.waitForSelector(".screen--urlaube", { timeout: 15_000 });
  await page.evaluate(async () => {
    const { openGlobalSettingsSheet } = await import("./js/ui-global-settings.js");
    openGlobalSettingsSheet(document.getElementById("app"));
  });
  await page.waitForSelector('[data-testid="global-settings-sheet"]');
  await page.click('[data-action="close"]');
  await page.waitForTimeout(600);
  await page.evaluate(async () => {
    const { openGlobalSettingsSheet } = await import("./js/ui-global-settings.js");
    openGlobalSettingsSheet(document.getElementById("app"));
  });
  await page.waitForSelector('[data-testid="global-settings-sheet"]');
  await page.waitForTimeout(600);
  await page.click('[data-action="sign-out"]');
  await page.waitForSelector('[data-testid="login-screen"]', { timeout: 20_000 });
  const afterSignOut = await page.evaluate(() => ({
    caches: Object.keys(localStorage).filter((k) => k.startsWith("vr-cloud-read-cache")),
    tripSel: localStorage.getItem("vr-setting:tripSelectionByVacation"),
    auth: Object.keys(localStorage).some((k) => k.includes("auth-token")),
  }));
  if (afterSignOut.caches.length) throw new Error("6c-signout: Cache nicht gelöscht");
  if (afterSignOut.tripSel) throw new Error("6c-signout: tripSelection nicht gelöscht");
  if (afterSignOut.auth) throw new Error("6c-signout: Auth-Token noch da");

  const heapBefore = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  await assertN1KillSwitch(chromium, baseUrl, "chromium");
  await assertN1KillSwitch(webkit, baseUrl, "webkit");
  await assertLegacyCleanup(page, baseUrl);
  const heapAfter = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  if (heapBefore && heapAfter && heapAfter - heapBefore > 8_000_000) {
    throw new Error(`6a-heap: +${heapAfter - heapBefore} bytes`);
  }

  const webkitUserData = path.join("/tmp", `vacrecap-6a-wk-${Date.now()}`);
  const wk = await webkit.launchPersistentContext(webkitUserData, {
    baseURL: baseUrl,
    ...devices["iPhone 8"],
  });
  const wPage = await wk.newPage();
  await installSupabaseMocks(wPage, createMockSupabaseState());
  for (const vp of VIEWPORTS) {
    await wPage.setViewportSize({ width: vp.width, height: vp.height });
    await wPage.goto(baseUrl);
    await assertLoginScreenInitial(wPage, `6d-login-webkit-${vp.name}`);
  }
  await runFlow(wPage, baseUrl, "6b-webkit");
  for (const vp of [
    { name: "375x667", width: 375, height: 667 },
    { name: "390x844", width: 390, height: 844 },
  ]) {
    await wPage.setViewportSize({ width: vp.width, height: vp.height });
    await assertPlaceListUi(wPage, `6e-place-webkit-${vp.name}`);
  }
  await wk.close();

  await ctx.close();
  server.close();
  console.log("Playwright 6e tests OK (Build 58)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
