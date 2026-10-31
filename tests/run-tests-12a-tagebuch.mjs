import { chromium, devices, webkit } from "playwright";
import { matchHeading, parseDiary } from "../js/diary-parser.js";
import {
  buildDiaryContent,
  countSentences,
  createDiaryModel,
  dayBody,
  omitLine,
  reassignLine,
} from "../js/diary-model.js";
import {
  TRIP,
  USER,
  createMockSupabaseState,
  installSupabaseMocks,
  recapUniqueError,
  recapUniqueViolation,
  startServer,
} from "./run-tests-12b-recap-video.mjs";

const T = { startDate: "2025-06-16", endDate: "2025-06-20" };
const INTRO = "Fünf Tage Gardasee, endlich wieder Sonne.";
const MON = "Früh los in Augsburg, am Brenner kaum Stau.\nAm Nachmittag in Navene angekommen.";
const TUE = "Mit dem Rad zum Hafen von Malcesine. Gelato mit Pistazie, danach hoch zum Castello Scaligero.";
const WED = "Limone am Vormittag. Am Nachmittag auf den Monte Baldo.";
const THU = "Torbole und die Burg. Am Abend in Garda.";
const FRI = "Letztes Eis in Riva, dann Heimfahrt.";
const GARDA = [INTRO, "", "Montag", MON, "", "Dienstag", TUE, "", "Mittwoch", WED, "", "Donnerstag", THU, "", "Freitag", FRI].join("\n");
const NO_HEAD = "Montag waren wir müde.\nSo war das.\nMo hat geregnet.";
const OUTSIDE = "Montag\nAm See.\n\nSamstag\nMarkt.";

