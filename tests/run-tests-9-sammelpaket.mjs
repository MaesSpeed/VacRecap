import { readdir, readFile, mkdir } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, webkit } from "playwright";
import { countMaterialPhotos } from "../js/recap-storyboard.js";
import {
  TRIP,
  USER,
  createMockSupabaseState,
  installSupabaseMocks,
  startServer,
} from "./run-tests-12b-recap-video.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";

function resolveShotDir() {
  const candidates = [
    process.env.VACRECAP_SHOTS,
    path.join(__dirname, "artifacts"),
    path.join(os.tmpdir(), "vacrecap-paket9"),
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
const VIEWPORTS = [
  { width: 375, height: 667, name: "375x667" },
  { width: 360, height: 740, name: "360x740" },
  { width: 390, height: 844, name: "390x844" },
];
const PARIS = "trip-paris";
const NOW = "trip-jetzt";
const BLANK = "trip-blank";
const OTHER = "22222222-2222-2222-2222-222222222222";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const SIE = /\b(Sie|Ihr|Ihre|Ihren|Ihrem|Ihnen)\b/;
const GENDER = /\w:in\b|\w\*in\b|\/innen|Innen\b/;

async function filesIn(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesIn(full)));
    else out.push(full);
  }
  return out;
}

function toneHits(file, text) {
  const hits = [];
  text.split("\n").forEach((line, index) => {
    if (SIE.test(line)) hits.push(`${file}:${index + 1} Sie/Ihr «${line.trim()}»`);
    if (!GENDER.test(line)) return;
    const allowed = file.endsWith(`${path.sep}js${path.sep}vacation.js`) && line.includes('label: "Partner:in"');
    if (!allowed) hits.push(`${file}:${index + 1} Gendern «${line.trim()}»`);
  });
  return hits;
}

async function assertTone() {
  const files = [...(await filesIn(path.join(root, "js"))).filter((file) => file.endsWith(".js")), path.join(root, "index.html"), path.join(root, "manifest.webmanifest")];
  const hits = [];
  for (const file of files) hits.push(...toneHits(file, await readFile(file, "utf8")));
  assert(!hits.length, hits.slice(0, 6).join(" | "));
  assert(toneHits("probe.js", "Bitte deine Fotos prüfen").length === 0, "du-Form");
  assert(toneHits("probe.js", "Bitte Ihre Fotos prüfen").length === 1, "Ihre wird nicht erkannt");
  assert(toneHits("probe.js", 'label: "Freund:in"').length === 1, "Freund:in wird nicht erkannt");
  assert(!toneHits(path.join(root, "js", "vacation.js"), '  { id: "partner", label: "Partner:in" },').length, "Partner:in");
  const sql = await readFile(path.join(root, "docs/supabase/paket-9-avatar-farbe.sql"), "utf8");
  const fn = sql.slice(sql.indexOf("select case"), sql.indexOf("else (array"));
  const prefix = fn.indexOf("~ '^dom'");
  const separated = fn.indexOf("~ '(^|[._ -])dom'");
  assert(prefix >= 0 && separated > prefix, "Namensanfang vor Trenner");
  const color = (name) => {
    const n = String(name || "").toLowerCase();
    if (/^dom/.test(n)) return "#0066b3";
    if (/^sabine/.test(n)) return "#D64541";
    if (/^anna/.test(n)) return "#1F9D57";
    if (/(^|[._ -])dom/.test(n)) return "#0066b3";
    if (/(^|[._ -])sabine/.test(n)) return "#D64541";
    if (/(^|[._ -])anna/.test(n)) return "#1F9D57";
    return "palette";
  };
  assert(color("roeder.domi") === "#0066b3", "roeder.domi");
  assert(color("Anna Domke") === "#1F9D57", "Anna Domke");
  assert(color("Sabine Dombrowski") === "#D64541", "Sabine Dombrowski");
  assert(color("iammrspeed") === "palette", "iammrspeed");
  assert(color("Dom") === "#0066b3" && color("Sabine") === "#D64541", "Namensanfang");
  console.log("Ton-Test grün (Ihre und Freund:in wären rot)");
}

function tripRow(id, title, start, end, extra = {}) {
  return {
    id,
    title,
    start_date: start,
    end_date: end,
    created_at: `${start}T00:00:00.000Z`,
    updated_at: `${end}T00:00:00.000Z`,
    created_by: USER,
    companions: [],
    companion_tags: [],
    cover_media_id: null,
    cover_preset: "stadt",
    deleted_at: null,
    ...extra,
  };
}

