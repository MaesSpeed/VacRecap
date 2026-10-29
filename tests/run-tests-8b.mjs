import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SUPABASE_HOST = "hgboqdovlfeuqfhfeykn.supabase.co";
const SHORT_CODE_ERROR = "Bitte den ganzen Code aus der E-Mail eingeben.";

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
    user: { id: userId, aud: "authenticated", role: "authenticated", email: "test@example.com" },
  };
  return {
    tokens: [],
    handleAuth(url, method, body) {
      const pathName = url.pathname;
      if (pathName.endsWith("/otp") && method === "POST") return { status: 200, json: {} };
      if (pathName.endsWith("/verify") && method === "POST") {
        const parsed = JSON.parse(body || "{}");
        this.tokens.push(parsed.token ?? "");
        return { status: 200, json: session };
      }
      if (pathName.endsWith("/token") && method === "POST") return { status: 200, json: session };
      if (pathName.endsWith("/user") && method === "GET") return { status: 200, json: session.user };
      return { status: 404, json: {} };
    },
    handleRest(url, method) {
      const table = url.pathname.split("/").filter(Boolean).pop();
      if (method === "GET" && table === "trips") return { status: 200, json: [] };
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
        ? state.handleRest(url, req.method())
        : { status: 404, json: {} };
    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      body: result.json ? JSON.stringify(result.json) : "",
    });
  });
}

async function pasteOtp(page, text) {
  await page.locator('input[name="otp"]').click();
  await page.locator('input[name="otp"]').evaluate((el, raw) => {
    el.focus();
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      configurable: true,
      value: {
        getData(type) {
          if (type === "text" || type === "text/plain") return raw;
          return "";
        },
      },
    });
    const notCanceled = el.dispatchEvent(event);
    if (notCanceled) {
      const max = el.maxLength > 0 ? el.maxLength : raw.length;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      const merged = el.value.slice(0, start) + raw + el.value.slice(end);
      el.value = merged.slice(0, max);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: raw, inputType: "insertFromPaste" }));
    }
  }, text);
}

async function openOtpStep(page, baseUrl) {
  await page.goto(baseUrl);
  await page.waitForSelector('[data-testid="login-screen"]');
  await page.fill('input[name="email"]', "test@example.com");
  await page.click('form[data-step="email"] button[type="submit"]');
  await page.waitForSelector('form[data-step="otp"]:not([hidden])');
}

async function assertLoginCopy(page, label) {
  const ui = await page.evaluate(async () => {
    const input = document.querySelector('input[name="otp"]');
    const screen = document.querySelector('[data-testid="login-screen"]');
    return {
      build: (await import("./js/app-version.js")).APP_BUILD_VERSION,
      lead: document.querySelector(".login-lead")?.textContent || "",
      label: document.querySelector('form[data-step="otp"] .field__label')?.textContent || "",
      maxLength: input?.getAttribute("maxlength") || "",
      inputMode: input?.getAttribute("inputmode") || "",
      autoComplete: input?.getAttribute("autocomplete") || "",
      placeholder: input?.getAttribute("placeholder") || "",
      html: screen?.innerHTML || "",
      text: screen?.innerText || "",
    };
  });
  if (Number(ui.build) !== 51) throw new Error(`${label}: Build ${ui.build}, erwartet 51`);
  if (!ui.lead.includes("Du erhältst einen Code per E-Mail.")) {
    throw new Error(`${label}: Lead falsch (${ui.lead})`);
  }
  if (ui.label !== "Code aus der E-Mail") throw new Error(`${label}: Label falsch (${ui.label})`);
  if (ui.maxLength !== "10") throw new Error(`${label}: maxlength ${ui.maxLength}`);
  if (ui.inputMode !== "numeric") throw new Error(`${label}: inputmode ${ui.inputMode}`);
  if (ui.autoComplete !== "one-time-code") throw new Error(`${label}: autocomplete ${ui.autoComplete}`);
  if (ui.placeholder !== "12345678") throw new Error(`${label}: Placeholder ${ui.placeholder}`);
  if (/stellig/i.test(ui.text) || ui.html.includes("6-stellig") || ui.html.includes('maxlength="6"')) {
    throw new Error(`${label}: feste Stellenzahl noch in der Anmeldung`);
  }
}

async function assertSignedIn(page, state, label, expectedToken) {
  await page.click('form[data-step="otp"] button[type="submit"]');
  await page.waitForSelector(".screen--urlaube");
  if (state.tokens.length !== 1 || state.tokens[0] !== expectedToken) {
    throw new Error(`${label}: Token ${JSON.stringify(state.tokens)}, erwartet ${expectedToken}`);
  }
}

