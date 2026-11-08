import { chromium, webkit, devices } from "playwright";
import {
  createMockSupabaseState,
  installSupabaseMocks,
  startServer,
  USER,
} from "./run-tests-12b-recap-video.mjs";

const TRIP = "swipe-p2";
const FIRST = "2026-11-08";
const DAYS = ["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"];
const DATA_TABLES = new Set(["waypoints", "notes", "media"]);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function shiftIso(iso, delta) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

function seedSwipeTrip(state) {
  state.trips.push({
    id: TRIP,
    title: "Wisch Paket 2",
    start_date: FIRST,
    end_date: DAYS[DAYS.length - 1],
    created_at: `${FIRST}T00:00:00.000Z`,
    updated_at: `${DAYS[DAYS.length - 1]}T00:00:00.000Z`,
    created_by: USER,
    companions: [],
    companion_tags: [],
    cover_media_id: null,
    cover_preset: "stadt",
    deleted_at: null,
  });
  const places = [
    ["sw-beta", "Beta Ort", FIRST, "08:00:00"],
    ["sw-alpha", "Alpha Ort", FIRST, "18:00:00"],
    ["sw-gamma", "Gamma Ort", DAYS[1], "09:00:00"],
    ["sw-delta", "Delta Ort", DAYS[2], "09:00:00"],
    ["sw-epsilon", "Epsilon Ort", DAYS[3], "09:00:00"],
    ["sw-zeta", "Zeta Ort", DAYS[4], "09:00:00"],
  ];
  for (const [id, title, day, time] of places) {
    state.waypoints.push({
      id,
      trip_id: TRIP,
      day,
      visited_at: `${day}T${time}.000Z`,
      lat: 45.8,
      lng: 10.8,
      accuracy_m: 8,
      title,
      is_soft: false,
      source: "manual",
      deleted_at: null,
      created_at: `${day}T${time}.000Z`,
      updated_at: `${day}T${time}.000Z`,
      created_by: USER,
    });
  }
  const photos = [
    ["m-mon", "sw-alpha", FIRST],
    ["m-thu", "sw-epsilon", DAYS[3]],
  ];
  for (const [id, placeId, day] of photos) {
    state.media.push({
      id,
      trip_id: TRIP,
      waypoint_id: placeId,
      day,
      taken_at: `${day}T12:00:00.000Z`,
      kind: "photo",
      storage_path: `orig/${id}.jpg`,
      thumb_path: `${id}.jpg`,
      mime: "image/jpeg",
      upload_status: "uploaded",
      deleted_at: null,
      created_at: `${day}T12:00:00.000Z`,
      updated_at: `${day}T12:00:00.000Z`,
      created_by: USER,
    });
  }
}

function allowMediaMove(state) {
  const rest = state.handleRest.bind(state);
  state.handleRest = async (url, method, body, headers) => {
    const table = url.pathname.split("/").filter(Boolean).pop();
    if (table === "media" && method === "PATCH") {
      const id = (url.searchParams.get("id") || "").replace(/^eq\./, "");
      const row = state.media.find((item) => item.id === id);
      if (!row) return { status: 406, json: { message: "0 rows" } };
      const expected = (url.searchParams.get("updated_at") || "").replace(/^eq\./, "");
      if (expected && row.updated_at && expected !== row.updated_at) return { status: 200, json: [] };
      Object.assign(row, JSON.parse(body || "{}"));
      row.updated_at = new Date().toISOString();
      const accept = headers.accept || "";
      return { status: 200, json: accept.includes("application/vnd.pgrst.object+json") ? row : [row] };
    }
    return rest(url, method, body, headers);
  };
}