function extendState(state) {
  state.trips.push(
    tripRow(PARIS, "Paris", "2026-12-12", "2026-12-15", {
      companions: ["Dominik Röder"],
      companion_tags: ["partner", "familie", "freunde"],
    })
  );
  state.trips.push(
    tripRow(NOW, "Jetzt unterwegs", "2026-10-26", "2026-11-02", {
      companion_tags: ["partner", "familie", "freunde"],
    })
  );
  state.trips.push(tripRow(BLANK, "Leer", "2026-10-28", "2026-10-29"));
  const garda = state.trips.find((row) => row.id === TRIP);
  if (garda) garda.companions = ["Dominik Röder", "Sabine Röder"];
  state.media.push({
    id: "loose-photo",
    trip_id: TRIP,
    waypoint_id: null,
    day: "2025-06-16",
    taken_at: "2025-06-16T18:00:00.000Z",
    kind: "photo",
    storage_path: "orig/loose.jpg",
    thumb_path: "loose.jpg",
    mime: "image/jpeg",
    upload_status: "uploaded",
    deleted_at: null,
    created_at: "2025-06-16T18:00:00.000Z",
    updated_at: "2025-06-16T18:00:00.000Z",
    created_by: USER,
  });
  state.failReads = false;
  state.failReadsAfterPlace = false;
  state.failAssignable = false;
  state.signFails = 0;
  state.roleFails = 0;
  state.people = null;
  const rest = state.handleRest.bind(state);
  const storage = state.handleStorage.bind(state);
  state.handleStorage = (url, method, body) => {
    if (url.pathname.includes("/object/sign/") && method === "POST" && state.signFails > 0) {
      state.signFails -= 1;
      return { status: 500, json: { message: "sign failed" } };
    }
    return storage(url, method, body);
  };
  state.handleRest = async (url, method, body, headers) => {
    const table = url.pathname.split("/").filter(Boolean).pop();
    if (method === "GET" && state.failReads && ["trips", "waypoints", "notes", "media", "trip_members", "trip_recaps"].includes(table)) {
      return { status: 500, json: { message: "Interner Fehler", code: "500" } };
    }
    if (method === "GET" && state.failAssignable && (table === "media" || table === "notes")) {
      return { status: 500, json: { message: "Interner Fehler" } };
    }
    if (method === "GET" && table === "trip_members" && state.roleFails > 0) {
      state.roleFails -= 1;
      return { status: 500, json: { message: "Rolle nicht geladen" } };
    }
    if (url.pathname.includes("list_trip_people")) {
      return { status: 200, json: state.people || [] };
    }
    if (url.pathname.endsWith("/rpc/invite_to_trip")) {
      const payload = JSON.parse(body || "{}");
      return {
        status: 200,
        json: (payload.p_invites || []).map((item) => ({ email: item.email, result: "invited" })),
      };
    }
    if (url.pathname.endsWith("/rpc/list_my_trip_invites") || url.pathname.endsWith("/rpc/list_trip_presence")) {
      return { status: 200, json: [] };
    }
    if (table === "waypoints" && method === "POST") {
      const row = JSON.parse(body || "{}");
      const full = {
        id: row.id || crypto.randomUUID(),
        created_at: "2026-10-30T10:00:00.000Z",
        updated_at: "2026-10-30T10:00:00.000Z",
        deleted_at: null,
        is_soft: false,
        lat: null,
        lng: null,
        ...row,
      };
      state.waypoints.push(full);
      if (state.failReadsAfterPlace) state.failReads = true;
      const accept = headers.accept || "";
      return { status: 201, json: accept.includes("application/vnd.pgrst.object+json") ? full : [full] };
    }
    if (table === "trips" && (method === "PATCH" || method === "POST")) {
      const row = JSON.parse(body || "{}");
      const idParam = url.searchParams.get("id") || "";
      const id = row.id || idParam.replace(/^eq\./, "");
      let existing = state.trips.find((item) => item.id === id);
      if (!existing) {
        existing = tripRow(id || crypto.randomUUID(), row.title || "Reise", row.start_date, row.end_date);
        state.trips.push(existing);
      }
      Object.assign(existing, row, { updated_at: "2026-10-30T12:00:00.000Z" });
      const accept = headers.accept || "";
      return { status: 200, json: accept.includes("application/vnd.pgrst.object+json") ? existing : [existing] };
    }
    return rest(url, method, body, headers);
  };
}