const VIEWPORTS = [
  { width: 375, height: 667 },
  { width: 360, height: 740 },
  { width: 390, height: 844 },
];

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function runUnitTests() {
  const txt = `Fünf Tage Gardasee, endlich wieder Sonne.\n\nMontag\nFrüh los.\n\nDienstag\nMalcesine.\n\nMittwoch:\nLimone.\n\n## Donnerstag\nBadetag.\n\nFr\nHeim.`;
  let parsed = parseDiary(txt, T);
  assert(parsed.recognized === 5, "Gardasee recognized");
  assert(parsed.intro === "Fünf Tage Gardasee, endlich wieder Sonne.", parsed.intro);
  assert(parsed.days[2].text === "Limone.", parsed.days[2].text);
  assert(matchHeading("Montag: Früh los").inline === "Früh los", "inline");
  assert(matchHeading("**Dienstag**").weekday === 2, "fett");
  assert(matchHeading("Mi.").weekday === 3, "Mi.");
  assert(matchHeading("Donnerstag, 19.06.").day === 19, "Datum");
  assert(matchHeading("So war das.") === null, "So war das");
  assert(matchHeading("Montag waren wir müde.") === null, "Satz");
  assert(matchHeading("Mo hat geregnet") === null, "Kurzform");
  parsed = parseDiary("Montag\na\n\nSamstag\nb", T);
  assert(parsed.unassigned.length === 1, "Samstag");
  assert(parsed.hints.some((hint) => hint.type === "weekday-not-in-trip"), "Hinweis außerhalb");
  parsed = parseDiary("Montag\nerster\n\nDienstag\nx\n\nMontag\nzweiter", { startDate: "2025-06-16", endDate: "2025-06-25" });
  assert(parsed.days[0].text === "erster", parsed.days[0].text);
  assert(parsed.days[7].text === "zweiter", parsed.days[7].text);
  assert(parsed.hints.some((hint) => hint.type === "weekday-repeats"), "Wiederholung");
  parsed = parseDiary("Montag\na\n\nDienstag\nb\n\nMontag\nc", T);
  assert(parsed.days[0].text === "a\n\nc", parsed.days[0].text);
  assert(parsed.hints.some((hint) => hint.type === "appended-to-earlier"), "angehängt");

  const garda = parseDiary(GARDA, T);
  assert(garda.recognized === 5 && garda.intro === INTRO, "Gardasee-Text");
  assert(garda.days[0].text === MON && garda.days[1].text === TUE && garda.days[4].text === FRI, "Tagestexte");
  assert(countSentences(garda.intro) === 1 && countSentences(garda.days[0].text) === 2, "Sätze");
  assert(countSentences(garda.days[4].text) === 1, "Freitag ein Satz");

  const outside = createDiaryModel(parseDiary(OUTSIDE, T));
  assert(outside.loose.length === 1, "loose");
  reassignLine(outside, outside.loose[0].line, "2025-06-20");
  assert(outside.loose.length === 0 && dayBody(outside.days[4]).includes("Markt"), "Tag wählen");
  const again = createDiaryModel(parseDiary(OUTSIDE, T));
  omitLine(again, again.loose[0].line);
  assert(again.loose.length === 0 && !dayBody(again.days[4]).includes("Markt"), "weglassen");

  const content = buildDiaryContent(createDiaryModel(garda), {
    places: [
      { id: "p-navene", name: "Navene", day: "2025-06-16", ts: 2, soft: false },
      { id: "p-soft", name: "Weich", day: "2025-06-16", ts: 1, soft: true },
      { id: "p-hafen", name: "Hafen Malcesine", day: "2025-06-17", ts: 3, soft: false },
    ],
    photos: [
      { id: "b", day: "2025-06-16", ts: 2, type: "photo", uploadStatus: "uploaded" },
      { id: "a", day: "2025-06-16", ts: 1, type: "photo", uploadStatus: "uploaded" },
      { id: "c", day: "2025-06-16", ts: 2, type: "photo", uploadStatus: "uploaded" },
      { id: "d", day: "2025-06-16", ts: 4, type: "photo", uploadStatus: "uploaded" },
      { id: "vid", day: "2025-06-16", ts: 0, type: "video", uploadStatus: "uploaded" },
    ],
  });
  assert(content.parser_version === 1 && content.intro === INTRO, "content");
  assert(content.days[0].heading === "Montag" && content.days[0].text === MON, "Montag bleibt");
  assert(content.days[0].media_ids.join(",") === "a,b,c", content.days[0].media_ids.join(","));
  assert(content.days[0].waypoint_ids.join(",") === "p-navene", content.days[0].waypoint_ids.join(","));
  assert(content.days[1].waypoint_ids[0] === "p-hafen", "Dienstag-Ort");

  const notes = [{ id: "a", trip_id: "t", kind: "diary", status: "notes" }];
  assert(recapUniqueViolation(notes, { id: "b", trip_id: "t", kind: "diary", status: "notes" }), "notes-index");
  assert(!recapUniqueViolation(notes, { id: "a", trip_id: "t", kind: "diary", status: "notes" }), "gleiche Zeile");
  assert(!recapUniqueViolation(notes, { id: "b", trip_id: "t", kind: "diary", status: "draft" }), "Entwurf frei");
  const finals = [{ id: "f", trip_id: "t", kind: "diary", status: "final" }];
  assert(recapUniqueViolation(finals, { id: "g", trip_id: "t", kind: "diary", status: "final" }), "final-index");
  assert(!recapUniqueViolation(finals, { id: "g", trip_id: "t", kind: "video", status: "final" }), "anderes kind");
  const notesErr = recapUniqueError("notes");
  assert(notesErr.status === 409 && notesErr.json.code === "23505", "409");
  assert(notesErr.json.message.includes("trip_recaps_one_notes"), notesErr.json.message);
  assert(recapUniqueError("final").json.message.includes("trip_recaps_one_final"), "final name");
  console.log("Tagebuch-Unit-Tests grün");
}

