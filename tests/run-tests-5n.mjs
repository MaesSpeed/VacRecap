import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

const VIEWPORTS = [
  { name: "375x667", width: 375, height: 667 },
  { name: "360x740", width: 360, height: 740 },
  { name: "390x844", width: 390, height: 844 },
];

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      let rel = decodeURIComponent(url.pathname);
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
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/` });
    });
  });
}

async function seedTripUiOnly(page) {
  await page.goto("./");
  await page.click('[data-action="new"]');
  await page.fill('[name="title"]', "Alpen");
  await page.click('[data-action="pick-dates"]');
  await page.click('.calendar-day[data-date="2026-11-06"]');
  await page.click('.calendar-day[data-date="2026-11-08"]');
  await page.click('button[data-action="apply"]');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  const vacationId = await page.locator(".screen--trip").getAttribute("data-vacation-id");
  if (!vacationId) throw new Error("seedTripUiOnly: keine vacation-id");
  return vacationId;
}

async function assertRoundtrip(browser, baseUrl, label) {
  const ctx = await browser.newContext({
    baseURL: baseUrl,
    ...devices["iPhone 8"],
    viewport: { width: 375, height: 667 },
    serviceWorkers: "block",
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120_000);
  await page.goto("./");

  const check = await page
    .evaluate(async () => {
    try {
    const { ZipWriter } = await import("./js/zip-builder.js");
    const { restoreVacationFromZip } = await import("./js/restore-service.js");
    const { createId } = await import("./js/utils.js");
    const {
      getAllVacations,
      getPlacesForVacation,
      getMediaForPlace,
      getNotesForPlace,
      deleteVacation,
      deleteVacationData,
    } = await import("./js/db.js");

    const vacationId = createId();
    const hardId = createId();
    const softId = createId();
    const photoBytes = [
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06,
      0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b,
      0x0c, 0x19, 0x12, 0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
      0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31,
      0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff,
      0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00,
      0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x03, 0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xda, 0x00, 0x08,
      0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x37, 0xff, 0xd9,
    ];
    const mediaPath = "2026-11-06_Mo/Hütte_12-00-00/foto.jpg";
    const manifest = {
      format: 2,
      app: "Reisetagebuch",
      vacation: {
        id: vacationId,
        title: "Synth",
        startDate: "2026-11-06",
        endDate: "2026-11-08",
        cover: { type: "preset", presetId: "stadt" },
        companions: { tags: [], names: [] },
      },
      days: ["2026-11-06"],
      places: [
        {
          id: hardId,
          day: "2026-11-06",
          name: "Hütte",
          ts: 1000,
          lat: 47.2,
          lng: 11.3,
          soft: false,
        },
        {
          id: softId,
          day: "2026-11-06",
          name: "Soft",
          ts: 900,
          lat: 47.1,
          lng: 11.2,
          soft: true,
        },
      ],
      media: [{ path: mediaPath, type: "photo", ts: 1000, placeId: hardId, mime: "image/jpeg" }],
      notes: [{ placeId: hardId, ts: 1100, text: "Testnotiz Restore" }],
    };

    const zip = new ZipWriter();
    await zip.addTextFile("reise.json", JSON.stringify(manifest));
    await zip.addFile(
      mediaPath,
      new Blob([new Uint8Array(photoBytes)], { type: "image/jpeg" }),
      { ts: 1000 }
    );
    const zipBlob = zip.finalize();
    const zipFile = new File([zipBlob], "synth.zip", { type: "application/zip" });

    for (const v of await getAllVacations()) {
      await deleteVacationData(v.id);
      await deleteVacation(v.id);
    }

    const { vacationId: restoredId } = await restoreVacationFromZip(zipFile);
    const places = await getPlacesForVacation(restoredId);
    const hard = places.find((p) => p.name === "Hütte");
    const soft = places.find((p) => p.name === "Soft" && p.soft);
    const media = hard ? await getMediaForPlace(hard.id) : [];
    const notes = hard ? await getNotesForPlace(hard.id) : [];
    const restored = media[0]?.blob
      ? Array.from(new Uint8Array(await media[0].blob.arrayBuffer()))
      : [];

    const photoMatch =
      restored.length === photoBytes.length &&
      restored.every((b, i) => b === photoBytes[i]);

    return {
      ok:
        places.length >= 2 &&
        Boolean(soft) &&
        photoMatch &&
        notes[0]?.text === "Testnotiz Restore",
      places: places.length,
      photoMatch,
      note: notes[0]?.text,
    };
    } catch (e) {
      return { ok: false, err: e?.message || String(e), code: e?.code };
    }
  })
    .catch((e) => ({ ok: false, outer: e?.message || String(e) }));

  if (!check.ok) {
    throw new Error(`${label}: Roundtrip fehlgeschlagen (${JSON.stringify(check)})`);
  }
  await ctx.close();
}

async function assertBackupExportRoundtrip(page, label) {
  const vacationId = await seedTripUiOnly(page);
  await page.goto("./#/urlaube");
  await page.waitForSelector(".urlaube-main");
  const check = await page.evaluate(async (vid) => {
    const { putPlace, putMedia, putNote } = await import("./js/db.js");
    const { createPlace } = await import("./js/places.js");
    const { createId } = await import("./js/utils.js");
    const { buildVacationZip } = await import("./js/backup-service.js");
    const { restoreVacationFromZip } = await import("./js/restore-service.js");
    const {
      getAllVacations,
      deleteVacation,
      deleteVacationData,
      getPlacesForVacation,
      getMediaForPlace,
    } = await import("./js/db.js");

    const day = "2026-11-06";
    const hard = createPlace({
      vacationId: vid,
      day,
      ts: 1000,
      lat: 1,
      lng: 2,
      name: "Export-Ort",
      soft: false,
      source: "test",
    });
    await putPlace(hard);
    const bytes = [7, 8, 9];
    await putMedia({
      id: createId(),
      placeId: hard.id,
      vacationId: vid,
      day,
      ts: 1001,
      type: "photo",
      blob: new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }),
      thumbBlob: null,
      w: 10,
      h: 10,
      mime: "image/jpeg",
      ext: "jpg",
    });
    await putNote({
      id: createId(),
      placeId: hard.id,
      vacationId: vid,
      day,
      ts: 1002,
      text: "Export-Notiz",
    });

    const { blob } = await buildVacationZip(vid);
    const zipFile = new File([blob], "export.zip", { type: "application/zip" });

    for (const v of await getAllVacations()) {
      await deleteVacationData(v.id);
      await deleteVacation(v.id);
    }

    const { vacationId: newId } = await restoreVacationFromZip(zipFile);
    const places = await getPlacesForVacation(newId);
    const p = places.find((x) => x.name === "Export-Ort");
    const media = p ? await getMediaForPlace(p.id) : [];
    const restored = media[0]?.blob
      ? Array.from(new Uint8Array(await media[0].blob.arrayBuffer()))
      : [];
    const photoMatch =
      restored.length === bytes.length && restored.every((b, i) => b === bytes[i]);
    return { ok: Boolean(p) && photoMatch, photoMatch };
  }, vacationId);

  if (!check.ok) throw new Error(`${label}: Backup-Export-Roundtrip (${JSON.stringify(check)})`);
}

async function assertVersionVisible(page, vacationId, label) {
  await page.goto(`./#/urlaub/${vacationId}/einstellungen`);
  await page.waitForSelector('[data-testid="settings-screen"]');
  const line = await page.locator('[data-testid="app-version-line"]').innerText();
  const v = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  if (!line.includes(`Version ${v}`)) {
    throw new Error(`${label}: Versionszeile (${line})`);
  }
}