async function installNetworkAbort(page, state) {
  await page.context().route(`**/${SUPABASE_HOST}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (state.networkReads && route.request().method() === "GET" && url.pathname.includes("/rest/v1/trips")) {
      await route.abort("failed");
      return;
    }
    await route.fallback();
  });
}

async function freezeClock(page) {
  await page.addInitScript(() => {
    const RealDate = Date;
    const fixed = Date.parse("2026-10-30T10:00:00.000Z");
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
    const seeded = sessionStorage.getItem("paket9-diary");
    if (seeded) {
      sessionStorage.removeItem("paket9-diary");
      localStorage.setItem("vr-diary-source:trip-garda", seeded);
    }
  });
}

async function login(page, baseUrl) {
  await submitOtp(page, baseUrl);
  await page.waitForSelector(".screen--urlaube");
}

async function shot(page, name) {
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function clickDay(page, iso) {
  await page.waitForSelector(`.day-chips [data-day="${iso}"]`);
  await page.evaluate((day) => {
    document.querySelector(`.day-chips [data-day="${day}"]`)?.click();
  }, iso);
  try {
    await page.waitForFunction(
      (day) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === day,
      iso,
      { timeout: 5000 }
    );
    return;
  } catch {
    const last = await page.evaluate(() => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay || "");
    console.error(`clickDay: erster Tipp auf ${iso} wirkte nicht (aktiv «${last || "—"}»), zweiter Versuch`);
    await page.evaluate((day) => {
      document.querySelector(`.day-chips [data-day="${day}"]`)?.click();
    }, iso);
    await page
      .waitForFunction(
        (day) => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === day,
        iso,
        { timeout: 5000 }
      )
      .catch(() => {});
    throw new Error(`clickDay: erster Tipp auf ${iso} wirkte nicht (aktiv «${last || "—"}»)`);
  }
}

async function openTrip(page, id = TRIP) {
  await page.waitForSelector(`[data-vacation-id="${id}"]`);
  await page.evaluate((tripId) => {
    document.querySelector(`[data-vacation-id="${tripId}"]`)?.click();
  }, id);
  await page.waitForSelector('[data-testid="trip-content"]');
}

function installGestures(page) {
  return page.addInitScript(() => {
    const gesture = { el: null, x0: 0, y0: 0, x: 0 };
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
        const touch = new Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y });
        const list = ended ? [] : [touch];
        el.dispatchEvent(new TouchEvent(touchType, { bubbles: true, cancelable: true, touches: list, targetTouches: list, changedTouches: [touch] }));
        return;
      }
      const touch = document.createTouch(window, el, 1, x + window.scrollX, y + window.scrollY, x, y);
      const list = document.createTouchList(touch);
      const empty = document.createTouchList();
      el.dispatchEvent(new TouchEvent(touchType, { bubbles: true, cancelable: true, touches: ended ? empty : list, targetTouches: ended ? empty : list, changedTouches: list }));
    }
    window.__down = () => {
      const el = document.querySelector('[data-testid="trip-content"]');
      const rect = el.getBoundingClientRect();
      gesture.el = el;
      gesture.x0 = rect.left + rect.width / 2;
      gesture.y0 = rect.top + Math.min(120, Math.max(28, rect.height / 2));
      gesture.x = gesture.x0;
      fireTouch(el, "start", gesture.x0, gesture.y0);
    };
    window.__move = (dx) => {
      gesture.x = gesture.x0 + dx;
      fireTouch(gesture.el, "move", gesture.x, gesture.y0);
    };
    window.__up = () => fireTouch(gesture.el, "end", gesture.x, gesture.y0);
  });
}

async function submitOtp(page, baseUrl) {
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
}

async function layoutPass(page, state, label, { shots }) {
  await page.waitForSelector(`[data-vacation-id="${PARIS}"]`);
  const paris = await page.locator(`[data-vacation-id="${PARIS}"]`).innerText();
  assert(paris.includes("in 43 Tagen"), `${label}: Countdown «${paris}»`);
  assert(!paris.includes("Monat"), `${label}: Monat im Countdown`);
  assert(!/\d Tage/.test(paris.split("\n").find((line) => line.includes("12.12")) || ""), `${label}: Tageszahl hinter dem Datum «${paris}»`);
  assert((await page.locator(".card-compact__chevron").count()) === 0, `${label}: Chevron`);
  const letter = await page.locator(`[data-vacation-id="${PARIS}"] .avatar`).first().innerText();
  assert(letter.trim() === "D", `${label}: Initialen «${letter}»`);

  const tags = await page.locator(".card .companion-line").evaluateAll((lines) =>
    lines.map((line) => {
      const pills = [...line.querySelectorAll(".companion-pill")];
      const visible = pills.filter((pill) => !pill.hidden);
      const one = visible[0]?.getBoundingClientRect().height || 0;
      const box = line.getBoundingClientRect();
      const more = line.querySelector(".companion-pill--more");
      return {
        height: box.height,
        one,
        fits: line.scrollWidth <= line.clientWidth + 1,
        clipped: visible.some((pill) => pill.scrollWidth > pill.clientWidth + 1),
        more: more ? more.textContent : "",
        label: more?.getAttribute("aria-label") || "",
        card: line.closest("article")?.className || "",
      };
    })
  );
  assert(tags.length >= 2, `${label}: Tag-Zeilen ${tags.length}`);
  for (const line of tags) {
    assert(line.one > 0 && line.height <= line.one + 1, `${label}: Tag-Zeile umbrochen ${JSON.stringify(line)}`);
    assert(line.fits && !line.clipped, `${label}: Tag abgeschnitten ${JSON.stringify(line)}`);
    if (line.more) assert(line.more.startsWith("+") && line.label, `${label}: +N ohne Namen`);
  }

  await openTrip(page);
  const names = await page.locator('[data-testid="trip-companions"]').innerText();
  assert(names.includes("Dominik Röder") && names.includes("Sabine Röder"), `${label}: Namenszeile «${names}»`);
  await clickDay(page, "2025-06-16");
  const caption = page.locator('[data-page="current"] [data-testid="photo-caption-edit"]:has(img)').first();
  await caption.waitFor();
  const aligned = await caption.evaluate((btn) => {
    const mid = (el) => {
      const box = el.getBoundingClientRect();
      return box.top + box.height / 2;
    };
    const img = mid(btn.querySelector("img"));
    const icon = mid(btn.querySelector("svg"));
    const text = mid(btn.querySelector(".notes-add__label"));
    const after = getComputedStyle(btn, "::after");
    return {
      img,
      icon,
      text,
      hit: Math.max(parseFloat(after.height) || 0, btn.getBoundingClientRect().height),
      btn: btn.getBoundingClientRect().height,
      afterH: after.height,
      content: document.querySelector('[data-testid="trip-content"]')?.getBoundingClientRect().height,
    };
  });
  assert(Math.abs(aligned.img - aligned.icon) <= 1 && Math.abs(aligned.img - aligned.text) <= 1, `${label}: Notiz-Button ${JSON.stringify(aligned)}`);
  assert(aligned.hit >= 44, `${label}: Tippfläche ${JSON.stringify(aligned)}`);

  const qa = await page.locator('[data-page="current"] .qa').first().evaluate((el) => {
    const style = getComputedStyle(el);
    const buttons = [...el.querySelectorAll(".qa__btn")];
    const boxes = buttons.map((btn) => {
      const box = btn.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width, height: box.height };
    });
    const hits = buttons.map((btn) => {
      const cs = getComputedStyle(btn, "::after");
      return { content: cs.content, width: cs.width, height: cs.height, position: cs.position };
    });
    return {
      gap: style.gap,
      columnGap: style.columnGap,
      display: style.display,
      space: boxes.length > 1 ? boxes[1].left - boxes[0].right : null,
      boxes,
      hits,
      overflow: el.scrollWidth <= el.clientWidth + 1,
      scroll: [el.scrollWidth, el.clientWidth],
      trace: window.__trace?.slice(-12),
      connected: el.isConnected,
    };
  });
  assert(Math.abs(parseFloat(qa.gap) - 8) < 0.5 && Math.abs(qa.space - 8) < 1, `${label}: qa-Abstand ${JSON.stringify(qa)}`);
  assert(qa.hits.every((hit) => parseFloat(hit.width) >= 44 && parseFloat(hit.height) >= 44), `${label}: qa-Treffer ${JSON.stringify(qa.hits)}`);
  assert(qa.overflow && qa.scroll[0] <= qa.scroll[1] + 1, `${label}: qa-Überlauf`);

  await clickDay(page, "2025-06-20");
  await page.waitForSelector('[data-testid="recap-create"]');
  const banner = await page.locator('[data-testid="recap-create"]').evaluate((btn) => {
    const style = getComputedStyle(btn);
    return {
      icon: Boolean(btn.querySelector("svg")),
      justify: style.justifyContent,
      align: style.alignItems,
      bg: style.backgroundColor,
      text: style.textAlign,
    };
  });
  assert(banner.icon, `${label}: Banner ohne Icon`);
  assert(banner.justify === "flex-start" || banner.justify === "start", `${label}: Banner ${banner.justify}`);
  assert(banner.bg === "rgb(255, 255, 255)", `${label}: Banner-Hintergrund ${banner.bg}`);
  if (shots) {
    await shot(page, "u6-p1-banner");
    await page.locator('[data-action="back"]').click();
    await page.waitForSelector(".screen--urlaube");
    await shot(page, "u6-reisekarte");
    await openTrip(page);
    await clickDay(page, "2025-06-16");
    await page.waitForSelector('[data-testid="photo-caption-edit"]');
    await shot(page, "u1-notiz-button");
  } else {
    await page.locator('[data-action="back"]').click();
    await page.waitForSelector(".screen--urlaube");
  }
}

async function openAddPlace(page) {
  await page.evaluate(async () => {
    const { openAddPlaceFlow } = await import("./js/ui-add-place-sheet.js");
    const { getVacation } = await import("./js/db.js");
    const vacation = await getVacation("trip-blank");
    window.__place = openAddPlaceFlow({
      vacation,
      vacationId: vacation.id,
      day: vacation.startDate,
      lat: 45.8,
      lng: 10.8,
      userId: "11111111-1111-1111-1111-111111111111",
    });
  });
  await page.waitForSelector('[data-testid="add-place-sheet"]');
}

async function placeGap(page) {
  return page.evaluate(() => {
    const field = document.querySelector('[data-testid="add-place-time"]')?.closest(".field");
    const chips = document.querySelector('[data-testid="add-place-parts"]');
    if (!field || !chips) return null;
    return chips.getBoundingClientRect().top - field.getBoundingClientRect().bottom;
  });
}

async function behaviorPass(page, state, label, { shots }) {
  await page.evaluate(() => {
    window.location.hash = "#/urlaube";
  });
  await page.waitForSelector(".screen--urlaube");
  state.failAssignable = true;
  await openTrip(page);
  await openAddPlace(page);
  const withHint = await placeGap(page);
  assert(withHint >= 12, `${label}: Uhrzeit-Abstand ${withHint}`);
  await page.evaluate(() => {
    const hint = document.querySelector('[data-testid="add-place-time-hint"]');
    if (hint) hint.style.display = "none";
  });
  const withoutHint = await placeGap(page);
  assert(withoutHint >= 12, `${label}: Uhrzeit-Abstand ohne Hinweis ${withoutHint}`);
  if (shots) await shot(page, "u3-uhrzeit");
  await page.click('[data-testid="add-place-part"]');
  await page.click('[data-testid="add-place-next"]');
  await page.waitForSelector('[data-testid="add-place-load-hint"]', { timeout: 8000 });
  assert((await page.locator(".pick-empty").count()) === 0, `${label}: Leertext neben dem Ladefehler`);
  state.failAssignable = false;
  await page.click('[data-testid="add-place-cancel"]').catch(() => {});
  await page.evaluate(() => document.getElementById("overlay-root") && (document.getElementById("overlay-root").hidden = true));

  await page.evaluate(() => {
    window.location.hash = "#/urlaube";
  });
  await page.waitForSelector(".screen--urlaube");
  state.failAssignable = false;
  await page.evaluate(async () => {
    const { openAddPlaceFlow } = await import("./js/ui-add-place-sheet.js");
    const { getVacation } = await import("./js/db.js");
    const vacation = await getVacation("trip-blank");
    window.__place = openAddPlaceFlow({
      vacation,
      vacationId: vacation.id,
      day: vacation.startDate,
      lat: 45.8,
      lng: 10.8,
      userId: "11111111-1111-1111-1111-111111111111",
    });
  });
  await page.waitForSelector('[data-testid="add-place-sheet"]');
  await page.click('[data-testid="add-place-part"]');
  await page.click('[data-testid="add-place-next"]');
  await page.waitForSelector(".pick-empty", { timeout: 8000 });
  assert((await page.locator('[data-testid="add-place-load-hint"]').count()) === 0, `${label}: Leertext gilt als Fehler`);
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => {
    const root = document.getElementById("overlay-root");
    if (root) {
      root.hidden = true;
      root.innerHTML = "";
    }
  });

  await openTrip(page);
  await clickDay(page, "2025-06-16");
  await page.waitForSelector(".day-chip");
  const width = await page.evaluate(() => document.querySelector('[data-testid="trip-content"]').clientWidth);
  await page.evaluate(() => window.__down());
  await page.evaluate((dx) => window.__move(dx), 160);
  const startRubber = await page.evaluate(() => {
    const mark = document.querySelector("[data-testid='day-chip-mark']").getBoundingClientRect();
    const bar = document.querySelector(".day-chips-wrap").getBoundingClientRect();
    return { left: mark.left - bar.left, right: bar.right - mark.right, width: mark.width };
  });
  assert(startRubber.left >= -1 && startRubber.right >= -1, `${label}: Markierung am ersten Tag ${JSON.stringify(startRubber)}`);
  await page.evaluate(() => window.__up());
  await clickDay(page, "2025-06-20");
  await page.waitForFunction(() => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2025-06-20");
  await page.evaluate(() => window.__down());
  await page.evaluate((dx) => window.__move(dx), -160);
  const endRubber = await page.evaluate(() => {
    const mark = document.querySelector("[data-testid='day-chip-mark']").getBoundingClientRect();
    const bar = document.querySelector(".day-chips-wrap").getBoundingClientRect();
    return mark.left >= bar.left - 1 && mark.right <= bar.right + 1;
  });
  assert(endRubber, `${label}: Markierung am letzten Tag`);
  await page.evaluate(() => window.__up());

  await clickDay(page, "2025-06-16");
  await page.waitForFunction(() => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2025-06-16");
  await page.evaluate(() => {
    const row = document.querySelector(".day-chips");
    row.scrollLeft = row.scrollWidth;
  });
  await page.evaluate(() => window.__down());
  await page.evaluate((dx) => window.__move(dx), -Math.round(width * 0.3));
  const visible = await page.evaluate(() => {
    const row = document.querySelector(".day-chips").getBoundingClientRect();
    const chip = document.querySelector('.day-chip[data-day="2025-06-17"]').getBoundingClientRect();
    const active = document.querySelector(".day-chip--active");
    const style = active ? getComputedStyle(active) : null;
    return {
      full: chip.left >= row.left - 1 && chip.right <= row.right + 1,
      bg: style?.backgroundColor || "",
    };
  });
  assert(visible.full, `${label}: Ziel-Chip bei 30 % nicht sichtbar`);
  await page.evaluate(() => window.__up());

  const fractions = [0, 0.3, 0.6, 1];
  for (const frac of fractions) {
    await clickDay(page, "2025-06-17");
    await page.waitForFunction(() => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2025-06-17");
    if (frac === 0) {
      const bg = await page.locator(".day-chip--active").evaluate((el) => getComputedStyle(el).backgroundColor);
      assert(!/rgba\(255,\s*255,\s*255,\s*0\.[0-9]/.test(bg), `${label}: milchig bei 0 ${bg}`);
      continue;
    }
    await page.evaluate(() => window.__down());
    await page.evaluate((dx) => window.__move(dx), -Math.round(width * frac));
    const bg = await page.evaluate(() => {
      const chip = document.querySelector('.day-chip[data-day="2025-06-17"]');
      return getComputedStyle(chip).backgroundColor;
    });
    assert(!/rgba\(255,\s*255,\s*255,\s*0\.[0-9]/.test(bg), `${label}: milchig bei ${frac} ${bg}`);
    await page.evaluate(() => window.__up());
    await page.waitForTimeout(400);
  }
  if (shots) {
    await clickDay(page, "2025-06-17");
    await page.evaluate(() => window.__down());
    await page.evaluate((dx) => window.__move(dx), -Math.round(width * 0.3));
    await shot(page, "u7-zwischen-30");
    await page.evaluate(() => window.__up());
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await clickDay(page, "2025-06-17");
  await page.waitForFunction(() => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2025-06-17");
  await page.evaluate(() => window.__down());
  await page.evaluate((dx) => window.__move(dx), -Math.round(width * 0.8));
  await page.evaluate(() => window.__up());
  await page.waitForFunction(() => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2025-06-18");
  const reduced = await page.evaluate(() => ({
    follow: document.querySelector(".day-chips")?.classList.contains("day-chips--follow"),
    wrap: document.querySelector(".day-chips-wrap")?.classList.contains("day-chips-wrap--follow"),
    active: document.querySelector(".day-chip--active")?.dataset.day,
  }));
  assert(reduced.active === "2025-06-18" && !reduced.follow && !reduced.wrap, `${label}: reduced-motion ${JSON.stringify(reduced)}`);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  state.people = [
    { user_id: USER, display_name: "Dominik", role: "owner", person_kind: "member", status: "aktiv", avatar_color: "#0066b3" },
    { user_id: OTHER, display_name: "Sabine", role: "editor", person_kind: "member", status: "aktiv", avatar_color: "#D64541" },
  ];
  await page.evaluate(() => {
    const root = document.getElementById("overlay-root");
    if (root) {
      root.hidden = true;
      root.replaceChildren();
    }
    window.location.hash = "#/urlaube";
  });
  await page.waitForSelector(".screen--urlaube");
  await openTrip(page);
  await clickDay(page, "2025-06-16");
  await page.waitForFunction(() => document.querySelector('[data-testid="trip-content"]')?.dataset.activeDay === "2025-06-16");
  await page.waitForSelector('[data-place-id="p-navene"]');
  await page.evaluate(() => document.querySelector('[data-place-id="p-navene"]')?.click());
  await page.waitForSelector('[data-place-id="p-navene"].oc--selected, [data-place-id="p-navene"] .oc--selected, .oc--selected[data-place-id="p-navene"]');
  await page.waitForSelector('[data-place-id="p-navene"] [data-kr-tip]');
  await page.evaluate(() => document.querySelector('[data-place-id="p-navene"] [data-kr-tip]')?.click());
  await page.waitForSelector('[data-testid="member-tip"]');
  await page.locator('[data-testid="member-tip"]').evaluate((el) => el.remove());
  await page.evaluate(() => document.querySelector('[data-testid="photo-select-start"]')?.click());
  await page.waitForSelector('[data-place-id="p-navene"] .tile[aria-pressed]');
  await page.evaluate(() => document.querySelector('[data-place-id="p-navene"] [data-kr-tip]')?.click());
  assert((await page.locator('[data-testid="member-tip"]').count()) === 0, `${label}: Tooltip im Auswahlmodus`);
  const pressed = await page.locator('[data-place-id="p-navene"] .tile[aria-pressed="true"]').count();
  assert(pressed >= 1, `${label}: Kreis wählt das Foto nicht`);

  await page.evaluate(() => {
    window.location.hash = "#/urlaub/trip-garda/einstellungen";
  });
  await page.waitForSelector('[data-testid="settings-edit-trip"]');
  await page.click('[data-testid="settings-edit-trip"]');
  await page.waitForSelector('[data-testid="share-email-input"]');
  await page.fill('[data-testid="share-email-input"]', "gast@example.com");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="share-chip"]');
  await page.click('[data-action="cancel"]');
  await page.waitForSelector(".screen--urlaube, [data-testid='settings-screen']");
  await page.evaluate(() => {
    window.location.hash = "#/urlaub/trip-garda/bearbeiten";
  });
  await page.waitForSelector('[data-testid="share-section"]');
  assert((await page.locator('[data-testid="share-chip"]').count()) === 0, `${label}: Entwurf übersteht Abbrechen`);
  await page.fill('[data-testid="share-email-input"]', "gast@example.com");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="share-chip"]');
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="share-chip"]').length === 0);
  await page.evaluate(() => {
    window.location.hash = "#/urlaube";
  });
  await page.waitForSelector(".screen--urlaube");
  await page.evaluate(() => {
    window.location.hash = "#/urlaub/trip-garda/bearbeiten";
  });
  await page.waitForSelector('[data-testid="share-section"]');
  assert((await page.locator('[data-testid="share-chip"]').count()) === 0, `${label}: Entwurf übersteht Speichern`);

  await page.evaluate(() => {
    localStorage.setItem(
      "vr-diary-source:trip-garda",
      JSON.stringify({ text: "LOKAL-ALT", pending: true, savedAt: "2020-01-01T00:00:00.000Z" })
    );
  });
  state.recaps.push({
    id: "notes-1",
    trip_id: TRIP,
    kind: "diary",
    status: "notes",
    version: 1,
    source_text: "SERVER-NEU",
    content: {},
    feedback: [],
    deleted_at: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: USER,
  });
  await page.evaluate(() => {
    window.location.hash = "#/urlaub/trip-garda/tagebuch";
  });
  await page.waitForSelector('[data-testid="diary-source"]');
  const newer = await page.locator('[data-testid="diary-source"]').inputValue();
  const toast = await page.locator('[data-testid="app-toast"]').innerText();
  assert(newer === "SERVER-NEU", `${label}: Server verliert «${newer}»`);
  assert(toast.includes("Neuerer Stand geladen"), `${label}: Toast «${toast}»`);

  await page.evaluate(() => {
    localStorage.setItem(
      "vr-diary-source:trip-garda",
      JSON.stringify({ text: "LOKAL-NEU", pending: true, savedAt: "2026-06-01T00:00:00.000Z" })
    );
  });
  await page.reload();
  await page.waitForSelector('[data-testid="diary-source"]');
  assert((await page.locator('[data-testid="diary-source"]').inputValue()) === "LOKAL-NEU", `${label}: lokaler Stand`);

  await page.evaluate(() => {
    sessionStorage.setItem("paket9-diary", JSON.stringify({ text: "OHNE-ZEIT", pending: true }));
  });
  await page.reload();
  await page.waitForSelector('[data-testid="diary-source"]');
  const unsaved = await page.locator('[data-testid="diary-source"]').inputValue();
  assert(unsaved === "OHNE-ZEIT", `${label}: ohne savedAt «${unsaved}»`);

  state.recaps = state.recaps.filter((row) => row.id !== "notes-1");
  state.signFails = 0;
  await page.evaluate(() => {
    window.location.hash = "#/urlaub/trip-garda/recap";
  });
  await page.waitForSelector('[data-testid="recap-counts"]', { timeout: 15000 });
  const counts = await page.locator('[data-testid="recap-counts"]').innerText();
  const materialPhotos = state.media.filter((row) => row.trip_id === TRIP && row.kind === "photo" && !row.deleted_at).length;
  assert(counts.includes(`${materialPhotos} Fotos`), `${label}: Material «${counts}» erwartet ${materialPhotos}`);
  assert(countMaterialPhotos([{ id: "a", type: "photo" }, { id: "b", type: "video" }, { id: "c", uploadStatus: "failed" }]) === 1, "Zählfunktion");

  const draft = state.recaps.find((row) => row.kind === "video" && row.status === "draft");
  draft.feedback = [{ at: "2026-01-01T00:00:00.000Z", by: OTHER, version: 1, text: "VON-ANDERS", status: "open" }];
  draft.updated_at = "2026-02-01T00:00:00.000Z";
  await page.fill('[data-testid="recap-feedback-input"]', "VON-MIR");
  await page.click('[data-testid="recap-feedback-send"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Wunsch"));
  const feedback = state.recaps.find((row) => row.id === draft.id).feedback.map((item) => item.text);
  assert(feedback.includes("VON-ANDERS") && feedback.includes("VON-MIR"), `${label}: Feedback ${feedback.join(",")}`);
  await page.evaluate(() => document.querySelector('[data-testid="app-toast"]')?.remove());
  const keptDraft = state.recaps.find((row) => row.id === draft.id);
  state.recaps = state.recaps.filter((row) => row.id !== draft.id);
  await page.fill('[data-testid="recap-feedback-input"]', "WEG");
  await page.click('[data-testid="recap-feedback-send"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("nicht mehr da"));
  const lost = await page.locator('[data-testid="app-toast"]').innerText();
  assert(!/gespeichert/i.test(lost), `${label}: gelöschter Entwurf gilt als gespeichert «${lost}»`);
  state.recaps.push(keptDraft);

  state.signFails = 99;
  await page.reload();
  await page.waitForSelector('[data-testid="recap-thumb-hint"]', { timeout: 8000 });
  assert((await page.locator(".recap-scene__thumb").count()) > 0, `${label}: Vorschau ohne Platzhalter`);
  state.signFails = 1;
  await page.reload();
  await page.waitForSelector('[data-testid="recap-scene"] img', { timeout: 8000 });
  assert((await page.locator('[data-testid="recap-thumb-hint"]').count()) === 0, `${label}: Hinweis trotz Bild`);

  state.signFails = 0;
  state.role = "viewer";
  state.media = state.media.filter((row) => row.id === "loose-photo" || row.id === "p-navene-m0");
  state.recaps.push({
    id: "final-video",
    trip_id: TRIP,
    kind: "video",
    status: "final",
    version: 1,
    content: {
      formula: { perPhotoS: 1.5, perNoteS: 1.5 },
      counts: { photos: 8, places: 1, notes: 0 },
      seconds: 30,
      scenes: [
        { type: "title", seconds: 3 },
        { type: "place", date: "2025-06-16", waypoint_id: "p-navene", media_ids: ["p-navene-m0"], note_ids: [], seconds: 5 },
        { type: "outro", seconds: 3 },
      ],
    },
    feedback: [],
    deleted_at: null,
    updated_at: "2026-03-01T00:00:00.000Z",
    created_at: "2026-03-01T00:00:00.000Z",
    created_by: USER,
  });
  await page.reload();
  await page.waitForSelector('[data-testid="recap-storyboard"]');
  assert((await page.locator('[data-testid="recap-empty"]').count()) === 0, `${label}: Gast sieht den Leerzustand`);
  state.role = "owner";

  await page.evaluate(async () => {
    const { clearTripRoleCache } = await import("./js/trip-role.js");
    clearTripRoleCache();
  });
  state.roleFails = 1;
  await page.evaluate(() => {
    window.location.hash = "#/urlaub/trip-garda/tagebuch";
  });
  await page.waitForSelector('[data-testid="diary-unavailable"]');
  const roleMsg = await page.locator('[data-testid="diary-unavailable"]').innerText();
  assert(roleMsg.includes("Rolle konnte nicht geladen werden"), `${label}: Hinweis «${roleMsg}»`);
  await page.evaluate(() => {
    window.location.hash = "#/urlaub/trip-garda/einstellungen";
  });
  await page.waitForSelector('[data-testid="settings-delete-trip"]');
  await page.click('[data-testid="settings-edit-trip"]');
  await page.waitForSelector('[data-testid="share-section"]');
  assert((await page.locator('[data-testid="share-section"]').innerText()).includes("Freigeben"), `${label}: Freigeben nach erneutem Öffnen`);

  state.failReadsAfterPlace = true;
  await page.evaluate(() => {
    window.location.hash = "#/urlaub/trip-garda";
  });
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.evaluate(async () => {
    const { openAddPlaceFlow } = await import("./js/ui-add-place-sheet.js");
    const { getVacation } = await import("./js/db.js");
    const vacation = await getVacation("trip-garda");
    window.__place = openAddPlaceFlow({
      vacation,
      vacationId: vacation.id,
      day: "2025-06-16",
      lat: 45.8,
      lng: 10.8,
      userId: "11111111-1111-1111-1111-111111111111",
    });
  });
  await page.waitForSelector('[data-testid="add-place-only"]');
  await page.fill('[data-testid="add-place-name"]', "Mole");
  await page.click('[data-testid="add-place-part"]');
  await page.click('[data-testid="add-place-only"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("Neu laden hat nicht geklappt"));
  assert((await page.locator('[data-testid="trip-content"]').count()) === 1, `${label}: Karte weg`);
  assert((await page.locator('[data-testid="cloud-load-error"]').count()) === 0, `${label}: Fehlerseite nach dem Speichern`);
  if (shots) await shot(page, "l2-karte-toast");
  state.failReads = false;
  state.failReadsAfterPlace = false;
}

async function runEngine(browserType, baseUrl, engine) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...devices["iPhone 8"], viewport: VIEWPORTS[0] });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (err) => console.error("pageerror", err.message));
  await installGestures(page);
  await freezeClock(page);
  const state = createMockSupabaseState();
  extendState(state);
  await installSupabaseMocks(page, state);
  await installNetworkAbort(page, state);
  await login(page, baseUrl);
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.evaluate(() => {
      window.location.hash = "#/urlaube";
    });
    await page.waitForSelector(".screen--urlaube");
    await layoutPass(page, state, `${engine} ${vp.name}`, { shots: engine === "chromium" && vp.name === "375x667" });
    console.log(`9 sammelpaket Layout ${engine} ${vp.name}`);
  }
  await page.setViewportSize({ width: 375, height: 667 });
  await behaviorPass(page, state, `${engine} 375`, { shots: engine === "chromium" });
  await context.close();

  const fresh = await browser.newContext({ ...devices["iPhone 8"] });
  const first = await fresh.newPage();
  await freezeClock(first);
  const failed = createMockSupabaseState();
  extendState(failed);
  failed.failReads = true;
  await installSupabaseMocks(first, failed);
  await submitOtp(first, baseUrl);
  await first.waitForSelector('[data-testid="cloud-load-error"]');
  const copy = await first.locator('[data-testid="cloud-load-error"]').innerText();
  assert(copy.includes("antwortet gerade nicht"), `${engine}: 5xx-Text «${copy}»`);
  assert(!copy.includes("Verbindung prüfen"), `${engine}: 5xx spricht von der Verbindung`);
  await fresh.close();

  const net = await browser.newContext({ ...devices["iPhone 8"] });
  const netPage = await net.newPage();
  await freezeClock(netPage);
  const netState = createMockSupabaseState();
  extendState(netState);
  netState.networkReads = true;
  await installSupabaseMocks(netPage, netState);
  await installNetworkAbort(netPage, netState);
  await submitOtp(netPage, baseUrl);
  await netPage.waitForSelector('[data-testid="cloud-load-error"]');
  const netCopy = await netPage.locator('[data-testid="cloud-load-error"]').innerText();
  assert(netCopy.includes("Verbindung prüfen"), `${engine}: Netzwerk «${netCopy}»`);
  await browser.close();
  console.log(`9 sammelpaket ${engine} OK`);
}

async function main() {
  await assertTone();
  const { server, baseUrl } = await startServer();
  try {
    await runEngine(chromium, baseUrl, "chromium");
    await runEngine(webkit, baseUrl, "webkit");
  } finally {
    server.close();
  }
  console.log("Playwright 9 Sammelpaket OK (Build 68)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
