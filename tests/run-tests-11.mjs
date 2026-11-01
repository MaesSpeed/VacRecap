import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const TODAY = "2026-10-30";
const OTHER = "2026-10-29";
const USER = "11111111-1111-1111-1111-111111111111";
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const TINY_PATH = "/tmp/vacrecap-tiny-cover.png";

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
};

const VIEWPORTS = [
  { width: 375, height: 667 },
  { width: 360, height: 740 },
  { width: 390, height: 844 },
];

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
    lat: 45.6,
    lng: 10.7,
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

function photoRow(id, tripId, placeId, day, iso, extra = {}) {
  return {
    id,
    trip_id: tripId,
    waypoint_id: placeId,
    day,
    taken_at: iso,
    kind: "photo",
    storage_path: `${tripId}/${id}.jpg`,
    thumb_path: `${tripId}/${id}.jpg`,
    mime: "image/jpeg",
    upload_status: "uploaded",
    deleted_at: null,
    created_at: iso,
    updated_at: iso,
    created_by: USER,
    width: 800,
    height: 1200,
    ...extra,
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
  let role = "owner";
  let uploads = 0;
  const calls = [];
  let mediaByIdFault = null;
  let failCoverImageGets = 0;

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
        const set = new Set(
          value
            .slice(4, -1)
            .split(",")
            .map((part) => part.trim().replace(/^"|"$/g, ""))
        );
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
    waypoints,
    media,
    get role() {
      return role;
    },
    set role(value) {
      role = value;
    },
    get uploads() {
      return uploads;
    },
    calls,
    get mediaByIdFault() {
      return mediaByIdFault;
    },
    set mediaByIdFault(value) {
      mediaByIdFault = value;
    },
    get failCoverImageGets() {
      return failCoverImageGets;
    },
    set failCoverImageGets(value) {
      failCoverImageGets = value;
    },
    trip(id) {
      return trips.find((row) => row.id === id);
    },
    handleAuth(url, method) {
      const pathName = url.pathname;
      if (pathName.endsWith("/otp") && method === "POST") return { status: 200, json: {} };
      if (pathName.endsWith("/verify") && method === "POST") return { status: 200, json: session };
      if (pathName.endsWith("/token") && method === "POST") return { status: 200, json: session };
      if (pathName.endsWith("/user") && method === "GET") return { status: 200, json: session.user };
      return { status: 404, json: {} };
    },
    handleStorage(url, method, body) {
      const pathName = url.pathname;
      if (pathName.includes("/object/sign/") && method === "POST") {
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
        const token = encodeURIComponent(pathName.split("/object/sign/")[1] || "1");
        return { status: 200, json: { signedURL: `/object/sign/mock?token=${token}` } };
      }
      if (pathName.includes("/object/sign/mock") && method === "GET") {
        if (this.failCoverImageGets > 0) {
          this.failCoverImageGets -= 1;
          return { status: 500, json: { message: "bild" } };
        }
        return { status: 200, raw: TINY_PNG, contentType: "image/png" };
      }
      if (pathName.includes("/object/") && (method === "POST" || method === "PUT")) {
        uploads += 1;
        return { status: 200, json: { Key: pathName, Id: "obj" } };
      }
      return { status: 404, json: {} };
    },
    handleRest(url, method, body, headers) {
      const table = url.pathname.split("/").filter(Boolean).pop();
      calls.push(`${method} ${table} ${url.search}`);
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
        if (method === "POST" || method === "PATCH") return { status: 201, json: represent(upsert(trips, JSON.parse(body || "{}")), headers) };
        if (method === "GET") return sendRows(applyFilters(trips, url), headers);
      }
      if (table === "waypoints") {
        if (method === "POST") return { status: 201, json: represent(upsert(waypoints, JSON.parse(body || "{}")), headers) };
        if (method === "GET") return sendRows(applyFilters(waypoints, url), headers);
      }
      if (table === "notes" && method === "GET") return sendRows(applyFilters(notes, url), headers);
      if (table === "media" && method === "GET") return sendRows(applyFilters(media, url), headers);
      if (table === "media" && method === "POST") return { status: 201, json: represent(upsert(media, JSON.parse(body || "{}")), headers) };
      if (table === "media" && method === "PATCH") {
        const rows = applyFilters(media, url);
        const patch = JSON.parse(body || "{}");
        if (!rows[0]) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
        Object.assign(rows[0], patch, { updated_at: new Date().toISOString() });
        return { status: 200, json: represent(rows[0], headers) };
      }
      if (table === "trip_members" && method === "GET") {
        const tripId = [...url.searchParams.values()].find((value) => value.startsWith("eq."))?.slice(3) || "";
        return sendRows([{ role, trip_id: tripId, user_id: USER }], headers);
      }
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
    if (
      req.method() === "GET" &&
      url.pathname.includes("/rest/v1/media") &&
      url.search.includes("id=in.") &&
      state.mediaByIdFault
    ) {
      if (state.mediaByIdFault === "network") {
        await route.abort("failed");
        return;
      }
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        headers: corsHeaders(req),
        body: JSON.stringify({ message: "media" }),
      });
      return;
    }
    let result;
    const body = req.method() === "GET" || req.method() === "HEAD" ? null : req.postData();
    if (url.pathname.includes("/auth/v1/")) result = state.handleAuth(url, req.method());
    else if (url.pathname.includes("/storage/v1/")) result = state.handleStorage(url, req.method(), body);
    else if (url.pathname.includes("/rest/v1/")) result = state.handleRest(url, req.method(), body, req.headers());
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
  });
}