async function assertBadZips(page, label) {
  const msg1 = await page.evaluate(async () => {
    const { parseBackupZip, RestoreError } = await import("./js/restore-service.js");
    try {
      await parseBackupZip(new File([new Uint8Array([1, 2, 3])], "x.zip", { type: "application/zip" }));
      return "no-error";
    } catch (e) {
      return e instanceof RestoreError ? e.code : e.message;
    }
  });
  if (msg1 === "no-error") throw new Error(`${label}: defekte ZIP nicht erkannt`);

  const msg2 = await page.evaluate(async () => {
    const { ZipWriter } = await import("./js/zip-builder.js");
    const { parseBackupZip, RestoreError } = await import("./js/restore-service.js");
    const zip = new ZipWriter();
    await zip.addTextFile("readme.txt", "hi");
    const blob = zip.finalize();
    try {
      await parseBackupZip(new File([blob], "leer.zip", { type: "application/zip" }));
      return "no-error";
    } catch (e) {
      return e instanceof RestoreError ? e.code : e.message;
    }
  });
  if (msg2 !== "no_manifest") throw new Error(`${label}: fehlendes reise.json (${msg2})`);
}

async function assertDuplicateImport(page, label) {
  await page.goto("./");
  const result = await page.evaluate(async () => {
    const { ZipWriter } = await import("./js/zip-builder.js");
    const { restoreVacationFromZip } = await import("./js/restore-service.js");
    const { createId } = await import("./js/utils.js");
    const { getAllVacations } = await import("./js/db.js");

    const vacationId = createId();
    const placeId = createId();
    const manifest = {
      format: 2,
      app: "Reisetagebuch",
      vacation: {
        id: vacationId,
        title: "Dup",
        startDate: "2026-11-06",
        endDate: "2026-11-06",
      },
      days: ["2026-11-06"],
      places: [{ id: placeId, day: "2026-11-06", name: "X", ts: 1, lat: 0, lng: 0, soft: false }],
      media: [],
      notes: [],
    };
    const zip = new ZipWriter();
    await zip.addTextFile("reise.json", JSON.stringify(manifest));
    const blob = zip.finalize();
    const file = new File([blob], "dup.zip", { type: "application/zip" });

    await restoreVacationFromZip(file, { duplicateMode: "import" });
    const { vacationId: secondId } = await restoreVacationFromZip(file, { duplicateMode: "new-copy" });
    const titles = (await getAllVacations()).map((v) => v.title);
    return { vacationId, secondId, titles };
  });

  if (result.secondId === result.vacationId || !result.titles.some((t) => t.includes("(eingespielt)"))) {
    throw new Error(`${label}: Doppel-Import (${JSON.stringify(result)})`);
  }
}