function realErrors(list) {
  return list.filter((entry) => !/access control checks/i.test(entry));
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

async function openTrip(page) {
  await page.locator(`[data-vacation-id="${TRIP}"]`).click();
  await page.waitForSelector('[data-testid="trip-content"]');
}

async function reloadHome(page) {
  const home = page.url().split("#")[0];
  await page.goto(home);
  await page.waitForSelector(".screen--urlaube, [data-testid='login-screen']");
  if (await page.locator('[data-testid="login-screen"]').count()) await login(page, home);
  await page.waitForSelector(".screen--urlaube");
}

async function openDiary(page) {
  if ((await page.locator('[data-testid="trip-content"]').count()) === 0) await openTrip(page);
  await page.click('[data-action="settings"]');
  await page.waitForSelector('[data-testid="settings-diary"]');
  await page.click('[data-testid="settings-diary"]');
  await page.waitForSelector('[data-testid="diary-screen"]');
}

function notesOf(state) {
  return state.recaps.filter((row) => row.kind === "diary" && row.trip_id === TRIP && row.status === "notes");
}

function draftsOf(state) {
  return state.recaps.filter((row) => row.kind === "diary" && row.trip_id === TRIP && row.status === "draft" && !row.deleted_at);
}

function finalsOf(state) {
  return state.recaps.filter((row) => row.kind === "diary" && row.trip_id === TRIP && row.status === "final" && !row.deleted_at);
}

async function recognize(page, text) {
  await page.fill('[data-testid="diary-source"]', text);
  await page.click('[data-testid="diary-action"]');
  await page.waitForSelector('[data-testid="diary-preview"]');
}

async function runFlows(page, state, label) {
  const build = await page.evaluate(async () => (await import("./js/app-version.js")).APP_BUILD_VERSION);
  assert(Number(build) === 64, `${label}: Build ${build}`);

  await openTrip(page);
  await page.click('[data-action="settings"]');
  await page.waitForSelector('[data-testid="settings-diary"]');
  const settingsLabel = await page.locator('[data-testid="settings-diary"]').innerText();
  assert(settingsLabel.includes("Reisetagebuch erstellen"), `${label}: Zahnrad «${settingsLabel}»`);
  await page.click('[data-action="back"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  await page.locator('[data-day="2025-06-20"]').click();
  await page.waitForSelector('[data-testid="recap-diary"]');
  assert(!(await page.locator('[data-testid="recap-diary"]').isDisabled()), `${label}: Karte deaktiviert`);
  const cardLabel = await page.locator('[data-testid="recap-diary"]').innerText();
  assert(/erstellen/i.test(cardLabel) && !/bald/i.test(cardLabel), `${label}: Karte «${cardLabel}»`);
  await page.click('[data-testid="recap-diary"]');
  await page.waitForSelector('[data-testid="diary-source"]');
  const help = await page.locator('[data-testid="diary-help"]').innerText();
  assert(help.includes("eigene Zeile"), `${label}: Hilfe «${help}»`);
  assert(await page.locator('[data-testid="diary-action"]').isDisabled(), `${label}: leeres Feld erkennt schon`);
  assert((await page.locator('[data-testid="diary-source"]').getAttribute("maxlength")) === "30000", `${label}: maxlength`);
  assert((await page.locator('[data-testid="diary-count"]').innerText()).includes("0 Zeichen"), `${label}: Zähler`);

  const clipReady = await page.evaluate(() => Boolean(window.__diaryClipReady));
  if (clipReady) {
    await page.evaluate(() => {
      window.__diaryClip.fail = true;
      window.__diaryClip.text = "";
    });
    await page.click('[data-testid="diary-paste"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="diary-source"]').value === "");
    assert((await page.locator('[data-testid="app-toast"]').count()) === 0, `${label}: Einfügen zeigt einen Fehler`);
    await page.evaluate(() => {
      window.__diaryClip.fail = false;
      window.__diaryClip.text = "Montag\nAus der Zwischenablage.";
    });
    await page.click('[data-testid="diary-paste"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="diary-source"]').value.includes("Zwischenablage"));
    await page.click('[data-testid="diary-clear"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="diary-source"]').value === "");
  } else {
    await page.click('[data-testid="diary-paste"]');
    assert((await page.locator('[data-testid="app-toast"]').count()) === 0, `${label}: Einfügen ohne Zwischenablage zeigt einen Fehler`);
  }

  await recognize(page, NO_HEAD);
  const noWeek = await page.locator('[data-testid="diary-no-weekdays"]').innerText();
  assert(noWeek.includes("Keine Wochentage gefunden"), `${label}: «${noWeek}»`);
  assert((await page.locator('[data-testid="diary-source"]').inputValue()).includes("müde"), `${label}: Text weg`);
  const bareIntro = await page.locator('[data-testid="diary-preview-intro"]').innerText();
  assert(bareIntro.includes("Einleitung") && /Sätz/.test(bareIntro), `${label}: Einleitung «${bareIntro}»`);
  assert(!(await page.locator('[data-testid="diary-preview"]').innerText()).includes("«Montag»"), `${label}: Satz als Überschrift`);
  assert((await page.locator('[data-testid="diary-action"]').innerText()).includes("Trotzdem übernehmen"), `${label}: Button`);
  await page.click('[data-testid="diary-action"]');
  await page.waitForSelector('[data-testid="diary-draft"]');
  const forced = draftsOf(state)[0];
  assert(forced && forced.content.intro.includes("müde"), `${label}: Entwurf ohne Überschrift`);
  assert(forced.content.days.every((day) => !String(day.text || "").trim()), `${label}: Tage ohne Text haben Text`);
  assert(forced.content.days[0].media_ids.length === 3, `${label}: Fotos trotz leerem Text`);
  assert(forced.content.hints.some((hint) => hint.type === "no-weekdays"), `${label}: Hinweis fehlt im Inhalt`);
  assert(notesOf(state).length === 1 && notesOf(state)[0].source_text === NO_HEAD, `${label}: Notizen`);
  await page.click('[data-testid="diary-discard"]');
  await page.waitForSelector('[data-testid="diary-discard-confirm"]');
  await page.click('[data-testid="diary-discard-confirm"] [data-action="confirm"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  assert(draftsOf(state).length === 0, `${label}: Verwerfen löscht den Entwurf nicht`);
  assert(notesOf(state).length === 1 && notesOf(state)[0].source_text === NO_HEAD, `${label}: Notizen nach Verwerfen weg`);

  await openDiary(page);
  await page.waitForFunction(() => document.querySelector('[data-testid="diary-source"]')?.value.includes("müde"));
  await page.click('[data-testid="diary-clear"]');
  await recognize(page, OUTSIDE);
  await page.waitForSelector('[data-testid="diary-unassigned"]');
  const outsideText = await page.locator('[data-testid="diary-unassigned"]').innerText();
  assert(outsideText.includes("nicht zugeordnet") && outsideText.includes("Tag wählen") && outsideText.includes("weglassen"), `${label}: «${outsideText}»`);
  await page.locator('[data-testid="diary-pick"][data-line="Samstag"]').click();
  await page.waitForSelector('[data-testid="diary-day-picker"]');
  await page.locator('[data-testid="diary-day-option"][data-date="2025-06-20"]').click();
  await page.waitForSelector('[data-testid="diary-day-picker"]', { state: "detached" });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="diary-unassigned"]').length === 0);
  const friday = await page.locator('[data-testid="diary-preview-day"][data-date="2025-06-20"]').innerText();
  assert(friday.includes("«Samstag»"), `${label}: Tag wählen «${friday}»`);
  await page.click('[data-testid="diary-clear"]');
  await recognize(page, OUTSIDE);
  await page.locator('[data-testid="diary-omit"][data-line="Samstag"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="diary-unassigned"]').length === 0);
  const fridayAfter = await page.locator('[data-testid="diary-preview-day"][data-date="2025-06-20"]').innerText();
  assert(!fridayAfter.includes("Samstag") && !fridayAfter.includes("Markt"), `${label}: weglassen lässt den Text «${fridayAfter}»`);

  await page.click('[data-testid="diary-clear"]');
  await page.fill('[data-testid="diary-source"]', GARDA);
  const counted = await page.locator('[data-testid="diary-count"]').innerText();
  assert(counted.includes(new Intl.NumberFormat("de-DE").format([...GARDA].length)), `${label}: Zähler «${counted}»`);
  await page.click('[data-testid="diary-action"]');
  await page.waitForSelector('[data-testid="diary-preview-title"]');
  const title = await page.locator('[data-testid="diary-preview-title"]').innerText();
  assert(title.includes("5 Tage erkannt") && title.includes("Einleitung"), `${label}: «${title}»`);
  const introLine = await page.locator('[data-testid="diary-preview-intro"]').innerText();
  assert(introLine.includes("Text vor «Montag»") && introLine.includes("1 Satz"), `${label}: Einleitung «${introLine}»`);
  const previewDays = await page.locator('[data-testid="diary-preview-day"]').allInnerTexts();
  assert(previewDays.length === 5, `${label}: ${previewDays.length} Vorschautage`);
  assert(previewDays[0].includes("Anreise") && previewDays[0].includes("«Montag»") && previewDays[0].includes("2 Sätze"), `${label}: ${previewDays[0]}`);
  assert(previewDays[1].includes("2. Tag") && previewDays[1].includes("«Dienstag»"), `${label}: ${previewDays[1]}`);
  assert(previewDays[4].includes("Abreise") && previewDays[4].includes("1 Satz"), `${label}: ${previewDays[4]}`);
  assert((await page.locator('[data-testid="diary-ok"]').count()) === 5, `${label}: Häkchen`);
  assert((await page.locator('[data-testid="diary-action"]').innerText()).includes("Entwurf erstellen"), `${label}: Aktion`);
  await page.click('[data-testid="diary-action"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="diary-kicker"]')?.textContent?.includes("Entwurf 1"));
  const draft = draftsOf(state)[0];
  assert(draft && draft.version === 1 && !draft.based_on, `${label}: erster Entwurf`);
  assert(draft.content.parser_version === 1 && draft.content.intro === INTRO, `${label}: Intro verändert`);
  assert(draft.content.days[0].text === MON, `${label}: Montag umformuliert «${draft.content.days[0].text}»`);
  assert(draft.content.days[1].text === TUE, `${label}: Dienstag`);
  assert(draft.content.days[0].heading === "Montag", `${label}: Überschrift`);
  assert(draft.content.days[0].media_ids.join(",") === "p-navene-m0,p-navene-m1,p-navene-m2", draft.content.days[0].media_ids.join(","));
  assert(draft.content.days[0].waypoint_ids.join(",") === "p-navene", draft.content.days[0].waypoint_ids.join(","));
  assert(
    draft.content.days[1].waypoint_ids.join(",") === "p-hafen,p-castello",
    draft.content.days[1].waypoint_ids.join(",")
  );
  assert(notesOf(state).length === 1 && notesOf(state)[0].source_text === GARDA, `${label}: Notizen nicht aktualisiert`);
  const shown = await page.locator('[data-testid="diary-day"][data-date="2025-06-16"]').innerText();
  assert(shown.includes("Montag, 16.06.") && shown.includes("Anreise") && shown.includes("Navene"), `${label}: Karte «${shown}»`);
  assert(shown.includes("Früh los in Augsburg"), `${label}: Kartentext`);
  const tueCard = await page.locator('[data-testid="diary-day"][data-date="2025-06-17"]').innerText();
  assert(tueCard.includes("Hafen Malcesine") && tueCard.includes("Castello Scaligero"), `${label}: Orte «${tueCard}»`);
  const photoIds = await page
    .locator('[data-testid="diary-day"][data-date="2025-06-16"] [data-testid="diary-photo"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-media-id")));
  assert(photoIds.join(",") === "p-navene-m0,p-navene-m1,p-navene-m2", `${label}: Fotos ${photoIds}`);
  const photoSrc = await page.locator('[data-testid="diary-day"][data-date="2025-06-16"] [data-testid="diary-photo"]').first().getAttribute("src");
  assert(photoSrc, `${label}: Thumb ohne Adresse`);
  assert((await page.locator('[data-testid="diary-intro"]').getAttribute("class"))?.includes("diary-intro"), `${label}: Einleitung nicht kursiv`);
  assert((await page.locator('[data-testid="diary-intro"]').innerText()).includes(INTRO), `${label}: Einleitungstext`);

  await page.locator('[data-testid="diary-edit"][data-date="2025-06-16"]').click();
  await page.waitForSelector('[data-testid="diary-edit-text"]');
  const before = await page.locator('[data-testid="diary-edit-text"]').inputValue();
  await page.fill('[data-testid="diary-edit-text"]', `${before} ZUSATZ-STIFT.`);
  await page.click('[data-testid="diary-edit-save"]');
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="diary-day"][data-date="2025-06-16"]')?.textContent?.includes("ZUSATZ-STIFT")
  );
  assert(draft.content.days[0].text.includes("ZUSATZ-STIFT") && draft.content.days[0].text.includes("Früh los in Augsburg"), `${label}: Stift`);
  assert(!draft.content.days[1].text.includes("ZUSATZ-STIFT"), `${label}: Stift schreibt andere Tage`);

  await page.evaluate(() => document.querySelector('[data-testid="app-toast"]')?.remove());
  await page.fill('[data-testid="diary-feedback-input"]', "Einleitung kürzer");
  await page.click('[data-testid="diary-feedback-send"]');
  await page.waitForSelector('[data-testid="app-toast"]');
  assert(draft.feedback?.length === 1 && draft.feedback[0].text === "Einleitung kürzer", `${label}: Feedback`);
  assert(draft.feedback[0].status === "open" && draft.feedback[0].by === USER && draft.feedback[0].version === 1, `${label}: Feedback-Felder`);

  await page.click('[data-testid="diary-adopt"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="diary-kicker"]')?.textContent?.trim() === "Final");
  assert((await page.locator('[data-testid="diary-discard"]').count()) === 0, `${label}: Final verwerfbar`);
  assert((await page.locator('[data-testid="diary-edit"]').count()) === 0, `${label}: Final hat einen Stift`);
  assert((await page.locator('[data-testid="diary-new-draft"]').count()) === 1, `${label}: Neuer Entwurf fehlt`);
  assert(draft.status === "final" && draft.finalized_at && !draft.deleted_at, `${label}: erstes Übernehmen`);
  assert(finalsOf(state).length === 1, `${label}: zwei Finals`);

  const insertsBefore = state.recapOps.filter((op) => op === "insert").length;
  await page.click('[data-action="back"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  await reloadHome(page);
  await openDiary(page);
  await page.waitForFunction(() => document.querySelector('[data-testid="diary-kicker"]')?.textContent?.trim() === "Final");
  assert(state.recapOps.filter((op) => op === "insert").length === insertsBefore, `${label}: Öffnen legt einen Entwurf an`);
  assert((await page.locator('[data-testid="diary-feedback-input"]').count()) === 0, `${label}: Final bearbeitbar`);

  await page.click('[data-testid="diary-new-draft"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="diary-kicker"]')?.textContent?.includes("Entwurf 2"));
  const second = draftsOf(state)[0];
  assert(second && second.version === 2 && second.based_on === draft.id, `${label}: Version ${second?.version}`);
  assert(second.content.days[0].text.includes("ZUSATZ-STIFT"), `${label}: neuer Entwurf verliert den Text`);
  assert(finalsOf(state).length === 1, `${label}: Final beim neuen Entwurf weg`);

  const keptFinalized = draft.finalized_at;
  await page.evaluate(() => document.querySelector('[data-testid="app-toast"]')?.remove());
  state.failPatch = "park";
  const opsAtPark = state.recapOps.length;
  await page.click('[data-testid="diary-adopt"]');
  await page.waitForFunction(() => /fehlgeschlagen/i.test(document.querySelector('[data-testid="app-toast"]')?.textContent || ""));
  assert(second.status === "draft" && !second.finalized_at, `${label}: Parken-Fehler übernimmt`);
  assert(draft.status === "final" && !draft.deleted_at && draft.finalized_at === keptFinalized, `${label}: Parken-Fehler verändert das Final`);
  assert(!state.recapOps.slice(opsAtPark).includes("promote") && !state.recapOps.slice(opsAtPark).includes("delete"), `${label}: Parken-Fehler macht weiter`);

  await page.evaluate(() => document.querySelector('[data-testid="app-toast"]')?.remove());
  state.failPatch = "promote";
  const opsAtPromote = state.recapOps.length;
  await page.click('[data-testid="diary-adopt"]');
  await page.waitForFunction(() => /fehlgeschlagen/i.test(document.querySelector('[data-testid="app-toast"]')?.textContent || ""));
  assert(second.status === "draft" && !second.finalized_at, `${label}: Rollback übernimmt den Entwurf`);
  assert(draft.status === "final" && !draft.deleted_at && draft.finalized_at === keptFinalized, `${label}: Rollback stellt das Final nicht her`);
  assert(!state.recaps.some((row) => row.kind === "diary" && row.deleted_at), `${label}: Papierkorb nach Rollback`);
  const promoteOps = state.recapOps.slice(opsAtPromote);
  assert(promoteOps.includes("park") && promoteOps.includes("promote-fail") && promoteOps.includes("restore"), `${label}: Rollback ${promoteOps}`);
  assert(!promoteOps.includes("delete"), `${label}: Rollback löscht`);

  await page.evaluate(() => document.querySelector('[data-testid="app-toast"]')?.remove());
  const opsAtReplace = state.recapOps.length;
  await page.click('[data-testid="diary-adopt"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="diary-kicker"]')?.textContent?.trim() === "Final");
  assert(!state.recaps.some((row) => row.id === draft.id), `${label}: alte Fassung bleibt`);
  assert(second.status === "final" && !second.deleted_at, `${label}: zweites Übernehmen`);
  assert(finalsOf(state).length === 1, `${label}: zwei Finals nach Ersetzen`);
  const replaceOps = state.recapOps.slice(opsAtReplace);
  assert(
    replaceOps.indexOf("park") >= 0 &&
      replaceOps.indexOf("promote") > replaceOps.indexOf("park") &&
      replaceOps.indexOf("delete") > replaceOps.indexOf("promote"),
    `${label}: Reihenfolge ${replaceOps}`
  );

  state.recaps.push({
    id: "trash-diary",
    trip_id: TRIP,
    kind: "diary",
    status: "draft",
    version: 9,
    source_text: null,
    content: {
      parser_version: 1,
      intro: "PAPIERKORB-MARKER",
      days: [{ date: "2025-06-16", heading: "Montag", text: "PAPIERKORB-MARKER", media_ids: [], waypoint_ids: [] }],
      hints: [],
    },
    feedback: [],
    deleted_at: "2026-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2099-01-01T00:00:00.000Z",
    finalized_at: null,
    created_by: USER,
    based_on: null,
  });
  await page.click('[data-action="back"]');
  await reloadHome(page);
  await openDiary(page);
  await page.waitForFunction(() => document.querySelector('[data-testid="diary-kicker"]')?.textContent?.trim() === "Final");
  const visible = await page.locator('[data-testid="diary-screen"]').innerText();
  assert(!visible.includes("PAPIERKORB-MARKER"), `${label}: Papierkorb sichtbar`);
  assert(visible.includes("ZUSATZ-STIFT"), `${label}: Final nach Papierkorb weg`);

  await page.click('[data-testid="diary-new-draft"]');
  await page.waitForSelector('[data-testid="diary-discard"]');
  const third = draftsOf(state)[0];
  assert(third && third.version === 3, `${label}: dritte Version ${third?.version}`);
  await page.click('[data-testid="diary-discard"]');
  await page.click('[data-testid="diary-discard-confirm"] [data-action="confirm"]');
  await page.waitForSelector('[data-testid="trip-content"]');
  assert(!state.recaps.some((row) => row.id === third.id), `${label}: Verwerfen löscht nicht`);
  assert(notesOf(state).length === 1 && notesOf(state)[0].source_text === GARDA, `${label}: Notizen beim zweiten Verwerfen`);
  assert(state.recaps.some((row) => row.id === second.id && row.status === "final"), `${label}: Final mitverworfen`);

  state.role = "editor";
  await reloadHome(page);
  await openDiary(page);
  await page.waitForSelector('[data-testid="diary-new-draft"]');
  await page.click('[data-testid="diary-new-draft"]');
  await page.waitForSelector('[data-testid="diary-feedback-input"]');
  await page.locator('[data-testid="diary-edit"][data-date="2025-06-16"]').click();
  await page.waitForSelector('[data-testid="diary-edit-text"]');
  const editorBefore = await page.locator('[data-testid="diary-edit-text"]').inputValue();
  await page.fill('[data-testid="diary-edit-text"]', `${editorBefore}\nNUR-ENTWURF.`);
  await page.click('[data-testid="diary-edit-save"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="diary-day-text"]')?.textContent?.includes("NUR-ENTWURF"));
  await page.evaluate(() => document.querySelector('[data-testid="app-toast"]')?.remove());
  await page.fill('[data-testid="diary-feedback-input"]', "noch ruhiger");
  await page.click('[data-testid="diary-feedback-send"]');
  await page.waitForSelector('[data-testid="app-toast"]');
  const editorDraft = draftsOf(state)[0];
  assert(editorDraft?.version === 3, `${label}: Mitbearbeiter-Version ${editorDraft?.version}`);
  assert(editorDraft?.feedback?.some((item) => item.text === "noch ruhiger"), `${label}: Mitbearbeiter ohne Feedback`);

  for (const role of ["viewer", "contributor"]) {
    state.role = role;
    await reloadHome(page);
    await openTrip(page);
    await page.locator('[data-day="2025-06-20"]').click();
    await page.waitForSelector('[data-testid="recap-diary-final"]');
    assert((await page.locator('[data-testid="recap-diary"]').count()) === 0, `${label}: ${role} darf erstellen`);
    await page.click('[data-action="settings"]');
    const seen = await page.locator('[data-testid="settings-diary"]').innerText();
    assert(seen.includes("ansehen"), `${label}: ${role} Menü «${seen}»`);
    await page.click('[data-testid="settings-diary"]');
    await page.waitForSelector('[data-testid="diary-draft"]');
    const text = await page.locator('[data-testid="diary-screen"]').innerText();
    assert(text.includes("Final") && text.includes("ZUSATZ-STIFT"), `${label}: ${role} sieht das Final nicht`);
    assert(!text.includes("NUR-ENTWURF") && !text.includes("noch ruhiger"), `${label}: ${role} sieht den Entwurf`);
    assert((await page.locator('[data-testid="diary-new-draft"]').count()) === 0, `${label}: ${role} legt Entwürfe an`);
    assert((await page.locator('[data-testid="diary-feedback-input"]').count()) === 0, `${label}: ${role} Feedback`);
    assert((await page.locator('[data-testid="diary-edit"]').count()) === 0, `${label}: ${role} Stift`);
    assert((await page.locator('[data-testid="diary-source"]').count()) === 0, `${label}: ${role} sieht die Notizen`);
  }

  state.role = "owner";
  state.roleError = true;
  const insertsBeforeRole = state.recapOps.filter((op) => op === "insert").length;
  await reloadHome(page);
  await openDiary(page);
  await page.waitForFunction(() => document.querySelector('[data-testid="diary-kicker"]')?.textContent?.trim() === "Final");
  assert((await page.locator('[data-testid="diary-new-draft"]').count()) === 0, `${label}: Rollenfehler legt Entwürfe an`);
  assert(!((await page.locator('[data-testid="diary-screen"]').innerText()).includes("NUR-ENTWURF")), `${label}: Rollenfehler zeigt den Entwurf`);
  assert(state.recapOps.filter((op) => op === "insert").length === insertsBeforeRole, `${label}: Rollenfehler schreibt`);
  state.roleError = false;

  state.role = "owner";
  state.recapMissing = true;
  await reloadHome(page);
  await openDiary(page);
  await page.waitForSelector('[data-testid="diary-unavailable"]');
  const missing = await page.locator('[data-testid="diary-unavailable"]').innerText();
  assert(missing.includes("Reisetagebuch ist noch nicht verfügbar."), `${label}: «${missing}»`);
}

