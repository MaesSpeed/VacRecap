import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";
import { normalizeMediaCaption } from "../js/cloud-mappers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const TODAY = "2026-10-30";
const USER = "11111111-1111-1111-1111-111111111111";
const OTHER_USER = "22222222-2222-2222-2222-222222222222";

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

const VIEWPORTS = [
  { width: 375, height: 667 },
  { width: 360, height: 740 },
  { width: 390, height: 844 },
];

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEmojiAtPosition500() {
  const emoji = "😀";
  const raw = `${"a".repeat(499)}${emoji}zz`;
  const out = normalizeMediaCaption(raw);
  assert(out.endsWith(emoji), `Emoji an Position 500 zerschnitten (${JSON.stringify(out.slice(-3))})`);
  assert(!out.includes("z"), "Zeichen hinter dem Emoji bleiben in der Notiz");
  assert(Array.from(out).length === 500, `Notiz hat ${Array.from(out).length} Zeichen statt 500`);
  assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), "halbes Emoji in der Notiz");
  const exact = `${"a".repeat(499)}${emoji}`;
  assert(normalizeMediaCaption(exact) === exact, "Emoji an Position 500 wird abgeschnitten, obwohl es noch passt");
}
assertEmojiAtPosition500();

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

function photoRow(id, tripId, placeId, day, iso, author = USER, caption = null) {
  return {
    id,
    trip_id: tripId,
    waypoint_id: placeId,
    day,
    taken_at: iso,
    kind: "photo",
    storage_path: `orig/${id}.jpg`,
    thumb_path: `${id}.jpg`,
    mime: "image/jpeg",
    upload_status: "uploaded",
    deleted_at: null,
    created_at: iso,
    updated_at: iso,
    created_by: author,
    caption,
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
  const mediaPatches = [];
  const captionAttempts = [];
  const mediaSelects = [];
  let captionMissInflight = 0;
  let role = "owner";
  let captionColumn = true;
  let inflight = 0;
  let lastDone = 0;

  function represent(row, headers) {
    const accept = headers.accept || "";
    if (accept.includes("application/vnd.pgrst.object+json")) return row;
    return [row];
  }
  function sendRows(rows, headers) {
    const accept = headers.accept || "";
    if (accept.includes("application/vnd.pgrst.object+json")) {
      if (!rows.length) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
      return { status: 200, json: rows[0] };
    }
    return { status: 200, json: rows };
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
    mediaPatches,
    captionAttempts,
    mediaSelects,
    get captionMissInflight() {
      return captionMissInflight;
    },
    set captionMissInflight(value) {
      captionMissInflight = value;
    },
    get role() {
      return role;
    },
    set role(value) {
      role = value;
    },
    get captionColumn() {
      return captionColumn;
    },
    set captionColumn(value) {
      captionColumn = Boolean(value);
    },
    get inflight() {
      return inflight;
    },
    set inflight(value) {
      inflight = value;
    },
    get lastDone() {
      return lastDone;
    },
    set lastDone(value) {
      lastDone = value;
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
        return { status: 200, json: { signedURL: "/object/sign/mock?token=1" } };
      }
      if (pathName.includes("/object/sign/mock") && method === "GET") {
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
        if (method === "GET") return sendRows(applyFilters(trips, url), headers);
      }
      if (table === "waypoints" && method === "GET") return sendRows(applyFilters(waypoints, url), headers);
      if (table === "notes" && method === "GET") return sendRows(applyFilters(notes, url), headers);
      if (table === "media" && method === "GET") {
        const select = url.searchParams.get("select") || "";
        mediaSelects.push(select);
        if (!captionColumn && select.includes("caption")) {
          return {
            status: 400,
            json: {
              code: "PGRST204",
              message: "Could not find the 'caption' column of 'media' in the schema cache",
            },
          };
        }
        return sendRows(applyFilters(media, url), headers);
      }
      if (table === "media" && method === "PATCH") {
        const rows = applyFilters(media, url);
        const patch = JSON.parse(body || "{}");
        captionAttempts.push(patch);
        if (!captionColumn && Object.prototype.hasOwnProperty.call(patch, "caption")) {
          return {
            status: 400,
            json: { code: "42703", message: "column media.caption does not exist" },
          };
        }
        if (!rows[0]) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
        mediaPatches.push({ id: rows[0].id, patch });
        const createdBy = rows[0].created_by;
        Object.assign(rows[0], patch, { created_by: createdBy });
        return { status: 200, json: represent(rows[0], headers) };
      }
      if (table === "trip_members" && method === "GET") {
        const tripId = [...url.searchParams.values()].find((value) => value.startsWith("eq."))?.slice(3) || "";
        return sendRows([{ role, trip_id: tripId, user_id: USER }], headers);
      }
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
    const select = url.searchParams.get("select") || "";
    const captionMiss =
      !state.captionColumn &&
      req.method() === "GET" &&
      url.pathname.includes("/rest/v1/media") &&
      select.includes("caption");
    if (captionMiss) {
      state.captionMissInflight += 1;
      const start = Date.now();
      while (state.captionMissInflight < 2 && Date.now() - start < 600) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }
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

function seedTrip(state, tripId) {
  state.waypoints.push(
    placeRow("p-hafen", tripId, TODAY, "Hafen Malcesine", "2026-10-30T12:00:00.000Z"),
    placeRow("p-ufer", tripId, TODAY, "Uferpromenade", "2026-10-30T11:00:00.000Z")
  );
  state.media.push(
    photoRow("m-own-1", tripId, "p-hafen", TODAY, "2026-10-30T12:05:00.000Z", USER, "Morgenlicht"),
    photoRow("m-own-2", tripId, "p-hafen", TODAY, "2026-10-30T12:10:00.000Z", USER, null),
    photoRow("m-fremd", tripId, "p-hafen", TODAY, "2026-10-30T12:12:00.000Z", OTHER_USER, "Fremde Notiz"),
    photoRow("m-ufer", tripId, "p-ufer", TODAY, "2026-10-30T11:05:00.000Z", USER, "Welle")
  );
}

async function loginAndOpen(page) {
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
  await page.waitForFunction(
    (day) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === day,
    TODAY
  );
  return page.locator(".screen--trip").getAttribute("data-vacation-id");
}

function assertCaptionPatch(patch, caption, label) {
  const keys = Object.keys(patch).sort();
  assert(keys.join(",") === "caption,updated_at", `${label}: Patchfelder ${keys.join(",")}`);
  assert(patch.caption === caption, `${label}: caption ${JSON.stringify(patch.caption)}`);
  assert(typeof patch.updated_at === "string" && patch.updated_at.includes("T"), `${label}: updated_at fehlt`);
}

async function openCaptionSheet(page, mediaId) {
  await page.locator(`[data-page="current"] [data-testid="photo-caption-edit"][data-media-id="${mediaId}"]`).click();
  await page.waitForSelector('[data-testid="photo-caption-sheet"]');
}

async function runFlows(page, state, label) {
  await page.waitForFunction(() => {
    const root = document.querySelector("[data-page='current']");
    return root?.innerText?.includes("Morgenlicht") && root.querySelector('[data-testid="photo-caption-mark"]');
  });
  assert(
    (await page.locator('[data-testid="place-photo"][data-media-id="m-own-1"] [data-testid="photo-caption-mark"]').count()) === 1,
    `${label}: Thumbnail ohne Notizzeichen`
  );
  assert(
    (await page.locator('[data-testid="place-photo"][data-media-id="m-own-2"] [data-testid="photo-caption-mark"]').count()) === 0,
    `${label}: leeres Foto trägt ein Notizzeichen`
  );
  const row = page.locator('[data-testid="photo-caption-row"][data-media-id="m-own-1"]');
  assert((await row.innerText()).includes("Morgenlicht"), `${label}: Notizliste ohne Fotonotiz`);
  assert((await row.locator('[data-testid="photo-caption-thumb"]').count()) === 1, `${label}: Fotonotiz ohne Thumbnail`);
  assert(
    (await page.locator('[data-testid="photo-caption-edit"][data-media-id="m-fremd"]').count()) === 0,
    `${label}: fremdes Foto ist bearbeitbar`
  );
  assert((await page.locator('[data-testid="photo-caption-row"][data-media-id="m-fremd"]').innerText()).includes("Fremde Notiz"), `${label}: fremde Notiz fehlt`);

  const editButtons = page.locator('[data-page="current"] [data-testid="photo-caption-edit"]');
  const editLabels = await editButtons.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") || ""));
  assert(editLabels.length >= 2, `${label}: weniger als zwei Notiz-Buttons (${editLabels.length})`);
  assert(new Set(editLabels).size === editLabels.length, `${label}: Notiz-Buttons nicht unterscheidbar (${editLabels.join(" | ")})`);
  assert(editLabels.every((text) => text.startsWith("Notiz zum Foto ") && text !== "Notiz zum Foto"), `${label}: aria-label ohne Foto-Bezug (${editLabels.join(" | ")})`);
  for (const id of ["m-own-1", "m-own-2"]) {
    const btn = page.locator(`[data-page="current"] [data-testid="photo-caption-edit"][data-media-id="${id}"]`);
    assert((await btn.locator('[data-testid="photo-caption-edit-thumb"]').count()) === 1, `${label}: Button ${id} ohne Miniatur`);
    const tileSrc = await page.locator(`[data-testid="place-photo"][data-media-id="${id}"] img`).getAttribute("src");
    const btnSrc = await btn.locator('[data-testid="photo-caption-edit-thumb"]').getAttribute("src");
    assert(tileSrc && btnSrc === tileSrc, `${label}: Miniatur von ${id} gehört zu einem anderen Foto`);
  }
  await page.locator('[data-testid="photo-caption-edit"][data-media-id="m-own-1"] [data-testid="photo-caption-edit-thumb"]').click();
  await page.waitForSelector('[data-testid="photo-caption-sheet"]');
  assert((await page.locator('[data-testid="photo-caption-sheet"]').count()) === 1, `${label}: Miniatur öffnet mehr als ein Sheet`);
  assert((await page.locator('[data-testid="photo-caption-text"]').inputValue()) === "Morgenlicht", `${label}: Miniatur öffnet die falsche Notiz`);
  await page.click('[data-testid="photo-caption-cancel"]');
  await page.waitForSelector('[data-testid="photo-caption-sheet"]', { state: "detached" });
  await page.locator('[data-testid="photo-caption-edit"][data-media-id="m-own-2"] [data-testid="photo-caption-edit-thumb"]').click();
  await page.waitForSelector('[data-testid="photo-caption-sheet"]');
  assert((await page.locator('[data-testid="photo-caption-text"]').inputValue()) === "", `${label}: zweites Foto öffnet die Notiz des ersten`);
  await page.click('[data-testid="photo-caption-cancel"]');
  await page.waitForSelector('[data-testid="photo-caption-sheet"]', { state: "detached" });

  await row.click();
  await page.waitForSelector('[data-testid="media-viewer-caption"]');
  assert((await page.locator('[data-testid="media-viewer-caption"]').innerText()).includes("Morgenlicht"), `${label}: Großansicht ohne Notiz`);
  assert((await page.locator('[data-testid="media-viewer"] [data-testid="photo-caption-edit"]').count()) === 1, `${label}: eigene Notiz ohne Stift`);
  await page.click('[data-testid="media-viewer-close"]');
  await page.waitForSelector('[data-testid="media-viewer"]', { state: "detached" });

  const beforeCreate = state.mediaPatches.length;
  await openCaptionSheet(page, "m-own-2");
  await page.fill('[data-testid="photo-caption-text"]', "Hafen");
  await page.waitForFunction(() => !document.querySelector('[data-testid="photo-caption-save"]').disabled);
  await page.locator('[data-testid="photo-caption-save"]').evaluate((btn) => {
    btn.click();
    btn.click();
  });
  await page.waitForFunction(
    (start) => document.body.innerText.includes("Notiz gespeichert") && document.body.innerText.includes("Rückgängig"),
    beforeCreate
  );
  const created = state.mediaPatches.slice(beforeCreate);
  assert(created.length === 1, `${label}: Doppeltipp schreibt ${created.length} Patches`);
  assert(created[0].id === "m-own-2", `${label}: Patch trifft ${created[0].id}`);
  assertCaptionPatch(created[0].patch, "Hafen", `${label} anlegen`);
  await page.waitForFunction(() => (document.querySelector('[data-testid="photo-caption-row"][data-media-id="m-own-2"]')?.innerText || "").includes("Hafen"));
  assert(
    (await page.locator('[data-testid="place-photo"][data-media-id="m-own-2"] [data-testid="photo-caption-mark"]').count()) === 1,
    `${label}: neues Notizzeichen fehlt`
  );

  await page.click('[data-testid="app-toast"] [data-action="undo"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="photo-caption-row"][data-media-id="m-own-2"]'));
  const undone = state.mediaPatches.at(-1);
  assertCaptionPatch(undone.patch, null, `${label} rückgängig`);

  await openCaptionSheet(page, "m-own-2");
  await page.fill('[data-testid="photo-caption-text"]', "Hafen");
  await page.click('[data-testid="photo-caption-save"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="photo-caption-row"][data-media-id="m-own-2"]')?.innerText || "").includes("Hafen"));

  await page.locator('[data-testid="place-photo"][data-media-id="m-own-2"]').click();
  await page.waitForSelector('[data-testid="media-viewer-caption"]');
  await page.locator('[data-testid="media-viewer"] [data-testid="photo-caption-edit"]').click();
  await page.waitForSelector('[data-testid="photo-caption-sheet"]');
  await page.fill('[data-testid="photo-caption-text"]', "Steg");
  const beforeChange = state.mediaPatches.length;
  await page.click('[data-testid="photo-caption-save"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="media-viewer-caption"]')?.textContent || "").includes("Steg"));
  assertCaptionPatch(state.mediaPatches[beforeChange].patch, "Steg", `${label} ändern`);
  assert(state.mediaPatches.length === beforeChange + 1, `${label}: Ändern schreibt mehr als einen Patch`);

  await page.locator('[data-testid="media-viewer"] [data-testid="photo-caption-edit"]').click();
  await page.waitForSelector('[data-testid="photo-caption-delete"]');
  const beforeDelete = state.mediaPatches.length;
  await page.click('[data-testid="photo-caption-delete"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="media-viewer-caption"]'));
  assertCaptionPatch(state.mediaPatches[beforeDelete].patch, null, `${label} löschen`);
  await page.click('[data-testid="media-viewer-close"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="photo-caption-row"][data-media-id="m-own-2"]'));

  const beforeEscape = state.mediaPatches.length;
  await openCaptionSheet(page, "m-own-1");
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="photo-caption-sheet"]', { state: "detached" });
  assert(state.mediaPatches.length === beforeEscape, `${label}: Escape speichert`);
  assert(page.url().includes("/urlaub/"), `${label}: Escape verlässt die Reise`);

  await openCaptionSheet(page, "m-own-1");
  const beforeBack = page.url();
  await page.goBack();
  await page.waitForSelector('[data-testid="photo-caption-sheet"]', { state: "detached" });
  assert(page.url() === beforeBack, `${label}: Zurück verlässt die Reise`);
  assert(state.mediaPatches.length === beforeEscape, `${label}: Zurück speichert`);

  state.captionColumn = false;
  state.mediaSelects.length = 0;
  await page.reload();
  await page.waitForSelector('[data-testid="place-photo"][data-media-id="m-own-1"]');
  await page.waitForSelector('[data-media-id="m-ufer"]');
  assert((await page.locator('[data-testid="place-media-error"]').count()) === 0, `${label}: paralleles Lesen ohne Spalte zeigt einen Fehler`);
  assert((await page.locator('[data-testid="place-photo"][data-media-id="m-own-1"]').count()) === 1, `${label}: Foto des ersten Orts fehlt`);
  assert((await page.locator('[data-media-id="m-ufer"]').count()) >= 1, `${label}: Foto des zweiten Orts fehlt`);
  const withCaption = state.mediaSelects.filter((select) => select.includes("caption")).length;
  const withoutCaption = state.mediaSelects.filter((select) => select && !select.includes("caption")).length;
  assert(withCaption >= 2, `${label}: nur ${withCaption} Abfragen mit caption`);
  assert(withoutCaption >= 2, `${label}: nur ${withoutCaption} Wiederholungen ohne caption`);
  await openCaptionSheet(page, "m-own-1");
  await page.fill('[data-testid="photo-caption-text"]', "Ohne Spalte");
  const attemptsAtFallback = state.captionAttempts.length;
  await page.click('[data-testid="photo-caption-save"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Fotonotiz noch nicht verfügbar"));
  const fallbackAttempts = state.captionAttempts.slice(attemptsAtFallback);
  assert(fallbackAttempts.length === 2, `${label}: Fallback versucht ${fallbackAttempts.length} Schreibvorgänge`);
  assertCaptionPatch(fallbackAttempts[0], "Ohne Spalte", `${label} Fallback`);
  assert(!Object.prototype.hasOwnProperty.call(fallbackAttempts[1], "caption"), `${label}: zweiter Versuch enthält caption`);
  assert(typeof fallbackAttempts[1].updated_at === "string", `${label}: zweiter Versuch ohne updated_at`);
  assert(state.media.find((row) => row.id === "m-own-1").caption === "Morgenlicht", `${label}: Fallback überschreibt die Notiz`);
  assert((await page.locator('[data-testid="place-photo"]').count()) >= 3, `${label}: Fotos nach Fallback weg`);
  assert((await page.locator('[data-testid="photo-caption-row"][data-media-id="m-own-1"]').innerText()).includes("Morgenlicht"), `${label}: alte Notiz geht beim Fallback verloren`);

  state.captionColumn = true;
  state.role = "viewer";
  await page.reload();
  await page.waitForFunction(() => (document.body.innerText || "").includes("Morgenlicht"));
  assert((await page.locator('[data-testid="photo-caption-edit"]').count()) >= 1, `${label}: Beitragender bearbeitet die eigene Notiz nicht`);
  assert((await page.locator('[data-testid="photo-caption-row"][data-media-id="m-own-1"]').innerText()).includes("Morgenlicht"), `${label}: Betrachter sieht die Notiz nicht`);
  await page.locator('[data-testid="photo-caption-row"][data-media-id="m-own-1"]').click();
  await page.waitForSelector('[data-testid="media-viewer-caption"]');
  assert((await page.locator('[data-testid="media-viewer"] [data-testid="photo-caption-edit"]').count()) === 1, `${label}: Beitragender bearbeitet in der Großansicht nicht`);
  assert((await page.locator('[data-testid="media-viewer-caption"]').innerText()).includes("Morgenlicht"), `${label}: Großansicht für Betrachter leer`);
  await page.click('[data-testid="media-viewer-close"]');
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
  });

  const where = `${label} ${viewport.width}x${viewport.height}`;
  await page.goto(baseUrl);
  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  assert(Number(build) === 65, `${where}: Build ${build}`);
  const tripId = await loginAndOpen(page);
  seedTrip(state, tripId);
  await page.reload();
  await runFlows(page, state, where);
  const unexpected = pageErrors.filter((err) => !err.includes("access control checks"));
  assert(!unexpected.length, `${where}: Seitenfehler ${unexpected.join(" | ")}`);
  await browser.close();
  console.log(`Playwright 9b Fotonotiz OK (${where})`);
}

const { server, baseUrl } = await startServer();
try {
  for (const viewport of VIEWPORTS) {
    await runSuite(chromium, baseUrl, "Chromium", viewport);
    await runSuite(webkit, baseUrl, "WebKit", viewport);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