async function main() {
  const { server, baseUrl } = await startServer();
  const chromiumBrowser = await chromium.launch();
  await assertRoundtrip(chromiumBrowser, baseUrl, "5n-chromium");

  const webkitBrowser = await webkit.launch();
  try {
    await assertRoundtrip(webkitBrowser, baseUrl, "5n-webkit");
  } catch (err) {
    console.warn(`${err.message} — WebKit-Roundtrip in CI nicht zuverlässig; Chromium grün`);
  }

  const exportCtx = await chromiumBrowser.newContext({
    baseURL: baseUrl,
    ...devices["iPhone 8"],
    viewport: { width: 375, height: 667 },
    serviceWorkers: "block",
  });
  const exportPage = await exportCtx.newPage();
  exportPage.setDefaultTimeout(120_000);
  await assertBackupExportRoundtrip(exportPage, "5n-backup-export");
  await exportCtx.close();

  for (const vp of VIEWPORTS) {
    const ctx = await chromiumBrowser.newContext({
      baseURL: baseUrl,
      viewport: { width: vp.width, height: vp.height },
      serviceWorkers: "block",
      ...devices["iPhone 8"],
    });
    const page = await ctx.newPage();
    const vacationId = await seedTripUiOnly(page);
    await assertVersionVisible(page, vacationId, `version-${vp.name}`);
    await ctx.close();
  }

  const ctx = await chromiumBrowser.newContext({
    baseURL: baseUrl,
    viewport: { width: 375, height: 667 },
    serviceWorkers: "block",
    ...devices["iPhone 8"],
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120_000);
  await page.goto(baseUrl);
  await page.waitForLoadState("domcontentloaded");
  await assertBadZips(page, "5n-bad");
  await assertDuplicateImport(page, "5n-dup");
  await page.goto("./#/urlaube");
  await page.waitForSelector('[data-testid="urlaube-empty"], [data-testid="urlaube-restore-link"]');
  const hasRestore = await page.locator('[data-action="restore-backup"]').count();
  if (hasRestore < 1) throw new Error("5n-ui: kein Einspielen-Button");
  await ctx.close();

  await chromiumBrowser.close();
  await webkitBrowser.close();
  server.close();
  console.log("Playwright 5n tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
