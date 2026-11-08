import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";
import {
  TRIP,
  USER,
  createMockSupabaseState,
  installSupabaseMocks,
  startServer,
} from "./run-tests-12b-recap-video.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REMOTE_USER = "22222222-2222-2222-2222-222222222222";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function extendTripsMock(state) {
  const trip = state.trips.find((row) => row.id === TRIP);
  if (trip) {
    trip.companions = ["Ada", "Ben", "Clara"];
    trip.companion_tags = ["freunde"];
    trip.updated_at = "2026-10-30T10:00:00.000Z";
    trip.updated_by = USER;
    trip.title = "LOCAL TRIP TITLE";
  }
  state.tripWrites = [];
  const baseRest = state.handleRest.bind(state);
  state.handleRest = (url, method, body, headers) => {
    const table = url.pathname.split("/").filter(Boolean).pop();
    if (table === "trips" && method === "PATCH") {
      const rows = state.trips.filter((row) => {
        let ok = true;
        for (const [key, value] of url.searchParams.entries()) {
          if (["select", "order", "offset", "limit", "on_conflict"].includes(key)) continue;
          if (value.startsWith("eq.")) ok &&= String(row[key]) === value.slice(3);
        }
        return ok;
      });
      const patch = JSON.parse(body || "{}");
      state.tripWrites.push({ patch, query: url.search });
      const accept = headers.accept || "";
      if (!rows.length) {
        return { status: 200, json: accept.includes("application/vnd.pgrst.object+json") ? null : [] };
      }
      Object.assign(rows[0], patch, { updated_at: "2026-10-30T13:00:00.000Z" });
      const row = rows[0];
      return { status: 200, json: accept.includes("application/vnd.pgrst.object+json") ? row : [row] };
    }
    return baseRest(url, method, body, headers);
  };
}

async function login(page, baseUrl) {
  await page.goto(baseUrl);
  await page.waitForSelector('[data-testid="login-screen"]');
  await page.fill('input[name="email"]', "test@example.com");
  await page.click('form[data-step="email"] button[type="submit"]');
  await page.waitForSelector('form[data-step="otp"]');
  await page.fill('input[name="otp"]', "123456");
  await page.click('form[data-step="otp"] button[type="submit"]');
  await page.waitForSelector(".screen--urlaube");
}

async function runPass(page, state, label) {
  await page.evaluate(() => {
    window.location.hash = `#/urlaub/${"trip-garda"}/bearbeiten`;
  });
  await page.waitForSelector('[data-testid="share-section"]');
  await page.fill('input[name="title"]', "LOCAL TITLE DRAFT");
  const beforeNames = await page.locator('[data-role="name-chips"] .chip').allTextContents();
  assert(beforeNames.some((t) => t.includes("Ada")), `${label}: seed Ada missing «${beforeNames}»`);

  const tripRemote = state.trips.find((row) => row.id === TRIP);
  tripRemote.companions = ["REMOTE CO-TRAVELLER"];
  tripRemote.companion_tags = ["familie"];
  tripRemote.title = "REMOTE TRIP TITLE";
  tripRemote.updated_at = "2026-10-30T12:00:00.000Z";
  tripRemote.updated_by = REMOTE_USER;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("vacrecap:data-changed")));

  const titleAfterEvent = await page.inputValue('input[name="title"]');
  assert(titleAfterEvent === "LOCAL TITLE DRAFT", `${label}: local title draft lost «${titleAfterEvent}»`);

  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('[data-testid="conflict-dialog"]');
  await page.locator('[data-testid="conflict-dialog"] [data-action="cancel"]').click();
  await page.waitForFunction(() => document.querySelector('input[name="title"]')?.value === "REMOTE TRIP TITLE");

  const titleAfterReload = await page.inputValue('input[name="title"]');
  assert(titleAfterReload === "REMOTE TRIP TITLE", `${label}: title after reload «${titleAfterReload}»`);
  const namesAfterReload = await page.locator('[data-role="name-chips"] .chip').allTextContents();
  assert(
    namesAfterReload.length === 1 && namesAfterReload[0].includes("REMOTE CO-TRAVELLER"),
    `${label}: companions after reload «${namesAfterReload}»`
  );
  const familiePressed = await page.locator('[data-tag="familie"]').getAttribute("aria-pressed");
  assert(familiePressed === "true", `${label}: familie tag «${familiePressed}»`);

  await page.fill('input[name="title"]', "AFTER RELOAD local title edit");
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="app-toast"]')?.textContent || "").includes("gespeichert"));

  const trip = state.trips.find((row) => row.id === TRIP);
  assert(trip.companions?.[0] === "REMOTE CO-TRAVELLER", `${label}: server companions «${trip.companions}»`);
  assert(trip.companion_tags?.includes("familie"), `${label}: server tags «${trip.companion_tags}»`);
  assert(trip.title === "AFTER RELOAD local title edit", `${label}: title «${trip.title}»`);
}

async function runEngine(browserType, baseUrl, engine) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...devices["iPhone 8"] });
  const page = await context.newPage();
  const state = createMockSupabaseState();
  extendTripsMock(state);
  await installSupabaseMocks(page, state);
  await login(page, baseUrl);
  await runPass(page, state, engine);
  await browser.close();
  console.log(`form companion conflict ${engine} OK`);
}

async function main() {
  const { server, baseUrl } = await startServer();
  try {
    await runEngine(chromium, baseUrl, "chromium");
    await runEngine(webkit, baseUrl, "webkit");
  } finally {
    server.close();
  }
  console.log("form-companion-conflict OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