function seedTrip(state, tripId) {
  state.waypoints.push(
    placeRow("p-hafen", tripId, TODAY, "Hafen Malcesine", "2026-10-30T12:00:00.000Z"),
    placeRow("p-ufer", tripId, TODAY, "Uferpromenade", "2026-10-30T09:00:00.000Z"),
    placeRow("p-burg", tripId, OTHER, "Burg Limone", "2026-10-29T15:00:00.000Z")
  );
  state.media.push(
    photoRow("m-see", tripId, "p-hafen", TODAY, "2026-10-30T10:00:00"),
    photoRow("m-own-2", tripId, "p-hafen", TODAY, "2026-10-30T11:00:00"),
    photoRow("m-burg", tripId, "p-burg", OTHER, "2026-10-29T15:10:00"),
    photoRow("m-weg", tripId, "p-hafen", TODAY, "2026-10-30T08:00:00", { deleted_at: "2026-10-30T18:00:00.000Z" }),
    photoRow("m-fremd", "andere-reise", "p-anders", TODAY, "2026-10-30T08:00:00")
  );
}

async function loginAndCreate(page) {
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
  await page.click('.calendar-day[data-date="2026-10-28"]');
  await page.click('.calendar-day[data-date="2026-10-30"]');
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector(".screen--trip");
  return page.locator(".screen--trip").getAttribute("data-vacation-id");
}

async function openEdit(page, tripId) {
  await page.evaluate((id) => {
    window.location.hash = `#/urlaub/${id}/bearbeiten`;
  }, tripId);
  await page.waitForSelector('[data-testid="cover-badge"]');
}

async function openSheet(page) {
  await page.click('[data-testid="cover-change"]');
  await page.waitForSelector('[data-testid="cover-sheet"]');
}

async function saveForm(page) {
  await page.click('button[type="submit"]');
  await page.waitForSelector(".screen--trip");
}

async function meta(page, placeId) {
  return page.locator(`[data-place-id="${placeId}"] .oc__meta`).innerText();
}

async function enterSelect(page) {
  await page.click('[data-testid="photo-select-start"]');
  await page.waitForSelector('[data-testid="photo-select-bar"]');
}

