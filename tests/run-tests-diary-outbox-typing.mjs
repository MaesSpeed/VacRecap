import { chromium, webkit, devices } from "playwright";
import {
  TRIP,
  createMockSupabaseState,
  installSupabaseMocks,
  startServer,
} from "./run-tests-12b-recap-video.mjs";

function assert(cond, message) {
  if (!cond) throw new Error(message);
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

async function outboxTypingPass(page, label) {
  await page.evaluate(
    (tripId) => {
      localStorage.setItem(
        `vr-diary-source:${tripId}`,
        JSON.stringify({ text: "OUTBOX-A", pending: true, savedAt: "2026-06-01T00:00:00.000Z" })
      );
    },
    TRIP
  );
  await page.evaluate(() => {
    window.location.hash = `#/urlaub/${"trip-garda"}/tagebuch`;
  });
  await page.waitForSelector('[data-testid="diary-source"]');
  assert((await page.locator('[data-testid="diary-source"]').inputValue()) === "OUTBOX-A", `${label}: seed A`);

  await page.fill('[data-testid="diary-source"]', "OUTBOX-B");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.waitForTimeout(50);

  const stored = await page.evaluate((tripId) => {
    const raw = localStorage.getItem(`vr-diary-source:${tripId}`);
    return raw ? JSON.parse(raw) : null;
  }, TRIP);
  assert(stored?.text === "OUTBOX-B", `${label}: outbox after pagehide «${stored?.text}»`);

  await page.reload();
  await page.waitForSelector('[data-testid="diary-source"]');
  const after = await page.locator('[data-testid="diary-source"]').inputValue();
  assert(after === "OUTBOX-B", `${label}: field after reload «${after}»`);

  const stored2 = await page.evaluate((tripId) => {
    const raw = localStorage.getItem(`vr-diary-source:${tripId}`);
    return raw ? JSON.parse(raw) : null;
  }, TRIP);
  assert(stored2?.text === "OUTBOX-B", `${label}: outbox after reload «${stored2?.text}»`);
}

async function runEngine(browserType, baseUrl, engine) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...devices["iPhone 8"], viewport: { width: 375, height: 667 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const state = createMockSupabaseState();
  await installSupabaseMocks(page, state);
  await login(page, baseUrl);
  await outboxTypingPass(page, engine);
  await browser.close();
  console.log(`diary outbox typing ${engine} OK`);
}

async function main() {
  const { server, baseUrl } = await startServer();
  try {
    await runEngine(chromium, baseUrl, "chromium");
    await runEngine(webkit, baseUrl, "webkit");
  } finally {
    server.close();
  }
  console.log("diary outbox typing tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