function iphoneContext() {
  const profile = devices["iPhone 8"] || {};
  return {
    ...profile,
    viewport: { width: 375, height: 667 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: profile.deviceScaleFactor || 2,
  };
}

async function login(page, baseUrl) {
  await page.goto(baseUrl);
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
}

function installGestureHelpers(page) {
  return page.addInitScript(() => {
    let modernTouch = null;
    function touchMode() {
      if (modernTouch != null) return modernTouch;
      try {
        new Touch({ identifier: 1, target: document.body, clientX: 0, clientY: 0, pageX: 0, pageY: 0 });
        modernTouch = true;
      } catch {
        modernTouch = false;
      }
      return modernTouch;
    }
    function fireTouch(el, phase, x, y) {
      const touchType = phase === "start" ? "touchstart" : phase === "move" ? "touchmove" : "touchend";
      const ended = phase === "end";
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
    function swipe(el, dx, dy) {
      const rect = el.getBoundingClientRect();
      const x0 = rect.left + rect.width / 2;
      const y0 = rect.top + Math.min(140, Math.max(36, rect.height / 2));
      const steps = 5;
      fireTouch(el, "start", x0, y0);
      for (let i = 1; i <= steps; i += 1) {
        fireTouch(el, "move", x0 + (dx * i) / steps, y0 + (dy * i) / steps);
      }
      fireTouch(el, "end", x0 + dx, y0 + dy);
    }
    window.__swipeDay = (dx, dy = 0) => swipe(document.querySelector('[data-testid="trip-content"]'), dx, dy);
    window.__swipeChips = (dx) => swipe(document.querySelector(".day-chips"), dx, 0);
    window.__trackX = () => {
      const track = document.querySelector("[data-role='day-track']");
      const t = getComputedStyle(track).transform;
      if (!t || t === "none") return 0;
      const parts = t
        .replace(/^matrix(3d)?\(/, "")
        .replace(/\)$/, "")
        .split(",")
        .map((n) => Number(n.trim()));
      return parts.length === 16 ? parts[12] : parts[4];
    };
  });
}

function meterFor(page) {
  const counts = { dataGets: 0, auth: 0 };
  const onRequest = (req) => {
    const href = req.url();
    if (!href.includes("supabase.co")) return;
    if (href.includes("/auth/v1/user")) counts.auth += 1;
    if (href.includes("/rest/v1/") && req.method() === "GET") {
      const table = new URL(href).pathname.split("/").filter(Boolean).pop();
      if (DATA_TABLES.has(table)) counts.dataGets += 1;
    }
  };
  page.on("request", onRequest);
  return {
    reset() {
      counts.dataGets = 0;
      counts.auth = 0;
    },
    snapshot() {
      return { ...counts };
    },
  };
}

async function openSwipeTrip(page) {
  await page.locator(`[data-vacation-id="${TRIP}"]`).click();
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.waitForFunction(
    (iso) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === iso,
    FIRST
  );
  await page.waitForSelector("[data-page='current'] .oc--selected", { timeout: 15_000 });
}

async function waitNeighbor(page, which, iso) {
  await page.waitForFunction(
    ({ slot, day }) => {
      const pageEl = document.querySelector(`[data-page="${slot}"]`);
      if (!day) return pageEl && !pageEl.dataset.swipeDay && pageEl.childElementCount === 0;
      return pageEl?.dataset.swipeDay === day && pageEl.childElementCount > 0;
    },
    { slot: which, day: iso || "" },
    { timeout: 15_000 }
  );
}

async function runSuite(browserType, baseUrl, label) {
  const browser = await browserType.launch({ headless: true });
  const ctx = await browser.newContext({ ...iphoneContext(), baseURL: baseUrl });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await installGestureHelpers(page);
  const state = createMockSupabaseState();
  seedSwipeTrip(state);
  allowMediaMove(state);
  await installSupabaseMocks(page, state);
  const meter = meterFor(page);

  await login(page, baseUrl);
  await openSwipeTrip(page);
  await waitNeighbor(page, "next", shiftIso(FIRST, 1));

  const neighborIds = await page.locator("[data-page='prev'] [data-testid], [data-page='next'] [data-testid]").count();
  assert(neighborIds === 0, `${label}: Nachbartage tragen Test-IDs (${neighborIds})`);

  const selectedBefore = await page.locator("[data-page='current'] .oc--selected").getAttribute("data-place-id");
  const other = page.locator("[data-page='current'] .oc[data-place-id]:not(.oc--selected)").first();
  const otherId = await other.getAttribute("data-place-id");
  assert(otherId && otherId !== selectedBefore, `${label}: zweite Karte fehlt`);
  await other.click();
  await page.waitForFunction(
    (id) => document.querySelector("[data-page='current'] .oc--selected")?.dataset.placeId === id,
    otherId
  );

  await page.locator("[data-page='current'] .oc--selected [data-action='add-note']").click();
  await page.waitForSelector('[data-testid="note-sheet"] textarea');
  const draftText = "Fenster bleibt";
  await page.locator('[data-testid="note-sheet"] textarea').fill(draftText);

  await page.evaluate(() => {
    const host = document.querySelector("[data-page='current']");
    const area = document.createElement("textarea");
    area.dataset.testid = "day-draft";
    area.value = "Ungespeichert im Tag";
    host.appendChild(area);
    area._keep = "bleibt";
  });

  await page.evaluate(() => window.__swipeDay(-180));
  await page.waitForFunction(
    (iso) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === iso,
    shiftIso(FIRST, 1)
  );
  const sheetDuring = await page.locator('[data-testid="note-sheet"] textarea').inputValue();
  assert(sheetDuring === draftText, `${label}: Notizfenster verliert den Text beim Wisch (${sheetDuring})`);

  await page.waitForFunction(() => {
    const root = document.querySelector('[data-testid="trip-content"]');
    return root?.dataset.swipeLock !== "1" && root?.dataset.gesture !== "1";
  });
  await page.evaluate(() => window.__swipeDay(180));
  await page.waitForFunction(
    (iso) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === iso,
    FIRST
  );
  const kept = await page.evaluate(() => {
    const area = document.querySelector("[data-page='current'] [data-testid='day-draft']");
    const selected = document.querySelector("[data-page='current'] .oc--selected")?.dataset.placeId || "";
    return { value: area?.value || "", keep: area?._keep || "", selected };
  });
  assert(kept.keep === "bleibt", `${label}: Tagesseite wurde neu aufgebaut statt übernommen`);
  assert(kept.value === "Ungespeichert im Tag", `${label}: Eingabe auf der Tagesseite ist weg`);
  assert(kept.selected === otherId, `${label}: Auswahl ist nach dem Zurückwischen weg (${kept.selected})`);
  const sheetAfter = await page.locator('[data-testid="note-sheet"] textarea').inputValue();
  assert(sheetAfter === draftText, `${label}: Notizfenster ist nach dem Zurückwischen weg`);
  await page.locator('[data-testid="note-sheet"] [data-action="cancel"]').click();
  await page.locator('[data-testid="confirm-discard-note"] [data-action="confirm"]').click();
  await page.waitForSelector('[data-testid="note-sheet"]', { state: "detached" });

  for (const iso of DAYS) {
    await page.locator(`.day-chip[data-day="${iso}"]`).click();
    await page.waitForFunction(
      (day) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === day,
      iso
    );
    await page.waitForSelector("[data-page='current'] .oc", { timeout: 15_000 });
  }
  await page.locator(`.day-chip[data-day="${FIRST}"]`).click();
  await page.waitForFunction(
    (iso) => {
      const root = document.querySelector('[data-testid="trip-content"]');
      const next = document.querySelector("[data-page='next']");
      return root?.dataset.activeDay === iso && root.dataset.swipeLock !== "1" && next?.dataset.swipeDay === "2026-11-09";
    },
    FIRST
  );

  meter.reset();
  await page.waitForTimeout(500);
  const idle = meter.snapshot();
  assert(idle.dataGets === 0, `${label}: Nachbarseiten laden nach dem Cache weiter (${idle.dataGets})`);
  assert(idle.auth === 0, `${label}: Nachbarseiten fragen Auth ab (${idle.auth})`);

  meter.reset();
  const burst = await page.evaluate(async (days) => {
    const root = document.querySelector('[data-testid="trip-content"]');
    const seen = [];
    const push = () => {
      const day = root.dataset.activeDay || "";
      if (seen[seen.length - 1]?.day !== day) seen.push({ day, lock: root.dataset.swipeLock || "" });
    };
    const obs = new MutationObserver(push);
    obs.observe(root, { attributes: true, attributeFilter: ["data-active-day"] });
    push();
    for (let i = 0; i < 4; i += 1) {
      if (i) await new Promise((resolve) => setTimeout(resolve, 400));
      window.__swipeDay(-180);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    push();
    obs.disconnect();
    return {
      seen: seen.map((entry) => entry.day),
      final: root.dataset.activeDay || "",
      lock: root.dataset.swipeLock || "",
      expected: days,
    };
  }, DAYS);
  assert(burst.lock !== "1", `${label}: Sperre bleibt nach der Wischfolge (${burst.lock})`);
  assert(
    burst.seen.join(",") === DAYS.join(","),
    `${label}: schnelle Wische kommen nicht an (${burst.seen.join(" → ")})`
  );
  assert(burst.final === DAYS[4], `${label}: letzter Tag ist ${burst.final}`);
  const duringBurst = meter.snapshot();
  assert(duringBurst.dataGets === 0, `${label}: schnelle Wische fragen Daten nach (${duringBurst.dataGets})`);
  assert(duringBurst.auth === 0, `${label}: schnelle Wische fragen Auth ab (${duringBurst.auth})`);

  await page.waitForFunction(() => {
    const current = document.querySelector("[data-page='current']");
    return current?.dataset.swipeDay === "2026-11-12" && current.querySelector(".oc");
  });

  const chipBar = await page.evaluate(() => {
    const chips = document.querySelector(".day-chips");
    const wrap = document.querySelector(".day-chips-wrap");
    const pageEl = document.querySelector("[data-page='current']");
    const chipCss = getComputedStyle(chips);
    const wrapCss = getComputedStyle(wrap);
    const pageCss = getComputedStyle(pageEl);
    return {
      chipTouch: chipCss.touchAction,
      chipOverflowY: chipCss.overflowY,
      wrapTouch: wrapCss.touchAction,
      pageTouch: pageCss.touchAction,
      pageOverflowY: pageCss.overflowY,
      scrollWidth: chips.scrollWidth,
      clientWidth: chips.clientWidth,
    };
  });
  assert(chipBar.chipTouch.includes("pan-x"), `${label}: Chip-Leiste ohne pan-x (${chipBar.chipTouch})`);
  assert(chipBar.wrapTouch.includes("pan-x"), `${label}: Chip-Rahmen ohne pan-x (${chipBar.wrapTouch})`);
  assert(chipBar.chipOverflowY === "hidden", `${label}: Chip-Leiste scrollt vertikal (${chipBar.chipOverflowY})`);
  assert(chipBar.pageTouch.includes("pan-y"), `${label}: Tagesseite ohne vertikales Scrollen (${chipBar.pageTouch})`);
  assert(
    chipBar.pageOverflowY === "auto" || chipBar.pageOverflowY === "scroll",
    `${label}: Tagesseite overflow-y ${chipBar.pageOverflowY}`
  );
  assert(chipBar.scrollWidth > chipBar.clientWidth + 8, `${label}: Chip-Leiste hat nichts zu scrollen`);

  const chipSwipe = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="trip-content"]');
    const beforeDay = root.dataset.activeDay;
    const beforeX = window.__trackX();
    window.__swipeChips(-120);
    const chips = document.querySelector(".day-chips");
    const beforeLeft = chips.scrollLeft;
    const target = beforeLeft > 12 ? beforeLeft - 48 : beforeLeft + 48;
    chips.scrollLeft = target;
    return {
      day: root.dataset.activeDay,
      gesture: root.dataset.gesture || "",
      lock: root.dataset.swipeLock || "",
      beforeX,
      afterX: window.__trackX(),
      beforeLeft,
      afterLeft: chips.scrollLeft,
      scrolled: Math.abs(chips.scrollLeft - beforeLeft) > 8,
    };
  });
  assert(chipSwipe.day === DAYS[4], `${label}: Chip-Wisch wechselt den Tag`);
  assert(chipSwipe.gesture !== "1" && chipSwipe.lock !== "1", `${label}: Chip-Wisch startet den Tageswechsel`);
  assert(Math.abs(chipSwipe.afterX - chipSwipe.beforeX) < 2, `${label}: Chip-Wisch verschiebt die Tagesseite`);
  assert(
    chipSwipe.scrolled,
    `${label}: Chip-Leiste scrollt nicht horizontal (${chipSwipe.beforeLeft} → ${chipSwipe.afterLeft})`
  );

  const vertical = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="trip-content"]');
    const pageEl = document.querySelector("[data-page='current']");
    const spacer = document.createElement("div");
    spacer.style.height = "900px";
    pageEl.appendChild(spacer);
    const beforeDay = root.dataset.activeDay;
    const beforeX = window.__trackX();
    window.__swipeDay(6, 140);
    pageEl.scrollTop = 160;
    return {
      day: root.dataset.activeDay,
      beforeX,
      afterX: window.__trackX(),
      scrollTop: pageEl.scrollTop,
    };
  });
  assert(vertical.day === DAYS[4], `${label}: vertikaler Zug wechselt den Tag`);
  assert(Math.abs(vertical.afterX - vertical.beforeX) < 4, `${label}: vertikaler Zug verschiebt die Seite`);
  assert(vertical.scrollTop >= 40, `${label}: Tagesseite scrollt nicht vertikal`);

  await page.locator(`.day-chip[data-day="${FIRST}"]`).click();
  await page.waitForFunction(
    (iso) => document.querySelector("[data-page='current']")?.dataset.swipeDay === iso,
    FIRST
  );
  await page.locator("[data-page='current'] [data-place-id='sw-alpha']").click();
  await page.waitForSelector("[data-page='current'] .oc--selected[data-place-id='sw-alpha'] [data-testid='photo-select-start']");
  await page.locator("[data-page='current'] [data-testid='photo-select-start']").click();
  await page.waitForSelector("[data-page='current'] [data-testid='photo-select-bar']");
  await page.locator("[data-page='current'] [data-testid='place-photo'][data-media-id='m-mon']").click();
  await page.waitForFunction(
    () => (document.querySelector("[data-page='current'] [data-testid='photo-select-count']")?.textContent || "").includes("1 ausgewählt")
  );
  for (let step = 1; step <= 3; step += 1) {
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-testid="trip-content"]');
      return root?.dataset.swipeLock !== "1" && root?.dataset.gesture !== "1";
    });
    await page.evaluate(() => window.__swipeDay(-180));
    await page.waitForFunction(
      (iso) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === iso,
      DAYS[step]
    );
  }
  const leaked = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="trip-content"]');
    const current = document.querySelector("[data-page='current']");
    return {
      day: root?.dataset.activeDay || "",
      selecting: root?.dataset.photoSelecting || "",
      bar: current?.querySelector("[data-testid='photo-select-bar']")?.textContent || "",
    };
  });
  assert(leaked.day === DAYS[3], `${label}: dritter Wisch landet auf ${leaked.day}`);
  assert(leaked.selecting !== "1", `${label}: Auswahl vom ersten Tag ist auf einem anderen Tag an`);
  assert(!leaked.bar.includes("ausgewählt"), `${label}: alte Auswahl steht auf dem neuen Tag (${leaked.bar})`);
  await page.locator("[data-page='current'] [data-testid='photo-select-start']").click();
  await page.waitForSelector("[data-page='current'] [data-testid='photo-select-bar']");
  await page.locator("[data-page='current'] [data-testid='place-photo'][data-media-id='m-thu']").click();
  const count = await page.locator("[data-page='current'] [data-testid='photo-select-count']").innerText();
  assert(count.includes("1 ausgewählt"), `${label}: neues Foto zählt die alte Auswahl mit (${count})`);
  assert(!count.includes("2 ausgewählt"), `${label}: Zähler ist ${count}`);
  await page.locator("[data-page='current'] [data-testid='photo-select-exit']").click();
  await page.waitForSelector("[data-page='current'] [data-testid='photo-select-bar']", { state: "detached" });

  await page.locator(`.day-chip[data-day="${DAYS[1]}"]`).click();
  await page.waitForFunction(
    (iso) => document.querySelector("[data-page='current']")?.dataset.swipeDay === iso,
    DAYS[1]
  );
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-testid="trip-content"]');
    return root?.dataset.swipeLock !== "1" && root?.dataset.canPrev === "1";
  });
  await page.evaluate(() => window.__swipeDay(180));
  await page.waitForFunction(
    (iso) => document.querySelector("[data-page='current']")?.dataset.swipeDay === iso,
    FIRST
  );
  await page.locator("[data-page='current'] [data-place-id='sw-alpha']").click();
  await page.waitForSelector("[data-page='current'] .oc--selected[data-place-id='sw-alpha'] [data-testid='photo-select-start']");
  await page.locator("[data-page='current'] [data-testid='photo-select-start']").click();
  await page.locator("[data-page='current'] [data-testid='place-photo'][data-media-id='m-mon']").click();
  await page.locator("[data-page='current'] [data-testid='photo-move']").click();
  await page.waitForSelector('[data-testid="photo-move-sheet"]');
  await page.locator(`[data-move-day="${DAYS[1]}"]`).click();
  await page.locator('[data-move-place="sw-gamma"]').click();
  await page.waitForSelector('[data-testid="app-toast"]');
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-testid="trip-content"]');
    return root?.dataset.swipeLock !== "1" && root?.dataset.gesture !== "1";
  });
  await page.evaluate(() => window.__swipeDay(-180));
  await page.waitForFunction(
    (iso) => document.querySelector("[data-page='current']")?.dataset.swipeDay === iso,
    DAYS[1]
  );
  const movedVisible = await page.locator("[data-page='current'] [data-testid='place-photo'][data-media-id='m-mon']").count();
  assert(movedVisible > 0, `${label}: verschobenes Foto fehlt auf der schon besuchten Seite`);

  const realErrors = errors.filter((err) => !/access control checks/i.test(err));
  assert(realErrors.length === 0, `${label}: ${realErrors[0]}`);
  await browser.close();
  console.log(`perf-p2 day-swipe ${label} OK`);
}

async function main() {
  const { server, baseUrl } = await startServer();
  try {
    await runSuite(chromium, baseUrl, "chromium");
    await runSuite(webkit, baseUrl, "webkit");
  } finally {
    server.close();
  }
  console.log("Playwright perf-p2 day-swipe OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
