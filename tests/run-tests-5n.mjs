import { createServer } from "node:http";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
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

const CONTEXT_OPTS = {
  ...devices["iPhone 8"],
  viewport: { width: 375, height: 667 },
  serviceWorkers: "block",
};

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

async function runInPage(page, fn) {
  const result = await page.evaluate(fn);
  if (result?.ok === false) {
    throw new Error(result.err || JSON.stringify(result));
  }
  return result;
}

async function assertSyntheticRoundtrip(page, label) {
  await page.goto("./");
  await runInPage(page, async () => {
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
      const photoBytes = new Uint8Array(128 * 1024);
      for (let i = 0; i < photoBytes.length; i++) photoBytes[i] = i % 251;
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
      await zip.addFile(mediaPath, new Blob([photoBytes], { type: "image/jpeg" }), { ts: 1000 });
      const zipFile = new File([zip.finalize()], "synth.zip", { type: "application/zip" });
      if (zipFile.size < 70_000) {
        return { ok: false, err: `ZIP zu klein (${zipFile.size})` };
      }

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
        ? new Uint8Array(await media[0].blob.arrayBuffer())
        : new Uint8Array();
      const photoMatch =
        restored.length === photoBytes.length &&
        restored.every((b, i) => b === photoBytes[i]);

      if (places.length < 2 || !soft || !photoMatch || notes[0]?.text !== "Testnotiz Restore") {
        return { ok: false, err: "verify failed" };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, err: e?.message || String(e) };
    }
  });
}

async function assertMediaHashesAfterReload(page, label, { format = 2 } = {}) {
  await page.goto("./");
  const prep = await page.evaluate(async (format) => {
    const digestBytes = async (bytes) => {
      const d = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(d))
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
    };
    const digestBlob = async (blob) => digestBytes(await blob.arrayBuffer());

    try {
      const { ZipWriter } = await import("./js/zip-builder.js");
      const { restoreVacationFromZip } = await import("./js/restore-service.js");
      const { createId } = await import("./js/utils.js");
      const {
        getAllVacations,
        deleteVacation,
        deleteVacationData,
        getPlacesForVacation,
        getMediaForPlace,
      } = await import("./js/db.js");

      for (const v of await getAllVacations()) {
        await deleteVacationData(v.id);
        await deleteVacation(v.id);
      }

      const vacationId = createId();
      const placeId = createId();
      const photo = new Uint8Array(3 * 1024 * 1024);
      for (let i = 0; i < photo.length; i++) photo[i] = (i * 3) % 256;
      const smallVideo = new Uint8Array(2 * 1024 * 1024);
      smallVideo.fill(9);
      const bigVideo = new Uint8Array(100 * 1024 * 1024);
      for (let i = 0; i < bigVideo.length; i++) bigVideo[i] = (i * 7) % 256;

      const expected = {
        photo: await digestBytes(photo),
        smallVideo: await digestBytes(smallVideo),
        bigVideo: await digestBytes(bigVideo),
      };

      const photoPath = "2026-11-06_Mo/Ort_10-00/foto.jpg";
      const smallPath = "2026-11-06_Mo/Ort_10-00/kurz.mp4";
      const bigPath = "2026-11-06_Mo/Ort_10-00/lang.mp4";

      const vacation =
        format === 1
          ? {
              id: vacationId,
              title: "Fmt1",
              startDate: "2026-11-06",
              endDate: "2026-11-06",
            }
          : {
              id: vacationId,
              title: "Fmt2",
              startDate: "2026-11-06",
              endDate: "2026-11-06",
              cover: { type: "preset", presetId: "stadt" },
              companions: { tags: [], names: [] },
            };

      const manifest = {
        app: "Reisetagebuch",
        vacation,
        days: ["2026-11-06"],
        places: [
          {
            id: placeId,
            day: "2026-11-06",
            name: "Ort",
            ts: 1000,
            lat: 1,
            lng: 2,
            soft: false,
          },
        ],
        media: [
          { path: photoPath, type: "photo", ts: 1001, placeId, mime: "image/jpeg" },
          { path: smallPath, type: "video", ts: 1002, placeId, mime: "video/mp4" },
          { path: bigPath, type: "video", ts: 1003, placeId, mime: "video/mp4" },
        ],
        notes: [],
      };
      if (format === 2) manifest.format = 2;

      const zip = new ZipWriter();
      await zip.addFile(photoPath, new Blob([photo], { type: "image/jpeg" }), { ts: 1001 });
      await zip.addFile(smallPath, new Blob([smallVideo], { type: "video/mp4" }), { ts: 1002 });
      await zip.addFile(bigPath, new Blob([bigVideo], { type: "video/mp4" }), { ts: 1003 });
      await zip.addTextFile("reise.json", JSON.stringify(manifest));

      let zipFile = new File([zip.finalize()], "persist.zip", { type: "application/zip" });
      if (zipFile.size < 70_000) {
        return { ok: false, err: `ZIP klein (${zipFile.size})` };
      }

      const { vacationId: rid } = await restoreVacationFromZip(zipFile);
      zipFile = null;

      const places = await getPlacesForVacation(rid);
      const media = await getMediaForPlace(places[0].id);
      const p = media.find((m) => m.type === "photo");
      const videos = media
        .filter((m) => m.type === "video")
        .sort((a, b) => (a.blob?.size || 0) - (b.blob?.size || 0));
      if (!p || videos.length < 2) return { ok: false, err: "missing media" };
      if (
        (await digestBlob(p.blob)) !== expected.photo ||
        (await digestBlob(videos[0].blob)) !== expected.smallVideo ||
        (await digestBlob(videos[1].blob)) !== expected.bigVideo
      ) {
        return { ok: false, err: "hash mismatch before reload" };
      }

      return { ok: true, vacationId: rid, expected };
    } catch (e) {
      return { ok: false, err: e?.message || String(e) };
    }
  }, format);

  if (!prep?.ok) throw new Error(`${label}: ${prep.err || "prep failed"}`);

  await page.reload({ waitUntil: "domcontentloaded" });

  const after = await page.evaluate(
    async ({ vacationId, expected }) => {
      const digestBytes = async (bytes) => {
        const d = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(d))
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("");
      };
      const digestBlob = async (blob) => digestBytes(await blob.arrayBuffer());
      const { getPlacesForVacation, getMediaForPlace } = await import("./js/db.js");
      const places = await getPlacesForVacation(vacationId);
      const media = await getMediaForPlace(places[0].id);
      const p = media.find((m) => m.type === "photo");
      const videos = media
        .filter((m) => m.type === "video")
        .sort((a, b) => (a.blob?.size || 0) - (b.blob?.size || 0));
      if (!p || videos.length < 2) return { ok: false, err: "missing media after reload" };
      const ok =
        (await digestBlob(p.blob)) === expected.photo &&
        (await digestBlob(videos[0].blob)) === expected.smallVideo &&
        (await digestBlob(videos[1].blob)) === expected.bigVideo;
      return { ok, err: ok ? undefined : "hash mismatch after reload" };
    },
    { vacationId: prep.vacationId, expected: prep.expected }
  );

  if (!after?.ok) throw new Error(`${label}: ${after.err || "reload check failed"}`);
}

