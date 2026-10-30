import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const LONG_EMAIL =
  "sehrlange.adresse.ohne.leerzeichen.abcdefghijklmnopqrstuvwxyz@beispiel-reise.example";

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
    user: { id: userId, aud: "authenticated", role: "authenticated", email: LONG_EMAIL },
  };
  const trips = [];
  const waypoints = [];
  const notes = [];
  const qp = (url, key) => {
    const raw = url.searchParams.get(key);
    return raw ? raw.replace(/^eq\./, "") : "";
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
      created_at: hit?.created_at || row.created_at || new Date().toISOString(),
    };
    if (hit) Object.assign(hit, full);
    else list.push(full);
    return full;
  };
  const restCounts = { waypoints: 0, notes: 0 };
  return {
    restCounts,
    resetRestCounts() {
      restCounts.waypoints = 0;
      restCounts.notes = 0;
    },
    handleAuth(url, method, body) {
      const pathName = url.pathname;
      if (pathName.endsWith("/otp") && method === "POST") return { status: 200, json: {} };
      if (pathName.endsWith("/verify") && method === "POST") {
        const b = JSON.parse(body || "{}");
        if (b.token !== "123456") {
          return { status: 400, json: { error: "invalid_otp", message: "Invalid" } };
        }
        return { status: 200, json: session };
      }
      if (pathName.endsWith("/token") && method === "POST") return { status: 200, json: session };
      if (pathName.endsWith("/user") && method === "GET") return { status: 200, json: session.user };
      return { status: 404, json: {} };
    },
    handleRest(url, method, body, headers) {
      const table = url.pathname.split("/").filter(Boolean).pop();
      const prefer = headers.prefer || "";
      if (method === "GET" && table === "waypoints") restCounts.waypoints += 1;
      if (method === "GET" && table === "notes") restCounts.notes += 1;
      if (table === "trips") {
        if (method === "POST") {
          const row = JSON.parse(body);
          const full = upsertRow(trips, row, { companions: row.companions || [] });
          return { status: 201, json: prefer.includes("return=representation") ? [full] : null };
        }
        if (method === "GET") {
          const id = qp(url, "id");
          if (id) {
            const t = trips.find((x) => x.id === id);
            return { status: 200, json: t ? [t] : [] };
          }
          return { status: 200, json: trips };
        }
      }
      if (table === "waypoints") {
        if (method === "GET") {
          const id = qp(url, "id");
          if (id) {
            const w = waypoints.find((x) => x.id === id && !x.deleted_at);
            return { status: 200, json: w ? [w] : [] };
          }
          const tripId = qp(url, "trip_id");
          return {
            status: 200,
            json: waypoints.filter((w) => w.trip_id === tripId && !w.deleted_at),
          };
        }
        if (method === "POST") {
          const row = JSON.parse(body);
          return { status: 201, json: [upsertRow(waypoints, row, { deleted_at: null })] };
        }
      }
      if (table === "notes") {
        if (method === "GET") {
          const wpRaw = url.searchParams.get("waypoint_id");
          const tripId = qp(url, "trip_id");
          const day = qp(url, "day");
          let rows = notes.filter((n) => !n.deleted_at);
          if (wpRaw === "is.null") rows = rows.filter((n) => n.waypoint_id == null);
          else if (wpRaw) rows = rows.filter((n) => n.waypoint_id === wpRaw.replace(/^eq\./, ""));
          if (tripId) rows = rows.filter((n) => n.trip_id === tripId);
          if (day) rows = rows.filter((n) => String(n.day).slice(0, 10) === day.slice(0, 10));
          return { status: 200, json: rows };
        }
        if (method === "POST") {
          const row = JSON.parse(body || "{}");
          const full = upsertRow(notes, row, { deleted_at: null });
          if (!("waypoint_id" in row)) full.waypoint_id = full.waypoint_id ?? null;
          return { status: 201, json: [full] };
        }
        if (method === "PATCH") {
          const id = qp(url, "id");
          const row = JSON.parse(body || "{}");
          const n = notes.find((x) => x.id === id);
          if (!n) return { status: 406, json: { code: "PGRST116", message: "0 rows" } };
          Object.assign(n, row, { updated_at: new Date().toISOString() });
          return { status: 200, json: [n] };
        }
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
  await page.route("**/nominatim.openstreetmap.org/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ display_name: "Rue de Rivoli, Paris" }),
    })
  );
  await page.route("**/tile.openstreetmap.org/**", (route) => route.abort());
}