async function assertTooShort(page, state, label) {
  await page.click('form[data-step="otp"] button[type="submit"]');
  await page.waitForSelector('form[data-step="otp"] [data-role="error"]:not([hidden])');
  const message = await page.locator('form[data-step="otp"] [data-role="error"]').innerText();
  if (message.trim() !== SHORT_CODE_ERROR) {
    throw new Error(`${label}: Fehlermeldung „${message.trim()}“`);
  }
  await page.waitForTimeout(250);
  if (state.tokens.length !== 0) {
    throw new Error(`${label}: Verify trotz kurzem Code (${JSON.stringify(state.tokens)})`);
  }
  const stillOtp = await page.locator('form[data-step="otp"]:not([hidden])').count();
  const signedIn = await page.locator(".screen--urlaube").count();
  if (!stillOtp || signedIn) throw new Error(`${label}: Anmeldung trotz kurzem Code`);
}

async function runSuite(browserType, baseUrl, label) {
  const browser = await browserType.launch({ headless: true });
  const run = async (fn) => {
    const ctx = await browser.newContext({ ...devices["iPhone 8"], baseURL: baseUrl });
    const page = await ctx.newPage();
    page.setDefaultTimeout(20_000);
    const state = createMockSupabaseState();
    await installSupabaseMocks(page, state);
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    try {
      await fn(page, state);
      if (errors.length) throw new Error(`${label}: ${errors[0]}`);
    } finally {
      await ctx.close();
    }
  };

  await run(async (page) => {
    await page.goto(baseUrl);
    await page.waitForSelector('[data-testid="login-screen"]');
    await assertLoginCopy(page, `${label}-ui`);
  });

  await run(async (page, state) => {
    await openOtpStep(page, baseUrl);
    await page.fill('input[name="otp"]', "123456");
    const value = await page.locator('input[name="otp"]').inputValue();
    if (value !== "123456") throw new Error(`${label}-6: Feld „${value}“`);
    await assertSignedIn(page, state, `${label}-6`, "123456");
  });

  await run(async (page, state) => {
    await openOtpStep(page, baseUrl);
    await page.fill('input[name="otp"]', "12345678");
    const value = await page.locator('input[name="otp"]').inputValue();
    if (value !== "12345678") throw new Error(`${label}-8: Code abgeschnitten „${value}“`);
    await assertSignedIn(page, state, `${label}-8`, "12345678");
  });

  await run(async (page, state) => {
    await openOtpStep(page, baseUrl);
    await pasteOtp(page, "12 34 56 78");
    const value = await page.locator('input[name="otp"]').inputValue();
    if (value !== "12345678") throw new Error(`${label}-paste-space: Feld „${value}“`);
    await assertSignedIn(page, state, `${label}-paste-space`, "12345678");
  });

  await run(async (page, state) => {
    await openOtpStep(page, baseUrl);
    await pasteOtp(page, "1234-5678");
    const value = await page.locator('input[name="otp"]').inputValue();
    if (value !== "12345678") throw new Error(`${label}-paste-hyphen: Feld „${value}“`);
    await assertSignedIn(page, state, `${label}-paste-hyphen`, "12345678");
  });

  await run(async (page, state) => {
    await openOtpStep(page, baseUrl);
    await page.fill('input[name="otp"]', "1234 5678");
    const value = await page.locator('input[name="otp"]').inputValue();
    if (value !== "12345678") throw new Error(`${label}-fill-separators: Feld „${value}“`);
    await assertSignedIn(page, state, `${label}-fill-separators`, "12345678");
  });

  await run(async (page, state) => {
    await openOtpStep(page, baseUrl);
    await page.fill('input[name="otp"]', "12345");
    await assertTooShort(page, state, `${label}-short`);
  });

  await run(async (page, state) => {
    await openOtpStep(page, baseUrl);
    await pasteOtp(page, "12 3-4");
    const value = await page.locator('input[name="otp"]').inputValue();
    if (value !== "1234") throw new Error(`${label}-short-paste: Feld „${value}“`);
    await assertTooShort(page, state, `${label}-short-paste`);
  });

  await browser.close();
  console.log(`8b ${label} OK`);
}

async function main() {
  const { server, baseUrl } = await startServer();
  try {
    await runSuite(chromium, baseUrl, "chromium");
    await runSuite(webkit, baseUrl, "webkit");
  } finally {
    server.close();
  }
  console.log("Playwright 8b tests OK (Build 51)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