async function assertPartialBackup(page, label) {
  const vacationId = await seedTripUiOnly(page);
  await page.goto("./#/urlaube");
  const result = await page.evaluate(async (vid) => {
    try {
      const { putPlace } = await import("./js/db.js");
      const { createPlace } = await import("./js/places.js");
      const { buildVacationZip } = await import("./js/backup-service.js");
      const { ZipReader } = await import("./js/zip-reader.js");
      const dayA = "2026-11-06";
      const dayB = "2026-11-07";
      await putPlace(
        createPlace({
          vacationId: vid,
          day: dayA,
          ts: 1000,
          lat: 1,
          lng: 1,
          name: "Tag6",
          soft: false,
          source: "test",
        })
      );
      await putPlace(
        createPlace({
          vacationId: vid,
          day: dayB,
          ts: 1001,
          lat: 2,
          lng: 2,
          name: "Tag7",
          soft: false,
          source: "test",
        })
      );
      const { blob } = await buildVacationZip(vid, { daysFilter: [dayA] });
      const file = new File([blob], "teil.zip", { type: "application/zip" });
      const reader = new ZipReader(file);
      await reader.loadCatalog();
      const manifest = await reader.readJSON("reise.json");
      const days = new Set((manifest.places || []).map((p) => p.day));
      if (days.has(dayB) || !days.has(dayA)) {
        return { ok: false, err: `places=${JSON.stringify([...days])}` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, err: e?.message || String(e) };
    }
  }, vacationId);
  if (!result?.ok) throw new Error(result?.err || `${label}: Teil-Sicherung`);
}

async function assertLateCancelRollback(page, label) {
  await page.goto("./");
  await runInPage(page, async () => {
    try {
      const { ZipWriter } = await import("./js/zip-builder.js");
      const { restoreVacationFromZip } = await import("./js/restore-service.js");
      const { createId } = await import("./js/utils.js");
      const { getAllVacations, deleteVacation, deleteVacationData } = await import("./js/db.js");

      for (const v of await getAllVacations()) {
        await deleteVacationData(v.id);
        await deleteVacation(v.id);
      }

      const vacationId = createId();
      const placeId = createId();
      const manifest = {
        format: 2,
        app: "Reisetagebuch",
        vacation: {
          id: vacationId,
          title: "Cancel",
          startDate: "2026-11-06",
          endDate: "2026-11-06",
        },
        days: ["2026-11-06"],
        places: [{ id: placeId, day: "2026-11-06", name: "X", ts: 1, lat: 0, lng: 0, soft: false }],
        media: [],
        notes: [{ placeId, ts: 2, text: "spät" }],
      };
      const zip = new ZipWriter();
      await zip.addTextFile("reise.json", JSON.stringify(manifest));
      const file = new File([zip.finalize()], "c.zip", { type: "application/zip" });

      let cancel = false;
      try {
        await restoreVacationFromZip(file, {
          isCancelled: () => cancel,
          onProgress: ({ phase }) => {
            if (phase === "final") cancel = true;
          },
        });
        return { ok: false, err: "Restore sollte abbrechen" };
      } catch (e) {
        if (e?.code !== "cancelled") {
          return { ok: false, err: e?.message || String(e) };
        }
      }
      const left = await getAllVacations();
      if (left.length > 0) {
        return { ok: false, err: `Reise noch da (${left.length})` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, err: e?.message || String(e) };
    }
  });
}

async function assertRestoreNavigation(page, baseUrl, label) {
  await page.goto(`${baseUrl}#/urlaube`);
  await page.waitForSelector('[data-testid="urlaube-restore-link"], [data-testid="urlaube-empty"]');

  const zipPath = path.join(await mkdtemp(path.join(tmpdir(), "vacrecap-zip-")), "nav.zip");
  const zipBytes = await page.evaluate(async () => {
    const { ZipWriter } = await import("./js/zip-builder.js");
    const { createId } = await import("./js/utils.js");
    const vacationId = createId();
    const placeId = createId();
    const manifest = {
      format: 2,
      app: "Reisetagebuch",
      vacation: {
        id: vacationId,
        title: "Nav",
        startDate: "2026-11-06",
        endDate: "2026-11-06",
      },
      days: ["2026-11-06"],
      places: [{ id: placeId, day: "2026-11-06", name: "N", ts: 1, lat: 0, lng: 0, soft: false }],
      media: [],
      notes: [],
    };
    const zip = new ZipWriter();
    await zip.addTextFile("reise.json", JSON.stringify(manifest));
    const blob = zip.finalize();
    return { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), vacationId };
  });
  await writeFile(zipPath, Buffer.from(zipBytes.bytes));

  const input = page.locator('[data-testid="restore-zip-input"]');
  await input.setInputFiles(zipPath);
  await page.waitForSelector('[data-testid="trip-content"]', { timeout: 120_000 });
  await page.waitForTimeout(400);
  const hash = await page.evaluate(() => window.location.hash);
  if (!hash.includes("/urlaub/")) {
    throw new Error(`${label}: Hash nach Einspielen falsch (${hash})`);
  }
  await rm(path.dirname(zipPath), { recursive: true, force: true });
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

async function assertVersionVisible(page, vacationId, label) {
  await page.goto(`./#/urlaub/${vacationId}/einstellungen`);
  await page.waitForSelector('[data-testid="settings-screen"]');
  const line = await page.locator('[data-testid="app-version-line"]').innerText();
  const v = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  if (!line.includes(`Version ${v}`)) {
    throw new Error(`${label}: Versionszeile (${line})`);
  }
}

async function main() {
  const { server, baseUrl } = await startServer();
  const chromiumBrowser = await chromium.launch();
  const chromiumCtx = await chromiumBrowser.newContext({ baseURL: baseUrl, ...CONTEXT_OPTS });
  const chromiumPage = await chromiumCtx.newPage();
  chromiumPage.setDefaultTimeout(600_000);

  await assertSyntheticRoundtrip(chromiumPage, "5n-chromium-synth");
  await assertMediaHashesAfterReload(chromiumPage, "5n-chromium-reload-f2", { format: 2 });
  await assertMediaHashesAfterReload(chromiumPage, "5n-chromium-reload-f1", { format: 1 });
  await assertPartialBackup(chromiumPage, "5n-partial");

  const cancelCtx = await chromiumBrowser.newContext({ baseURL: baseUrl, ...CONTEXT_OPTS });
  const cancelPage = await cancelCtx.newPage();
  cancelPage.setDefaultTimeout(180_000);
  await assertLateCancelRollback(cancelPage, "5n-late-cancel");
  await cancelCtx.close();

  const navCtx = await chromiumBrowser.newContext({ baseURL: baseUrl, ...CONTEXT_OPTS });
  const navPage = await navCtx.newPage();
  navPage.setDefaultTimeout(180_000);
  await assertRestoreNavigation(navPage, baseUrl, "5n-nav");
  await navCtx.close();

  const webkitUserData = await mkdtemp(path.join(tmpdir(), "vacrecap-wk-"));
  const webkitCtx = await webkit.launchPersistentContext(webkitUserData, {
    baseURL: baseUrl,
    ...CONTEXT_OPTS,
  });
  const webkitPage = webkitCtx.pages()[0] || (await webkitCtx.newPage());
  webkitPage.setDefaultTimeout(600_000);

  await assertSyntheticRoundtrip(webkitPage, "5n-webkit-synth");
  await assertMediaHashesAfterReload(webkitPage, "5n-webkit-reload-f2", { format: 2 });
  await assertMediaHashesAfterReload(webkitPage, "5n-webkit-reload-f1", { format: 1 });

  await chromiumPage.goto(baseUrl);
  await assertBadZips(chromiumPage, "5n-bad");

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

  await chromiumCtx.close();
  await chromiumBrowser.close();
  await webkitCtx.close();
  await rm(webkitUserData, { recursive: true, force: true });
  server.close();
  console.log("Playwright 5n tests OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