function boxOf(rect) {
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
}

async function svgBox(page, selector) {
  const box = await page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  return boxOf(box);
}

async function trackX(page) {
  return page.locator("[data-role='day-track']").evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
}

async function touchDrag(page, selector, dx, dy, transformSelector = null) {
  return page.locator(selector).evaluate(
    (el, { dx, dy, transformSelector }) => {
      const styled = transformSelector ? document.querySelector(transformSelector) : el;
      const r = el.getBoundingClientRect();
      const x0 = r.left + Math.min(r.width / 2, 180);
      const y0 = r.top + Math.min(48, r.height / 2);
      const fire = (phase, x, y) => {
        const touchType = phase === "start" ? "touchstart" : phase === "move" ? "touchmove" : "touchend";
        try {
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
        } catch {
          const pointerType = phase === "start" ? "pointerdown" : phase === "move" ? "pointermove" : "pointerup";
          el.dispatchEvent(
            new PointerEvent(pointerType, {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              pointerId: 1,
              pointerType: "mouse",
              isPrimary: true,
              button: 0,
              buttons: phase === "end" ? 0 : 1,
            })
          );
        }
      };
      fire("start", x0, y0);
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        fire("move", x0 + (dx * i) / steps, y0 + (dy * i) / steps);
      }
      const during = styled?.style.transform || "";
      const matrix = styled ? new DOMMatrix(getComputedStyle(styled).transform).m41 : 0;
      fire("end", x0 + dx, y0 + dy);
      return { during, matrix };
    },
    { dx, dy, transformSelector }
  );
}

