import { chromium, webkit } from "playwright";
import {
  TRIP,
  USER,
  createMockSupabaseState,
  installSupabaseMocks,
  startServer,
} from "./run-tests-12b-recap-video.mjs";

const OTHER = "22222222-2222-2222-2222-222222222222";
const WIDTHS = [
  { width: 375, height: 667, name: "375" },
  { width: 390, height: 844, name: "390" },
  { width: 1280, height: 800, name: "1280" },
];

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function extendState(state) {
  const trip = state.trips.find((row) => row.id === TRIP);
  trip.title = "Gardasee";
  trip.companions = ["Domi", "Anne", "Johannes"];
  trip.companion_tags = ["familie"];
  const people = [
    {
      person_kind: "member",
      user_id: USER,
      display_name: "Domi",
      avatar_color: "#0066b3",
      role: "owner",
      status: "aktiv",
      email: "test@example.com",
      since: "2025-06-01T00:00:00.000Z",
    },
    {
      person_kind: "member",
      user_id: OTHER,
      display_name: "Johannes",
      avatar_color: "#1F9D57",
      role: "viewer",
      status: "aktiv",
      email: "johannes@example.com",
      since: "2025-06-02T00:00:00.000Z",
    },
  ];
  const rest = state.handleRest.bind(state);
  state.handleRest = async (url, method, body, headers) => {
    if (url.pathname.endsWith("/rpc/list_trip_people")) {
      const args = JSON.parse(body || "{}");
      return { status: 200, json: args.p_trip_id === TRIP ? people : [] };
    }
    if (
      url.pathname.endsWith("/rpc/list_my_trip_invites") ||
      url.pathname.endsWith("/rpc/list_trip_presence") ||
      url.pathname.endsWith("/rpc/touch_trip_presence") ||
      url.pathname.endsWith("/rpc/clear_trip_presence")
    ) {
      return { status: 200, json: [] };
    }
    return rest(url, method, body, headers);
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

async function listInitials(page) {
  const card = page.locator(`[data-vacation-id="${TRIP}"]`);
  await card.waitFor();
  return card.locator(".kr-av, .avatar").allInnerTexts();
}

function assertListInitials(letters, label) {
  const shown = letters.map((text) => text.trim()).filter(Boolean);
  assert(shown.includes("D") && shown.includes("J"), `${label}: Initialen in der Liste «${shown.join(",")}»`);
}

async function tripChrome(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      const box = el.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, height: box.height };
    };
    const header = document.querySelector(".trip-header");
    const nav = document.querySelector(".day-nav");
    const content = document.querySelector('[data-testid="trip-content"]');
    const chip = document.querySelector(".day-chip");
    const pages = [...document.querySelectorAll(".day-swipe__page")].map((el) => ({
      page: el.dataset.page,
      ...rect(el),
    }));
    const between = [];
    let node = header?.nextElementSibling || null;
    while (node && node !== nav) {
      between.push({
        className: node.className,
        testid: node.dataset.testid || "",
        height: rect(node).height,
      });
      node = node.nextElementSibling;
    }
    return {
      nextIsNav: header?.nextElementSibling === nav,
      header: header ? rect(header) : null,
      nav: nav ? rect(nav) : null,
      content: content ? rect(content) : null,
      chip: chip ? rect(chip) : null,
      pages,
      between,
      companions: document.querySelectorAll('[data-testid="trip-companions"]').length,
      names: document.querySelectorAll('[data-testid="companion-names"]').length,
      bar: document.querySelectorAll('[data-testid="member-bar"], .kr-bar, [data-testid="member-chip"]').length,
      banner: document.querySelectorAll('[data-testid="role-banner"]').length,
      chips: document.querySelectorAll(".day-chip").length,
    };
  });
}

function assertChrome(box, label) {
  assert(box.companions === 0 && box.names === 0, `${label}: Namenszeile ${box.companions}/${box.names}`);
  assert(box.bar === 0, `${label}: Rollenleiste ${box.bar}`);
  assert(box.banner === 0, `${label}: leere Hinweisleiste`);
  assert(box.chips > 0, `${label}: Tageschips fehlen`);
  assert(box.nextIsNav && box.between.length === 0, `${label}: Block zwischen Kopf und Tagen ${JSON.stringify(box.between)}`);
  const headerGap = box.nav.top - box.header.bottom;
  const chipGap = box.chip.top - box.header.bottom;
  assert(headerGap <= 1, `${label}: Lücke unter dem Kopf ${headerGap}`);
  assert(chipGap > 0 && chipGap <= 20, `${label}: Tage nicht direkt unter dem Kopf ${chipGap}`);
  const contentGap = box.content.top - box.nav.bottom;
  assert(Math.abs(contentGap) <= 1, `${label}: Inhalt nicht an der Tagleiste ${contentGap}`);
  assert(box.pages.length === 3, `${label}: Wischseiten ${box.pages.length}`);
  const tops = box.pages.map((page) => page.top);
  const topSpread = Math.max(...tops) - Math.min(...tops);
  assert(topSpread <= 1, `${label}: Wischseiten versetzt ${JSON.stringify(box.pages)}`);
  assert(Math.abs(box.pages[0].top - box.content.top) <= 1, `${label}: Wischseite nicht am Inhalt`);
  const heights = box.pages.map((page) => page.height);
  assert(Math.max(...heights) - Math.min(...heights) <= 1, `${label}: Wischseiten ungleich hoch ${JSON.stringify(box.pages)}`);
}

async function runPass(page, label) {
  const before = await listInitials(page);
  assertListInitials(before, `${label} Liste`);

  await page.locator(`[data-vacation-id="${TRIP}"]`).click();
  await page.waitForSelector(".screen--trip .day-chip");
  await page.waitForSelector('[data-page="current"]');

  for (const size of WIDTHS) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const box = await tripChrome(page);
    assertChrome(box, `${label} ${size.name}`);
  }

  await page.evaluate((id) => {
    window.location.hash = `#/urlaub/${id}/bearbeiten`;
  }, TRIP);
  await page.waitForSelector(".form-header__title");
  const heading = await page.locator(".form-header__title").innerText();
  assert(heading.trim() === "Reise bearbeiten", `${label}: Formular «${heading}»`);
  const names = await page.locator('[data-role="name-chips"]').innerText();
  assert(names.includes("Domi") && names.includes("Anne") && names.includes("Johannes"), `${label}: Namen im Formular «${names}»`);
  assert((await page.locator('[data-tag="familie"]').getAttribute("aria-pressed")) === "true", `${label}: Familie nicht mehr wählbar`);
  await page.waitForFunction(
    () => {
      const text = document.querySelector('[data-testid="share-access"]')?.innerText || "";
      return text.includes("Besitzer") && text.includes("Beitragender");
    },
    null,
    { timeout: 8000 }
  );

  await page.evaluate(() => {
    window.location.hash = "#/urlaube";
  });
  await page.waitForSelector(".screen--urlaube");
  const after = await listInitials(page);
  assertListInitials(after, `${label} Liste danach`);
}

async function runEngine(browserType, baseUrl, engine) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const page = await context.newPage();
  const state = createMockSupabaseState();
  extendState(state);
  await installSupabaseMocks(page, state);
  await login(page, baseUrl);
  await runPass(page, engine);
  await browser.close();
  console.log(`personenbereich ${engine} OK`);
}

async function main() {
  const { server, baseUrl } = await startServer();
  try {
    await runEngine(chromium, baseUrl, "chromium");
    await runEngine(webkit, baseUrl, "webkit");
  } finally {
    server.close();
  }
  console.log("personenbereich OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