async function runSuite(browserType, baseUrl, label, viewport) {
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({
    ...devices["iPhone 8"],
    viewport,
    baseURL: baseUrl,
    permissions: ["geolocation"],
  });
  await context.addInitScript(() => {
    const store = { text: "", fail: true };
    window.__diaryClip = store;
    const clip = {
      async readText() {
        if (store.fail) throw new DOMException("NotAllowedError", "NotAllowedError");
        return store.text || "";
      },
    };
    try {
      Object.defineProperty(navigator, "clipboard", { configurable: true, get: () => clip });
      window.__diaryClipReady = true;
    } catch {
      window.__diaryClipReady = false;
    }
  });
  await context.setGeolocation({ latitude: 45.88, longitude: 10.84 });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const state = createMockSupabaseState();
  await installSupabaseMocks(page, state);
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  const where = `${label} ${viewport.width}x${viewport.height}`;
  try {
    await login(page, baseUrl);
    await runFlows(page, state, where);
    const errors = realErrors(pageErrors);
    assert(errors.length === 0, `${where}: ${errors.join(" | ")}`);
    console.log(`Playwright 12a tests OK (${where}, Build 64)`);
  } finally {
    await browser.close();
  }
}

runUnitTests();

const { server, baseUrl } = await startServer();
try {
  for (const viewport of VIEWPORTS) {
    await runSuite(chromium, baseUrl, "Chromium", viewport);
    await runSuite(webkit, baseUrl, "WebKit", viewport);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
console.log("Playwright 12a tagebuch tests OK (Build 64)");