async function runSuite(browserType, baseUrl, label) {
  const ctx = await browserType.launch({ headless: true }).then((browser) =>
    browser.newContext({
      ...devices["iPhone 8"],
      baseURL: baseUrl,
      geolocation: { latitude: 48.8566, longitude: 2.3522 },
      permissions: ["geolocation"],
    })
  );
  const page = await ctx.newPage();
  page.setDefaultTimeout(25_000);
  const state = createMockSupabaseState();
  await installSupabaseMocks(page, state);
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto(baseUrl);
  await page.waitForSelector('[data-testid="login-screen"]');

  const mapped = await page.evaluate(async () => {
    const { noteToRow } = await import("./js/cloud-mappers.js");
    return noteToRow({
      vacationId: "00000000-0000-0000-0000-000000000001",
      day: "2026-11-06",
      text: "frei",
      placeId: null,
    });
  });
  if (mapped.waypoint_id !== null) {
    throw new Error(`${label}: noteToRow setzt waypoint_id nicht auf null`);
  }
  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  if (Number(build) !== 54) throw new Error(`${label}: Build ${build}, erwartet 54`);

  await page.fill('input[name="email"]', LONG_EMAIL);
  const emailOverflow = await page.evaluate(() => {
    const input = document.querySelector('input[name="email"]');
    const main = document.querySelector(".login-main");
    return input.getBoundingClientRect().right - main.getBoundingClientRect().right;
  });
  if (emailOverflow > 1) {
    throw new Error(`${label}: E-Mail-Feld läuft über (${emailOverflow.toFixed(1)}px)`);
  }

  await page.click('form[data-step="email"] button[type="submit"]');
  await page.waitForSelector('form[data-step="otp"]');
  const hint = await page.evaluate(() => {
    const el = document.querySelector(".login-hint");
    const main = document.querySelector(".login-main");
    const er = el.getBoundingClientRect();
    const mr = main.getBoundingClientRect();
    return {
      overflow: er.right - mr.right,
      scrollGap: el.scrollWidth - el.clientWidth,
      text: el.textContent,
    };
  });
  if (!hint.text.includes(LONG_EMAIL)) throw new Error(`${label}: E-Mail nicht im Hinweis`);
  if (hint.overflow > 1 || hint.scrollGap > 2) {
    throw new Error(`${label}: E-Mail-Hinweis läuft aus dem Bild (${JSON.stringify(hint)})`);
  }

  const buttons = await page.evaluate(() => {
    const ghost = document.querySelector('[data-action="back"]');
    const submit = document.querySelector('form[data-step="otp"] button[type="submit"]');
    const gs = getComputedStyle(ghost);
    const ss = getComputedStyle(submit);
    return {
      ghostImage: gs.backgroundImage,
      ghostBorder: parseFloat(gs.borderTopWidth),
      ghostColor: gs.color,
      ghostBg: gs.backgroundColor,
      submitImage: ss.backgroundImage,
      submitColor: ss.color,
    };
  });
  if (buttons.ghostImage !== "none") {
    throw new Error(`${label}: Andere E-Mail ist kein Umriss (${buttons.ghostImage})`);
  }
  if (!(buttons.ghostBorder >= 2)) {
    throw new Error(`${label}: Andere E-Mail ohne Rahmen (${buttons.ghostBorder})`);
  }
  if (buttons.ghostColor === buttons.submitColor) {
    throw new Error(`${label}: Andere E-Mail hat dieselbe Schriftfarbe wie der volle Button`);
  }
  if (buttons.submitImage === "none") {
    throw new Error(`${label}: Anmelden sollte gefüllt bleiben`);
  }

  await page.fill('input[name="otp"]', "123456");
  await page.click('form[data-step="otp"] button[type="submit"]');
  await page.waitForSelector(".screen--urlaube");

  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', "Paket 8a");
  await page.click('[data-action="pick-dates"]');
  await page.click('.calendar-day[data-date="2026-11-06"]');
  await page.click('.calendar-day[data-date="2026-11-08"]');
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');

  await page.evaluate(async () => {
    const { putPlace } = await import("./js/db.js");
    const { createPlace } = await import("./js/places.js");
    const tripId = document.querySelector(".screen--trip").dataset.vacationId;
    const spots = [
      ["Louvre", "2026-11-06", 1],
      ["Eiffel", "2026-11-06", 2],
      ["Seine", "2026-11-07", 3],
    ];
    for (const [name, day, ts] of spots) {
      await putPlace(
        createPlace({
          vacationId: tripId,
          day,
          ts,
          lat: 48.86,
          lng: 2.35,
          name,
        })
      );
    }
    for (let i = 0; i < 6; i++) {
      await putPlace(
        createPlace({
          vacationId: tripId,
          day: "2026-11-06",
          ts: 10 + i,
          lat: 48.86,
          lng: 2.34,
          name: `Extra ${i}`,
        })
      );
    }
  });
  await page.waitForSelector(".oc--selected", { timeout: 15_000 });
  const placeId = await page.locator(".oc--selected").getAttribute("data-place-id");
  const placeName = (await page.locator(".oc--selected .oc__title").innerText()).trim();

  await page.evaluate(
    async ({ placeId }) => {
      const { putNote } = await import("./js/db.js");
      const { createId } = await import("./js/utils.js");
      const tripId = document.querySelector(".screen--trip").dataset.vacationId;
      for (const text of ["Alpha", "Beta", "Gamma"]) {
        await putNote({
          id: createId(),
          vacationId: tripId,
          placeId,
          day: "2026-11-06",
          text,
          ts: Date.now(),
        });
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    { placeId }
  );
  await page.waitForSelector('[data-action="expand-notes"]');
  await page.waitForSelector(".oc--selected [data-action='add-note']");

  const noteStyles = await page.evaluate(() => {
    const add = document.querySelector(".oc--selected [data-action='add-note']");
    const more = document.querySelector(".oc--selected [data-action='expand-notes']");
    const a = getComputedStyle(add);
    const m = getComputedStyle(more);
    return {
      addClass: add.className,
      moreClass: more.className,
      addBorder: parseFloat(a.borderTopWidth),
      moreBorder: parseFloat(m.borderTopWidth),
      addBg: a.backgroundColor,
      moreBg: m.backgroundColor,
      addRadius: a.borderRadius,
      moreRadius: m.borderRadius,
    };
  });
  if (noteStyles.addClass === noteStyles.moreClass) {
    throw new Error(`${label}: + Notiz und +N weitere teilen sich die Klasse`);
  }
  if (!(noteStyles.addBorder > noteStyles.moreBorder + 0.5)) {
    throw new Error(`${label}: + Notiz ist nicht als Umriss von +N weitere unterscheidbar ${JSON.stringify(noteStyles)}`);
  }
  if (noteStyles.addRadius === "0px") {
    throw new Error(`${label}: + Notiz ohne eigene Form`);
  }

  const scroll = await page.locator("[data-page='current']").evaluate((el) => {
    const before = document.scrollingElement.scrollTop;
    el.scrollTop = 180;
    return {
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      bodyScroll: document.scrollingElement.scrollTop,
      bodyBefore: before,
      overflowY: getComputedStyle(el).overflowY,
    };
  });
  if (scroll.clientHeight < 80) {
    throw new Error(`${label}: Tagesseite ohne Höhe ${JSON.stringify(scroll)}`);
  }
  if (scroll.overflowY !== "auto" && scroll.overflowY !== "scroll") {
    throw new Error(`${label}: vertikales Scrollen nicht auf der Seite ${scroll.overflowY}`);
  }
  if (scroll.scrollHeight <= scroll.clientHeight + 8 || scroll.scrollTop < 40) {
    throw new Error(`${label}: Liste scrollt nicht intern ${JSON.stringify(scroll)}`);
  }

  const dayBefore = await page.locator('[data-testid="trip-content"]').getAttribute("data-active-day");
  const restBefore = await trackX(page);
  const width = await page.locator('[data-testid="trip-content"]').evaluate((el) => el.clientWidth);
  if (Math.abs(restBefore + width) > 4) {
    throw new Error(`${label}: Ruhepose ${restBefore} ist nicht −Seitenbreite ${width}`);
  }

  const vertical = await touchDrag(page, "[data-testid='trip-content']", 6, 140, "[data-role='day-track']");
  if (Math.abs(vertical.matrix - restBefore) > 4) {
    throw new Error(`${label}: vertikaler Zug hat die Seite verschoben (${vertical.matrix})`);
  }
  if ((await page.locator('[data-testid="trip-content"]').getAttribute("data-active-day")) !== dayBefore) {
    throw new Error(`${label}: vertikaler Zug hat den Tag gewechselt`);
  }

  const follow = await touchDrag(page, "[data-testid='trip-content']", -70, 0, "[data-role='day-track']");
  if (!follow.during.includes("px")) {
    throw new Error(`${label}: Wisch setzt kein translate3d mit Pixeln (${follow.during})`);
  }
  if (Math.abs(follow.matrix - (restBefore - 70)) > 12) {
    throw new Error(`${label}: Seite folgt dem Finger nicht (${follow.matrix}, Ruhe ${restBefore})`);
  }
  await page.waitForTimeout(450);
  if ((await page.locator('[data-testid="trip-content"]').getAttribute("data-active-day")) !== dayBefore) {
    throw new Error(`${label}: kurzer Wisch hat den Tag gewechselt`);
  }
  const sprung = await trackX(page);
  if (Math.abs(sprung - restBefore) > 4) {
    throw new Error(`${label}: Zurückfedern fehlt (${sprung} vs ${restBefore})`);
  }

  const neighborIds = await page.locator("[data-page='prev'] [data-testid], [data-page='next'] [data-testid]").count();
  if (neighborIds) throw new Error(`${label}: Nachbartage duplizieren Test-IDs (${neighborIds})`);
  state.resetRestCounts();
  await touchDrag(page, "[data-testid='trip-content']", -170, 8, "[data-role='day-track']");
  await page.waitForFunction(
    () => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2026-11-07",
    null,
    { timeout: 8_000 }
  );
  await page.waitForTimeout(400);
  if (state.restCounts.waypoints > 1 || state.restCounts.notes > 6) {
    throw new Error(
      `${label}: Tageswechsel fragt zu viel ab (${state.restCounts.waypoints} waypoints, ${state.restCounts.notes} notes)`
    );
  }
  const neighborIdsAfter = await page.locator("[data-page='prev'] [data-testid], [data-page='next'] [data-testid]").count();
  if (neighborIdsAfter) throw new Error(`${label}: Nachbartage behalten Test-IDs`);
  await page.waitForSelector(".oc__title", { timeout: 10_000 });
  const titles = await page.locator("[data-page='current'] .oc__title").allTextContents();
  if (!titles.some((t) => t.includes("Seine"))) {
    throw new Error(`${label}: nach Swipe nicht der nächste Tag (${titles.join(", ")})`);
  }
  await page.click('[data-day="2026-11-06"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2026-11-06"
  );

  await page.locator('[data-footer-action="note"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  const defaultPlace = (await page.locator("[data-role='place-name']").innerText()).trim();
  if (defaultPlace !== placeName) {
    throw new Error(`${label}: Standardort ist „${defaultPlace}“, erwartet „${placeName}“`);
  }
  if (defaultPlace.includes("Kein Ort")) {
    throw new Error(`${label}: freie Notiz ist fälschlich der Standard`);
  }

  await page.click('[data-action="change-place"]');
  await page.waitForSelector('[data-testid="note-place-sheet"]');
  const partial = await touchDrag(page, "[data-testid='note-place-sheet']", 0, 36);
  const partialY = Number(/,\s*(-?[\d.]+)px/.exec(partial.during)?.[1] || 0);
  if (partialY < 12) {
    throw new Error(`${label}: Unter-Sheet folgt dem Ziehen nicht (${partial.during})`);
  }
  await page.waitForTimeout(400);
  if ((await page.locator("[data-testid='note-place-sheet']").count()) !== 1) {
    throw new Error(`${label}: kurzes Ziehen hat das Unter-Sheet geschlossen`);
  }
  await touchDrag(page, "[data-testid='note-place-sheet']", 0, 160);
  await page.waitForSelector("[data-testid='note-place-sheet']", { state: "detached" });
  if ((await page.locator('[data-testid="note-sheet"]').count()) !== 1) {
    throw new Error(`${label}: Runterziehen hat das Notiz-Sheet mitgeschlossen`);
  }
  if ((await page.locator("[data-role='place-name']").innerText()).trim() !== placeName) {
    throw new Error(`${label}: Ort nach Schließen des Unter-Sheets verändert`);
  }

  await page.click('[data-action="change-place"]');
  await page.waitForSelector('[data-testid="pick-free"]');
  await page.locator('[data-testid="pick-free"]').evaluate((el) => el.click());
  await page.waitForFunction(() =>
    document.querySelector("[data-role='place-name']")?.textContent?.includes("Kein Ort")
  );
  await page.fill('[data-testid="note-sheet"] textarea', "Blick ohne Pin");
  await page.locator('[data-testid="note-sheet"] [data-action="save"]').click();
  await page.waitForSelector('[data-testid="free-notes"]', { timeout: 15_000 });
  const freeText = await page.locator('[data-testid="free-notes"]').innerText();
  if (!freeText.includes("Blick ohne Pin")) {
    throw new Error(`${label}: freie Notiz fehlt in der Tagesübersicht`);
  }
  const inPlace = await page.locator(".oc .nr__text--btn", { hasText: "Blick ohne Pin" }).count();
  if (inPlace) throw new Error(`${label}: freie Notiz hängt an einer Ortskarte`);

  await page.locator('[data-testid="free-notes"] [data-action="edit-free-note"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  const editTitle = (await page.locator(".note-sheet__title").innerText()).trim();
  if (editTitle !== "Notiz bearbeiten") {
    throw new Error(`${label}: freie Notiz öffnet kein Bearbeiten-Sheet (${editTitle})`);
  }
  await page.fill('[data-testid="note-sheet"] textarea', "Blick geändert");
  await page.locator('[data-testid="note-sheet"] [data-action="save"]').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="free-notes"]')?.textContent?.includes("Blick geändert"),
    null,
    { timeout: 15_000 }
  );

  await page.locator('[data-testid="free-notes"] [data-action="edit-free-note"]').click();
  await page.waitForSelector('[data-testid="note-sheet"] [data-action="delete"]');
  await page.locator('[data-testid="note-sheet"] [data-action="delete"]').click();
  await page.locator('[data-testid="confirm-delete-note"] [data-action="confirm"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="free-notes"]'), null, {
    timeout: 15_000,
  });
  await page.reload();
  try {
    await page.waitForSelector('[data-testid="trip-content"]', { timeout: 15_000 });
  } catch (err) {
    const info = await page.evaluate(() => ({
      href: location.href,
      text: document.body.innerText.slice(0, 300),
    }));
    throw new Error(`${label}: nach Reload keine Tagesübersicht ${JSON.stringify(info)} ${err.message}`);
  }
  await page.waitForFunction(
    (name) => document.querySelector('[data-testid="trip-content"]')?.innerText?.includes(name),
    placeName,
    { timeout: 15_000 }
  );
  const afterReload = await page.locator('[data-testid="trip-content"]').innerText();
  if (afterReload.includes("Blick geändert") || afterReload.includes("Blick ohne Pin")) {
    throw new Error(`${label}: gelöschte freie Notiz ist nach Reload noch da`);
  }

  async function assertFade(width) {
    await page.setViewportSize({ width, height: 667 });
    await page.waitForTimeout(50);
    const fade = await page.locator(".place-list-fade").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const footer = document.querySelector(".trip-footer")?.getBoundingClientRect();
      return {
        count: document.querySelectorAll(".place-list-fade").length,
        x: r.x,
        y: r.y,
        bottom: r.bottom,
        w: r.width,
        footerTop: footer?.top ?? -1,
        vw: window.innerWidth,
      };
    });
    if (fade.count !== 1) throw new Error(`${label}: Verlauf ${fade.count}× bei ${width}`);
    if (Math.abs(fade.bottom - fade.footerTop) > 2) {
      throw new Error(`${label}: Verlauf bei ${width}px endet bei ${fade.bottom}, Footer bei ${fade.footerTop}`);
    }
    if (fade.x < -1 || fade.w > fade.vw + 1) {
      throw new Error(`${label}: Verlauf ragt bei ${width}px aus dem Bild ${JSON.stringify(fade)}`);
    }
  }
  for (const width of [375, 360, 390]) await assertFade(width);
  await page.setViewportSize({ width: 375, height: 667 });

  await page.evaluate(async () => {
    const { putNote } = await import("./js/db.js");
    const { createId } = await import("./js/utils.js");
    const tripId = document.querySelector(".screen--trip").dataset.vacationId;
    for (const text of ["Frei-Alt-A", "Frei-Alt-B"]) {
      await putNote({
        id: createId(),
        vacationId: tripId,
        placeId: null,
        day: "2026-11-06",
        text,
        ts: Date.now(),
      });
    }
  });
  await page.click('[data-day="2026-11-07"]');
  await page.click('[data-day="2026-11-06"]');
  await page.waitForSelector(".oc [data-action='edit-note']");
  const expandNotes = page.locator(".oc [data-action='expand-notes']");
  if (await expandNotes.count()) await expandNotes.click();
  await page.locator(".oc [data-action='edit-note']", { hasText: "Alpha" }).click();
  await page.waitForSelector('[data-testid="note-sheet"]');
  await page.click('[data-action="change-place"]');
  await page.waitForSelector('[data-testid="pick-free"]');
  await page.locator('[data-testid="pick-free"]').evaluate((el) => el.click());
  await page.locator('[data-testid="note-sheet"] [data-action="save"]').click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-testid="free-notes"] [data-action="edit-free-note"]')].some((el) =>
        el.textContent.includes("Alpha")
      ),
    null,
    { timeout: 15_000 }
  );

  const tripIcon = await svgBox(page, ".trip-header .link-btn--back svg");
  const mapHit = await page.locator('[data-action="map"]').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      w: r.width,
      h: r.height,
      y: r.y,
      top: top ? `${top.tagName}.${top.className}` : null,
      same: top === el || el.contains(top),
    };
  });
  if (!mapHit.same) {
    throw new Error(`${label}: Karten-Button verdeckt ${JSON.stringify(mapHit)}`);
  }
  await page.locator('[data-action="map"]').evaluate((el) => el.click());
  await page.waitForSelector(".screen--map .map-header__back svg", { timeout: 15_000 });
  const mapIcon = await svgBox(page, ".screen--map .map-header__back svg");
  const titleAlign = await page.evaluate(() => {
    const title = document.querySelector(".map-header__title").getBoundingClientRect();
    const back = document.querySelector(".map-header__back").getBoundingClientRect();
    return {
      titleMid: title.top + title.height / 2,
      backMid: back.top + back.height / 2,
    };
  });
  if (Math.abs(titleAlign.titleMid - titleAlign.backMid) > 2) {
    throw new Error(
      `${label}: Kartentitel sitzt neben dem Zurück-Label (${titleAlign.titleMid.toFixed(1)} vs ${titleAlign.backMid.toFixed(1)})`
    );
  }
  for (const key of ["x", "y", "w", "h"]) {
    if (Math.abs(tripIcon[key] - mapIcon[key]) > 2) {
      throw new Error(
        `${label}: Zurück-Icon ${key} Karte ${mapIcon[key].toFixed(1)} vs Reisen ${tripIcon[key].toFixed(1)}`
      );
    }
  }

  const placesBefore = await page.evaluate(async () => {
    const id = document.querySelector(".screen--map")?.dataset.vacationId;
    const { getPlacesForVacation } = await import("./js/db.js");
    return (await getPlacesForVacation(id)).length;
  });
  await page.evaluate(() => {
    window.__mapCaptureClicks = 0;
    document.querySelectorAll("[data-testid='map-capture-photo-input'], [data-testid='map-capture-video-input']").forEach((input) => {
      input.addEventListener("click", () => {
        window.__mapCaptureClicks += 1;
      });
    });
  });
  let fileChooser = false;
  const onChooser = () => {
    fileChooser = true;
  };
  page.on("filechooser", onChooser);
  const expectMuted = async (action) => {
    await action();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="app-toast"]')?.textContent?.includes("Fotos und Videos kommen im nächsten Schritt"),
      null,
      { timeout: 8_000 }
    );
    if (!(await page.locator(".screen--map").count())) {
      throw new Error(`${label}: Karte nach Medien-Aktion verlassen`);
    }
  };
  await expectMuted(() => page.locator('[data-footer-action="camera"]').click());
  await expectMuted(async () => {
    const cam = page.locator('[data-footer-action="camera"]');
    await cam.dispatchEvent("pointerdown");
    await page.waitForTimeout(650);
    await cam.dispatchEvent("pointerup");
  });
  await page.locator('[data-footer-action="gallery"]').click();
  await page.waitForSelector('[data-testid="trip-library-screen"]', { timeout: 15_000 });
  await page.locator('[data-testid="library-back"]').click();
  await page.waitForSelector(".screen--map", { timeout: 15_000 });
  page.off("filechooser", onChooser);
  if (fileChooser) throw new Error(`${label}: Kartenfooter hat die Kamera geöffnet`);
  const captureClicks = await page.evaluate(() => window.__mapCaptureClicks || 0);
  if (captureClicks) throw new Error(`${label}: Kartenfooter hat den Datei-Input geöffnet (${captureClicks})`);
  const placesAfter = await page.evaluate(async () => {
    const id = document.querySelector(".screen--map")?.dataset.vacationId;
    const { getPlacesForVacation } = await import("./js/db.js");
    return (await getPlacesForVacation(id)).length;
  });
  if (placesAfter !== placesBefore) {
    throw new Error(`${label}: Kartenfooter hat einen Wegpunkt angelegt (${placesBefore} → ${placesAfter})`);
  }

  await page.locator(".screen--map .map-header__back").click();
  await page.waitForSelector(".screen--trip");
  await page.locator(".link-btn--back").click();
  await page.waitForSelector(".screen--urlaube");
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', "Heute");
  await page.click('[data-action="pick-dates"]');
  await page.click('.calendar-day[data-date="2026-10-26"]');
  await page.click('.calendar-day[data-date="2026-10-30"]');
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector(".screen--trip");
  await page.locator('[data-action="map"]').click();
  await page.waitForSelector(".screen--map");
  const today = await page.evaluate(async () => (await import("./js/utils.js")).todayIso());
  await page.locator('[data-footer-action="pin"]').click();
  await page.waitForFunction(
    async (today) => {
      const id = document.querySelector(".screen--map")?.dataset.vacationId;
      if (!id) return false;
      const { getPlacesForVacation } = await import("./js/db.js");
      const places = await getPlacesForVacation(id);
      return places.some((p) => String(p.day).slice(0, 10) === today);
    },
    today,
    { timeout: 15_000 }
  );
  const rememberedDays = await page.evaluate(async () => {
    const id = document.querySelector(".screen--map").dataset.vacationId;
    const { getPlacesForVacation } = await import("./js/db.js");
    return (await getPlacesForVacation(id)).map((p) => String(p.day).slice(0, 10));
  });
  if (rememberedDays.includes("2026-10-26") || !rememberedDays.includes(today)) {
    throw new Error(`${label}: Ort merken landet nicht auf heute ${today} (${rememberedDays.join(",")})`);
  }
  await page.locator('[data-footer-action="note"]').click();
  await page.waitForSelector(`[data-testid="trip-content"][data-active-day="${today}"]`, {
    timeout: 15_000,
  });

  const realErrors = errors.filter((err) => !/access control checks/.test(err));
  if (realErrors.length) throw new Error(`${label}: ${realErrors[0]}`);
  await ctx.browser().close();
  console.log(`8a ${label} OK`);
}

async function main() {
  const { server, baseUrl } = await startServer();
  try {
    await runSuite(chromium, baseUrl, "chromium");
    await runSuite(webkit, baseUrl, "webkit");
  } finally {
    server.close();
  }
  console.log("Playwright 8a tests OK (Build 54)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