async function runFlows(page, state, label) {
  const tripId = await loginAndCreate(page);
  seedTrip(state, tripId);
  await openEdit(page, tripId);
  assert(await page.locator('[data-testid="cover-change"]').count(), `${label}: Button Titelbild ändern fehlt`);
  assert((await page.locator('[data-testid="cover-badge"]').innerText()).includes("Automatisch"), `${label}: Start ist kein Motiv`);

  await openSheet(page);
  assert(await page.locator('[data-cover-photo="m-see"]').count(), `${label}: Reisefoto fehlt im Raster`);
  assert(!(await page.locator('[data-cover-photo="m-fremd"]').count()), `${label}: fremdes Foto wird angeboten`);
  assert(!(await page.locator('[data-cover-photo="m-weg"]').count()), `${label}: gelöschtes Foto wird angeboten`);
  await page.click('[data-cover-photo="m-see"]');
  const draft = await page.locator('[data-testid="cover-sheet"]').getAttribute("data-draft-type");
  const draftId = await page.locator('[data-testid="cover-sheet"]').getAttribute("data-draft-media");
  assert(draft === "media" && draftId === "m-see", `${label}: Auswahl ${draft} ${draftId}`);
  await page.click('[data-testid="cover-sheet-done"]');
  await page.waitForSelector('[data-testid="cover-sheet"]', { state: "detached" });
  await page.waitForFunction(() => (document.querySelector('[data-testid="cover-badge"]')?.textContent || "").includes("Foto"));
  const picked = await page.locator('[data-testid="cover-badge"]').innerText();
  assert(picked.includes("Foto"), `${label}: Vorschau «${picked}» ${state.calls.filter((line) => line.includes("media")).slice(-8).join(" || ")}`);
  assert(picked.includes("Hafen"), `${label}: Ort fehlt «${picked}»`);
  assert(await page.locator('[data-testid="cover-save-hint"]').isVisible(), `${label}: Hinweis zum Speichern fehlt`);
  assert(await page.locator('[data-testid="cover-reset"]').isVisible(), `${label}: Zurücksetzen fehlt`);
  await saveForm(page);
  assert(state.trip(tripId).cover_media_id === "m-see", `${label}: cover_media_id ${state.trip(tripId).cover_media_id}`);

  await openEdit(page, tripId);
  await page.locator('[data-testid="cover-change"]').evaluate((btn) => {
    btn.click();
    btn.click();
  });
  await page.waitForSelector('[data-testid="cover-sheet"]');
  assert((await page.locator('[data-testid="cover-sheet"]').count()) === 1, `${label}: zwei Tipps öffnen zwei Sheets`);
  await page.click('[data-testid="cover-sheet-cancel"]');
  await page.waitForSelector('[data-testid="cover-sheet"]', { state: "detached" });

  state.failCoverImageGets = 2;
  await page.reload();
  await openEdit(page, tripId);
  await page.waitForFunction(() => (document.querySelector('[data-testid="cover-preview-img"]')?.getAttribute("src") || "").includes("stadt"));
  state.failCoverImageGets = 0;
  const brokenSrc = await page.locator('[data-testid="cover-preview-img"]').getAttribute("src");
  assert(brokenSrc && !brokenSrc.includes("sign"), `${label}: Ladefehler bleibt leer «${brokenSrc}»`);

  async function keepCoverDespite(fault, title) {
    await page.evaluate((id) => {
      window.location.hash = `#/urlaub/${id}`;
    }, tripId);
    await page.waitForSelector(".screen--trip");
    if (fault === "offline") await page.evaluate(() => { window.__online = false; });
    else state.mediaByIdFault = fault;
    await openEdit(page, tripId);
    const badge = await page.locator('[data-testid="cover-badge"]').innerText();
    assert(!badge.includes("Automatisch"), `${label}: ${fault} zeigt Automatisch «${badge}»`);
    assert(badge.includes("Titelbild nicht geladen"), `${label}: ${fault} ohne Hinweis «${badge}»`);
    assert((await page.locator('[data-testid="cover-retry"]').innerText()).includes("Erneut versuchen"), `${label}: ${fault} ohne Erneut versuchen`);
    if (fault === "offline") await page.evaluate(() => { window.__online = true; });
    else state.mediaByIdFault = null;
    await page.fill('input[name="title"]', title);
    await saveForm(page);
    assert(state.trip(tripId).cover_media_id === "m-see", `${label}: ${fault} löscht cover_media_id`);
    assert(state.trip(tripId).title === title, `${label}: ${fault} speichert den Titel nicht`);
  }
  await keepCoverDespite("500", "Gardasee 500");
  await keepCoverDespite("network", "Gardasee Netz");
  await keepCoverDespite("offline", "Gardasee Offline");

  await openEdit(page, tripId);
  assert((await page.locator('[data-testid="cover-badge"]').innerText()).includes("Foto"), `${label}: Foto nach Neuladen weg`);
  await page.evaluate(() => {
    window.location.hash = "#/urlaube";
  });
  await page.waitForSelector(`[data-vacation-id="${tripId}"] [data-cover-img]`);
  const listSrc = await page.locator(`[data-vacation-id="${tripId}"] [data-cover-img]`).getAttribute("src");
  assert(listSrc && listSrc.includes("sign"), `${label}: Liste ohne signierte URL «${listSrc}»`);
  assert(!listSrc.includes("stadt.jpg"), `${label}: Liste zeigt das Motiv statt des Fotos`);

  await openEdit(page, tripId);
  await page.click('[data-testid="cover-reset"]');
  const resetBadge = await page.locator('[data-testid="cover-badge"]').innerText();
  assert(resetBadge.includes("Automatisch"), `${label}: Zurücksetzen «${resetBadge}»`);
  assert(await page.locator('[data-testid="cover-save-hint"]').isHidden(), `${label}: Hinweis bleibt nach Zurücksetzen`);
  await saveForm(page);
  assert(state.trip(tripId).cover_media_id == null, `${label}: Zurücksetzen schreibt die Spalte nicht leer`);

  await openEdit(page, tripId);
  await openSheet(page);
  await page.waitForSelector('[data-preset="berge"]');
  await page.click('[data-preset="berge"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="cover-current-label"]')?.textContent || "").includes("Berge"));
  await page.click('[data-testid="cover-sheet-done"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="cover-badge"]')?.textContent || "").includes("Berge"));
  const motif = await page.locator('[data-testid="cover-badge"]').innerText();
  assert(motif.includes("Motiv Berge"), `${label}: Motiv «${motif}»`);
  await saveForm(page);
  assert(state.trip(tripId).cover_preset === "berge", `${label}: cover_preset ${state.trip(tripId).cover_preset}`);
  await page.reload();
  await openEdit(page, tripId);
  const motifAgain = await page.locator('[data-testid="cover-badge"]').innerText();
  assert(motifAgain.includes("Motiv Berge"), `${label}: Motiv nach Neuladen «${motifAgain}»`);

  state.trip(tripId).cover_media_id = "m-weg";
  await page.reload();
  await openEdit(page, tripId);
  const deletedBadge = await page.locator('[data-testid="cover-badge"]').innerText();
  assert(deletedBadge.includes("Automatisch") && deletedBadge.includes("Berge"), `${label}: gelöschtes Foto «${deletedBadge}»`);
  const deletedSrc = await page.locator('[data-testid="cover-preview-img"]').getAttribute("src");
  assert(deletedSrc && deletedSrc.includes("berge"), `${label}: gelöschtes Foto bleibt sichtbar «${deletedSrc}»`);

  state.trip(tripId).cover_media_id = "m-fremd";
  await page.reload();
  await openEdit(page, tripId);
  const foreignBadge = await page.locator('[data-testid="cover-badge"]').innerText();
  assert(foreignBadge.includes("Automatisch"), `${label}: fremdes Titelbild «${foreignBadge}»`);

  const uploadsBefore = state.uploads;
  const mediaBefore = state.media.length;
  await openSheet(page);
  await page.setInputFiles('[data-testid="cover-device-input"]', TINY_PATH);
  await page.waitForSelector('[data-testid="cover-day-picker"]');
  await page.click(`[data-cover-day="${TODAY}"]`);
  await page.waitForSelector(".cover-photo__neu");
  await page.click('[data-testid="cover-sheet-done"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="cover-badge"]')?.textContent || "").includes("Foto"));
  await saveForm(page);
  assert(state.uploads >= uploadsBefore + 2, `${label}: Upload hat Storage nicht getroffen (${state.uploads})`);
  assert(state.media.length === mediaBefore + 1, `${label}: Gerät-Foto ist kein Reisefoto`);
  const created = state.media.find((row) => row.trip_id === tripId && row.id !== "m-see" && row.id !== "m-own-2" && row.id !== "m-burg" && row.id !== "m-weg");
  assert(created && created.day === TODAY && !created.deleted_at, `${label}: Tag des Gerät-Fotos ${created?.day}`);
  assert(state.trip(tripId).cover_media_id === created.id, `${label}: Gerät-Foto ist nicht das Titelbild`);
  assert(state.trip(tripId).cover_preset === "berge", `${label}: Motiv beim Foto verloren`);

  await page.evaluate((id) => {
    window.location.hash = `#/urlaub/${id}`;
  }, tripId);
  await page.waitForFunction(() => {
    const root = document.querySelector("[data-page='current']");
    return root?.innerText?.includes("Hafen Malcesine") && root.querySelector('[data-testid="photo-select-start"]');
  });
  await enterSelect(page);
  await page.locator('[data-testid="place-photo"][data-media-id="m-see"]').click();
  await page.click('[data-testid="photo-move"]');
  await page.waitForSelector('[data-testid="photo-move-sheet"]');
  await page.locator('[data-move-place="p-ufer"]').click();
  await page.waitForFunction(() => (document.querySelector('[data-place-id="p-ufer"] .oc__meta')?.textContent || "").includes("1 Foto"));
  await page.click(`[data-day="${OTHER}"]`);
  await page.waitForFunction(() => (document.querySelector("[data-page='current']")?.innerText || "").includes("Burg Limone"));
  await page.click(`[data-day="${TODAY}"]`);
  await page.waitForFunction(() => (document.querySelector('[data-place-id="p-ufer"] .oc__meta')?.textContent || "").includes("1 Foto"));
  await page.click('[data-testid="app-toast"] [data-action="undo"]');
  await page.waitForFunction(() => {
    const ufer = document.querySelector('[data-place-id="p-ufer"] .oc__meta')?.textContent || "";
    const hafen = document.querySelector('[data-place-id="p-hafen"] .oc__meta')?.textContent || "";
    return !ufer.includes("Foto") && hafen.includes("Foto");
  });
  assert(!(await meta(page, "p-ufer")).includes("Foto"), `${label}: Geisterfoto am Ufer «${await meta(page, "p-ufer")}»`);

  await enterSelect(page);
  await page.locator('[data-testid="place-photo"][data-media-id="m-see"]').click();
  await page.locator('[data-testid="photo-move"]').evaluate((btn) => {
    btn.click();
    btn.click();
  });
  await page.waitForSelector('[data-testid="photo-move-sheet"]');
  assert((await page.locator('[data-testid="photo-move-sheet"]').count()) === 1, `${label}: Doppelklick öffnet zwei Sheets`);
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--safe-bottom", "34px");
  });
  const padding = await page.locator('[data-testid="photo-move-sheet"]').evaluate((el) => getComputedStyle(el).paddingBottom);
  assert(padding === "50px", `${label}: Safe Area ${padding}`);

  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="photo-move-sheet"]', { state: "detached" });
  assert(!(await page.locator('[data-testid="photo-select-bar"]').count()), `${label}: Escape beendet die Auswahl nicht`);
  assert(page.url().includes(`/urlaub/${tripId}`), `${label}: Escape verlässt die Reise`);

  await enterSelect(page);
  await page.locator('[data-testid="place-photo"][data-media-id="m-see"]').click();
  const beforeBack = page.url();
  await page.goBack();
  await page.waitForSelector('[data-testid="photo-select-bar"]', { state: "detached" });
  assert(page.url() === beforeBack, `${label}: Zurück verlässt die Reise ${beforeBack} → ${page.url()}`);
  assert(page.url().includes(`/urlaub/${tripId}`), `${label}: Zurück ist nicht mehr die Reise`);

  state.role = "viewer";
  await page.reload();
  await openEdit(page, tripId);
  assert(!(await page.locator('[data-testid="cover-change"]').count()), `${label}: Viewer sieht Titelbild ändern`);
  assert(await page.locator('[data-testid="cover-badge"]').count(), `${label}: Viewer ohne Vorschau`);
}

async function runSuite(browserType, baseUrl, label, viewport) {
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

  const where = `${label} ${viewport.width}x${viewport.height}`;
  await page.goto(baseUrl);
  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  assert(Number(build) === 65, `${where}: Build ${build}`);
  await runFlows(page, state, where);
  const unexpected = pageErrors.filter((err) => !err.includes("access control checks"));
  assert(!unexpected.length, `${where}: Seitenfehler ${unexpected.join(" | ")}`);
  await browser.close();
  console.log(`Playwright 11 tests OK (${where})`);
}

await writeFile(TINY_PATH, TINY_PNG);
const { server, baseUrl } = await startServer();
try {
  for (const viewport of VIEWPORTS) {
    await runSuite(chromium, baseUrl, "Chromium", viewport);
    await runSuite(webkit, baseUrl, "WebKit", viewport);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
