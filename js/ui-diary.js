import { RecapUnavailableError } from "./cloud-errors.js";
import { dayColorFor } from "./day-colors.js";
import { dayIndexInTrip, dayRoleLabel, vacationDays } from "./days.js";
import { getVacation } from "./db.js";
import {
  buildDiaryContent,
  clampDiaryText,
  countSentences,
  createDiaryModel,
  dayBody,
  diaryEndDate,
  DIARY_TEXT_MAX,
  omitLine,
  reassignLine,
  refreshDiaryContent,
} from "./diary-model.js";
import { matchHeading, parseDiary } from "./diary-parser.js";
import { ICON_BACK_CHEVRON } from "./icons.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import {
  adoptRecapDraft,
  appendRecapFeedback,
  createDiaryDraft,
  discardRecapDraft,
  listDiaryRecaps,
  loadRecapMaterial,
  saveDiaryNotes,
  updateRecapContent,
} from "./recap-service.js";
import { navigate } from "./router.js";
import { showToast, showWarnToast } from "./toast.js";
import { resolveTripEditing, ROLE_UNKNOWN_MESSAGE, tripRoleLoadFailed } from "./trip-role.js";
import { openConfirmDialog } from "./ui-confirm.js";
import { resolveThumbUrlMap } from "./ui-place-list.js";
import { escapeHtml, formatDateRangeCard, parseIsoDate, todayIso } from "./utils.js";

const WEEKDAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const WEEKDAYS_SHORT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const PLACEHOLDER = "Montag\nFrüh los, am Nachmittag am See ...\n\nDienstag\nMit dem Rad nach Malcesine ...\n\nMittwoch\n...\n\nSonntag\n...";
const NO_WEEKDAYS = "Keine Wochentage gefunden. Schreib jeden Tag in eine eigene Zeile.";
const UNAVAILABLE = "Reisetagebuch ist noch nicht verfügbar.";
const DIARY_SAVE_MS = 800;
const DIARY_LOCAL_PREFIX = "vr-diary-source:";

function readDiaryLocal(tripId) {
  try {
    const raw = localStorage.getItem(DIARY_LOCAL_PREFIX + tripId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.text !== "string") return null;
    return { text: parsed.text, pending: Boolean(parsed.pending) };
  } catch {
    return null;
  }
}

function writeDiaryLocal(tripId, text, pending) {
  const key = DIARY_LOCAL_PREFIX + tripId;
  try {
    if (!pending && !String(text || "").trim()) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify({ text: text || "", pending: Boolean(pending) }));
  } catch {
    /* Speicher voll: der Text bleibt im Feld. */
  }
}

function seededDiaryText(tripId, serverText) {
  const local = readDiaryLocal(tripId);
  const server = serverText || "";
  if (local?.pending) return local.text || "";
  if (server) return server;
  return local?.text || "";
}

const ICON_PEN = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;

function dayStamp(iso) {
  if (!iso) return "";
  const date = parseIsoDate(iso);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${WEEKDAYS_SHORT[date.getDay()]} ${day}.${month}.`;
}

function cardTitle(iso) {
  const date = parseIsoDate(iso);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${WEEKDAYS[date.getDay()]}, ${day}.${month}.`;
}

function satz(n) {
  return n === 1 ? "1 Satz" : `${n} Sätze`;
}

function formatChars(n) {
  return `${new Intl.NumberFormat("de-DE").format(n)} Zeichen`;
}

function pickStatus(rows, status) {
  return (
    rows
      .filter((row) => row.status === status && !row.deletedAt)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null
  );
}

function headingForLine(model, line) {
  for (const day of model.days || []) {
    const part = (day.parts || []).find((item) => item.line === line);
    if (part?.heading) return part.heading;
  }
  const loose = (model.loose || []).find((item) => item.line === line);
  if (loose?.heading) return loose.heading;
  return matchHeading(line || "")?.label || "";
}

function hintCopy(hint, model) {
  const name = headingForLine(model, hint.line) || "Wochentag";
  if (hint.type === "weekday-repeats") {
    const n = hint.occurrences || 2;
    return `${name} kommt ${n}× vor, zugeordnet zu ${dayStamp(hint.date)}`;
  }
  if (hint.type === "appended-to-earlier") return `${name} angehängt an ${dayStamp(hint.date)}`;
  if (hint.type === "weekday-date-mismatch") return `Wochentag passt nicht zum Datum, zugeordnet zu ${dayStamp(hint.date)}`;
  if (hint.type === "weekday-not-in-trip") return `${name} nicht zugeordnet`;
  if (hint.type === "empty-day-text") return `${name} ohne Text`;
  if (hint.type === "day-without-text") return `${dayStamp(hint.date)} ohne Text`;
  return "";
}

function hintActions(hint) {
  const line = escapeHtml(hint.line || "");
  if (hint.type === "weekday-repeats" || hint.type === "appended-to-earlier" || hint.type === "weekday-date-mismatch") {
    return `<button type="button" data-testid="diary-change" data-line="${line}">ändern</button>`;
  }
  if (hint.type === "weekday-not-in-trip") {
    return `<button type="button" data-testid="diary-pick" data-line="${line}">Tag wählen</button><button type="button" data-testid="diary-omit" data-line="${line}">weglassen</button>`;
  }
  return "";
}

function hintHtml(hint, model) {
  const text = hintCopy(hint, model);
  if (!text) return "";
  const actions = hintActions(hint);
  return `<p class="diary-hint" data-testid="diary-hint" data-hint="${escapeHtml(hint.type)}">${escapeHtml(text)}${actions ? ` ${actions}` : ""}</p>`;
}

function firstHeading(model) {
  for (const day of model.days || []) {
    const part = (day.parts || []).find((item) => item.heading);
    if (part) return part.heading;
  }
  return model.loose?.find((item) => item.heading)?.heading || "";
}

function previewTitle(model) {
  const n = model.days.filter((day) => dayBody(day).trim()).length;
  const days = n === 1 ? "1 Tag erkannt" : `${n} Tage erkannt`;
  return String(model.intro || "").trim() ? `${days} + Einleitung` : days;
}

function problemOnDay(model, date) {
  return (model.hints || []).some(
    (hint) =>
      hint.date === date &&
      ["weekday-repeats", "appended-to-earlier", "weekday-date-mismatch", "empty-day-text", "day-without-text"].includes(
        hint.type
      )
  );
}

function previewMarkup(model, vacation) {
  const introName = firstHeading(model);
  const introCount = countSentences(model.intro);
  const introSub = introName ? `Text vor «${introName}» · ${satz(introCount)}` : satz(introCount);
  const intro = String(model.intro || "").trim()
    ? `<div class="diary-prev" data-testid="diary-preview-intro">
        <span class="diary-prev__bar" style="background:#163a78"></span>
        <span class="diary-prev__main">
          <strong>Einleitung</strong>
          <span>${escapeHtml(introSub)}</span>
        </span>
      </div>`
    : "";
  const notice = model.noHeadings
    ? `<p class="diary-hint" data-testid="diary-no-weekdays">${escapeHtml(NO_WEEKDAYS)}</p>`
    : "";
  const total = vacationDays(vacation).length || model.days.length;
  const rows = model.days
    .map((day) => {
      const body = dayBody(day);
      const names = [...new Set((day.parts || []).map((part) => part.heading).filter(Boolean))];
      const heading = names.join(", ");
      const count = countSentences(body);
      const sub = heading ? `«${heading}» · ${satz(count)}` : count ? satz(count) : "";
      const role = dayRoleLabel(dayIndexInTrip(vacation, day.date), total);
      const hints = (model.hints || []).filter((hint) => hint.date === day.date).map((hint) => hintHtml(hint, model)).join("");
      const ok = Boolean(body.trim()) && !problemOnDay(model, day.date);
      return `<div class="diary-prev" data-testid="diary-preview-day" data-date="${escapeHtml(day.date)}">
        <span class="diary-prev__bar" style="background:${dayColorFor(vacation, day.date)}"></span>
        <span class="diary-prev__main">
          <strong>${escapeHtml(`${dayStamp(day.date)} · ${role}`)}</strong>
          ${sub ? `<span data-testid="diary-preview-sub">${escapeHtml(sub)}</span>` : ""}
          ${hints}
        </span>
        ${ok ? `<span class="recap-ok" data-testid="diary-ok" aria-label="erkannt">✓</span>` : `<span></span>`}
      </div>`;
    })
    .join("");
  const loose = (model.loose || [])
    .map((item) => {
      const hint = (model.hints || []).find((entry) => entry.type === "weekday-not-in-trip" && entry.line === item.line);
      const copy = hint ? hintCopy(hint, model) : `${item.heading || "Tag"} nicht zugeordnet`;
      return `<div class="diary-prev" data-testid="diary-unassigned" data-line="${escapeHtml(item.line || "")}">
        <span class="diary-prev__bar" style="background:#e3b07c"></span>
        <span class="diary-prev__main">
          <strong>${escapeHtml(copy)}</strong>
          ${item.text ? `<span>${escapeHtml(item.text)}</span>` : ""}
          <p class="diary-hint" data-testid="diary-hint" data-hint="weekday-not-in-trip">${hintActions({ type: "weekday-not-in-trip", line: item.line })}</p>
        </span>
      </div>`;
    })
    .join("");
  return `<section class="settings-card diary-preview" data-testid="diary-preview">
    <div class="settings-item settings-item--stack">
      <strong class="diary-preview__title" data-testid="diary-preview-title">${escapeHtml(previewTitle(model))}</strong>
      ${notice}
      ${intro}
      ${rows}
      ${loose}
    </div>
  </section>`;
}

function canEditDiary(tripId) {
  return resolveTripEditing(tripId);
}

function unavailableCopy(tripId, emptyCopy) {
  return tripRoleLoadFailed(tripId) ? ROLE_UNKNOWN_MESSAGE : emptyCopy;
}

function diaryFailure(err, fallback) {
  if (err instanceof RecapUnavailableError) return UNAVAILABLE;
  return err?.message || fallback;
}

export async function renderDiary(appEl, tripId, { recapId = "" } = {}) {
  const mountGen = appEl?.dataset?.appRenderGen ?? "";
  const token = `${mountGen}:${Date.now()}:${Math.random()}`;
  appEl.dataset.diaryToken = token;
  if (typeof appEl._screenCleanup === "function") {
    appEl._screenCleanup();
    delete appEl._screenCleanup;
  }
  let closeSheet = null;
  const alive = () => appEl.dataset.diaryToken === token && appEl.dataset.appRenderGen === mountGen;
  appEl._screenCleanup = () => {
    if (closeSheet) {
      const fn = closeSheet;
      closeSheet = null;
      fn();
    }
  };

  const vacation = await getVacation(tripId);
  if (!alive()) return;
  if (!vacation) {
    navigate({ name: "urlaube" });
    return;
  }

  const canEdit = await canEditDiary(tripId);
  paintShell(vacation);
  if (!alive()) return;

  let rows = [];
  try {
    rows = await listDiaryRecaps(tripId);
  } catch (err) {
    if (!alive()) return;
    const message = diaryFailure(err, "Das Reisetagebuch konnte nicht geladen werden.");
    showWarnToast(message);
    paintUnavailable(message);
    return;
  }
  if (!alive()) return;
  rows = rows.filter((row) => row && !row.deletedAt);
  if (!canEdit) rows = rows.filter((row) => row.status === "final");

  const draft = canEdit ? pickStatus(rows, "draft") : null;
  const finalRow = pickStatus(rows, "final");
  const notes = canEdit ? pickStatus(rows, "notes") : null;
  let material = { places: [], photos: [] };
  try {
    material = await loadRecapMaterial(tripId);
  } catch {
    material = { places: [], photos: [] };
  }
  if (!alive()) return;

  const focusFinal = recapId === "final";
  const focused = !focusFinal && recapId ? rows.find((row) => row.id === recapId) || null : null;

  if (!canEdit) {
    if (!finalRow) {
      paintUnavailable(unavailableCopy(tripId, "Noch kein Reisetagebuch."));
      return;
    }
    await paintDraft(finalRow, { readonly: true, offerNew: false });
    return;
  }
  if (focusFinal || focused?.status === "final") {
    const row = focusFinal ? finalRow : focused;
    if (row) {
      await paintDraft(row, { readonly: true, offerNew: true });
      return;
    }
    paintUnavailable("Noch kein Reisetagebuch.");
    return;
  }
  if (focused?.status === "draft") {
    await paintDraft(focused, { readonly: false });
    return;
  }
  if (recapId) {
    if (finalRow) {
      await paintDraft(finalRow, { readonly: true, offerNew: true });
      return;
    }
    paintUnavailable("Dieser Entwurf ist nicht mehr da.");
    return;
  }
  if (draft) {
    await paintDraft(draft, { readonly: false });
    return;
  }
  if (finalRow) {
    await paintDraft(finalRow, { readonly: true, offerNew: true });
    return;
  }
  paintCompose(notes?.sourceText || "");

  function paintShell(current) {
    appEl.className = "screen screen--settings";
    appEl.dataset.testid = "diary-screen";
    appEl.dataset.vacationId = current.id;
    appEl.innerHTML = `
      <header class="trip-header">
        <button type="button" class="link-btn link-btn--back" data-action="back">${ICON_BACK_CHEVRON}<span>Reise</span></button>
        <h1 class="trip-header__title">Reisetagebuch</h1>
        <span class="map-header__spacer" aria-hidden="true"></span>
      </header>
      <main class="settings-main" data-testid="diary-main"></main>`;
    appEl.querySelector('[data-action="back"]')?.addEventListener("click", () => {
      navigate({ name: "urlaub-detail", id: tripId });
    });
  }

  function paintUnavailable(message) {
    const main = appEl.querySelector('[data-testid="diary-main"]');
    if (!main) return;
    main.innerHTML = `
      <div class="trip-empty" data-testid="diary-unavailable">
        <p class="trip-empty__title">${escapeHtml(message)}</p>
      </div>`;
  }

  function paintCompose(initial) {
    let model = null;
    const main = appEl.querySelector('[data-testid="diary-main"]');
    if (!main) return;
    const range = vacation.startDate ? formatDateRangeCard(vacation.startDate, diaryEndDate(vacation.startDate, vacation.endDate, material.places, material.photos, todayIso())) : "";
    main.innerHTML = `
      <div data-testid="diary-compose">
        <h2 class="recap-trip-title">${escapeHtml(vacation.title)}</h2>
        <p class="recap-kicker" data-testid="diary-range">${escapeHtml(range)}</p>
        <p class="diary-steps" data-testid="diary-steps"><span class="diary-steps__on">1 Bericht einfügen</span><span aria-hidden="true"> — </span><span>2 Entwurf ansehen</span></p>
        <p class="diary-help" data-testid="diary-help">Schreib jeden Wochentag in eine eigene Zeile, darunter den Text. So erkennt die App, was zu welchem Tag gehört.</p>
        <textarea class="diary-source" data-testid="diary-source" maxlength="${DIARY_TEXT_MAX}" placeholder="${escapeHtml(PLACEHOLDER)}"></textarea>
        <p class="diary-save-hint" data-testid="diary-save-hint" hidden>Auf diesem Gerät gemerkt.</p>
        <div class="diary-tools">
          <button type="button" class="btn btn-emaille btn-emaille--ghost diary-chip" data-testid="diary-paste">Einfügen</button>
          <button type="button" class="btn btn-emaille btn-emaille--ghost diary-chip" data-testid="diary-clear" hidden>Leeren</button>
          <span class="diary-count" data-testid="diary-count">0 Zeichen</span>
        </div>
        <div data-testid="diary-preview-slot"></div>
        <button type="button" class="btn btn-emaille btn-emaille--block diary-action" data-testid="diary-action" data-mode="recognize" disabled>Tage erkennen</button>
      </div>`;
    const textarea = main.querySelector('[data-testid="diary-source"]');
    const action = main.querySelector('[data-testid="diary-action"]');
    textarea.value = clampDiaryText(seededDiaryText(tripId, initial || ""));
    let lastSaved = textarea.value;
    let saveTimer = 0;

    const hintEl = main.querySelector('[data-testid="diary-save-hint"]');
    const showSavedLocally = (on) => {
      if (hintEl) hintEl.hidden = !on;
    };

    const flushDiary = () => {
      if (!textarea.isConnected) return Promise.resolve();
      const text = clampDiaryText(textarea.value);
      if (text === lastSaved) return Promise.resolve();
      const pendingBefore = text;
      writeDiaryLocal(tripId, text, true);
      return saveDiaryNotes(tripId, text)
        .then(() => {
          if (textarea.value !== pendingBefore && clampDiaryText(textarea.value) !== text) return;
          lastSaved = text;
          writeDiaryLocal(tripId, text, false);
          showSavedLocally(false);
        })
        .catch(() => {
          showSavedLocally(true);
        });
    };

    const scheduleDiarySave = () => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        void flushDiary();
      }, DIARY_SAVE_MS);
    };
    if (readDiaryLocal(tripId)?.pending) {
      showSavedLocally(true);
      lastSaved = `\0${textarea.value}`;
      scheduleDiarySave();
    }

    const onDiaryHide = () => {
      if (document.visibilityState === "hidden") void flushDiary();
    };
    const onDiaryPageHide = () => {
      void flushDiary();
    };
    document.addEventListener("visibilitychange", onDiaryHide);
    window.addEventListener("pagehide", onDiaryPageHide);
    const prevCleanup = appEl._screenCleanup;
    appEl._screenCleanup = () => {
      window.clearTimeout(saveTimer);
      document.removeEventListener("visibilitychange", onDiaryHide);
      window.removeEventListener("pagehide", onDiaryPageHide);
      void flushDiary();
      prevCleanup?.();
    };

    const syncChrome = () => {
      const count = main.querySelector('[data-testid="diary-count"]');
      const clear = main.querySelector('[data-testid="diary-clear"]');
      if (count) count.textContent = formatChars(Array.from(textarea.value).length);
      if (clear) clear.hidden = textarea.value.length === 0;
      const steps = main.querySelector('[data-testid="diary-steps"]');
      const help = main.querySelector('[data-testid="diary-help"]');
      if (steps) steps.hidden = Boolean(model);
      if (help) help.hidden = Boolean(model);
      if (!action) return;
      if (model) {
        action.disabled = false;
        action.dataset.mode = "create";
        action.textContent = model.noHeadings ? "Trotzdem übernehmen" : "Entwurf erstellen";
      } else {
        action.dataset.mode = "recognize";
        action.textContent = "Tage erkennen";
        action.disabled = !textarea.value.trim();
      }
    };

    const renderPreview = () => {
      const slot = main.querySelector('[data-testid="diary-preview-slot"]');
      if (slot) slot.innerHTML = model ? previewMarkup(model, vacation) : "";
      syncChrome();
    };

    textarea.addEventListener("input", () => {
      textarea.value = clampDiaryText(textarea.value);
      if (model) model = null;
      renderPreview();
      scheduleDiarySave();
    });

    main.querySelector('[data-testid="diary-paste"]')?.addEventListener("click", async () => {
      try {
        if (!navigator.clipboard?.readText) return;
        const text = await navigator.clipboard.readText();
        if (!text) return;
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? textarea.value.length;
        const next = clampDiaryText(textarea.value.slice(0, start) + text + textarea.value.slice(end));
        textarea.value = next;
        const cursor = Math.min(start + text.length, next.length);
        textarea.setSelectionRange?.(cursor, cursor);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      } catch {
        /* Zwischenablage nicht erlaubt: das Feld nimmt normales Einfügen an, ohne Fehlermeldung. */
      }
    });

    main.querySelector('[data-testid="diary-clear"]')?.addEventListener("click", () => {
      textarea.value = "";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.focus();
    });

    main.querySelector('[data-testid="diary-preview-slot"]')?.addEventListener("click", async (event) => {
      const omit = event.target.closest("[data-testid='diary-omit']");
      if (omit && model) {
        omitLine(model, omit.dataset.line || "");
        renderPreview();
        return;
      }
      const change = event.target.closest("[data-testid='diary-change'], [data-testid='diary-pick']");
      if (!change || !model) return;
      const date = await pickDay(model);
      if (!date || !alive() || !model) return;
      reassignLine(model, change.dataset.line || "", date);
      renderPreview();
    });

    action?.addEventListener("click", async () => {
      if (action.dataset.mode !== "create") {
        const endDate = diaryEndDate(vacation.startDate, vacation.endDate, material.places, material.photos, todayIso());
        model = createDiaryModel(parseDiary(textarea.value, { startDate: vacation.startDate, endDate }));
        renderPreview();
        return;
      }
      if (!model) return;
      if (model.loose.length) {
        const name = model.loose[0].heading || "Ein Tag";
        showWarnToast(`«${name}» ist nicht zugeordnet. Tag wählen oder weglassen.`);
        return;
      }
      action.disabled = true;
      try {
        const content = buildDiaryContent(model, material);
        const row = await createDiaryDraft(tripId, {
          version: (Number(finalRow?.version) || 0) + 1,
          basedOn: finalRow?.id || null,
          content,
          sourceText: textarea.value,
        });
        if (!alive()) return;
        await paintDraft(row, { readonly: false });
      } catch (err) {
        if (!alive()) return;
        action.disabled = false;
        showWarnToast(diaryFailure(err, "Der Entwurf konnte nicht gespeichert werden."));
      }
    });

    syncChrome();
  }

  async function paintDraft(row, { readonly, offerNew = false }) {
    const content = row?.content || {};
    const days = Array.isArray(content.days) ? content.days : [];
    const ids = new Set();
    for (const day of days) {
      for (const id of day.media_ids || []) ids.add(id);
    }
    let thumbs = {};
    try {
      thumbs = await resolveThumbUrlMap(material.photos || [], ids);
    } catch {
      thumbs = {};
    }
    if (!alive()) return;
    paintShell(vacation);
    const main = appEl.querySelector('[data-testid="diary-main"]');
    if (!main) return;
    const total = days.length;
    const kicker = readonly ? "Final" : `Entwurf ${row.version || 1} · ${total} ${total === 1 ? "Tag" : "Tage"}`;
    const range = vacation.startDate
      ? formatDateRangeCard(
          vacation.startDate,
          diaryEndDate(vacation.startDate, vacation.endDate, material.places, material.photos, todayIso())
        )
      : "";
    const intro = String(content.intro || "").trim()
      ? `<p class="diary-intro" data-testid="diary-intro">${escapeHtml(content.intro)}</p>`
      : "";
    const cards = days
      .map((day) => {
        const names = (day.waypoint_ids || [])
          .map((id) => material.places.find((place) => place.id === id))
          .filter(Boolean)
          .map((place) => place.name || place.title)
          .filter(Boolean);
        const role = dayRoleLabel(dayIndexInTrip(vacation, day.date), vacationDays(vacation).length || total || 1);
        const meta = names.length ? `${role} · ${names.join(" · ")}` : role;
        const photos = (day.media_ids || [])
          .slice(0, 3)
          .map((id) => {
            const src = thumbs[id];
            return src
              ? `<img class="diary-photo" data-testid="diary-photo" data-media-id="${escapeHtml(id)}" src="${escapeHtml(src)}" alt="" />`
              : `<span class="diary-photo diary-photo--empty" data-testid="diary-photo" data-media-id="${escapeHtml(id)}"></span>`;
          })
          .join("");
        const text = String(day.text || "");
        const pen = readonly
          ? ""
          : `<button type="button" class="diary-pen" data-testid="diary-edit" data-date="${escapeHtml(day.date)}" aria-label="Bearbeiten">${ICON_PEN}</button>`;
        const empty = text.trim()
          ? ""
          : `<p class="diary-hint" data-testid="diary-day-empty">${escapeHtml(`${dayStamp(day.date)} ohne Text`)}</p>`;
        return `<article class="settings-card diary-day" data-testid="diary-day" data-date="${escapeHtml(day.date)}" style="border-left-color:${dayColorFor(vacation, day.date)}">
          <div class="settings-item settings-item--stack">
            <div class="diary-day__head">
              <div>
                <h3 class="diary-day__title">${escapeHtml(cardTitle(day.date))}</h3>
                <p class="diary-day__meta" data-testid="diary-places">${escapeHtml(meta)}</p>
              </div>
              ${pen}
            </div>
            ${photos ? `<div class="diary-photos">${photos}</div>` : ""}
            ${text.trim() ? `<p class="diary-day__text" data-testid="diary-day-text">${escapeHtml(text)}</p>` : ""}
            ${empty}
          </div>
        </article>`;
      })
      .join("");
    const actions = readonly
      ? offerNew
        ? `<button type="button" class="btn btn-emaille btn-emaille--block" data-testid="diary-new-draft">Neuer Entwurf</button>`
        : ""
      : `<form class="recap-feedback" data-testid="diary-feedback-form">
          <label class="field">
            <input type="text" data-testid="diary-feedback-input" maxlength="2000" placeholder="Änderung wünschen, z. B. «kürzer»" />
          </label>
          <button type="submit" class="btn btn-emaille" data-testid="diary-feedback-send">Senden</button>
        </form>
        <div class="recap-actions">
          <button type="button" class="btn btn-emaille btn-emaille--ghost" data-testid="diary-discard">Verwerfen</button>
          <button type="button" class="btn btn-emaille" data-testid="diary-adopt">Übernehmen</button>
        </div>`;
    main.innerHTML = `
      <div data-testid="diary-draft">
        <h2 class="recap-trip-title">${escapeHtml(vacation.title)}</h2>
        <p class="recap-kicker" data-testid="diary-range">${escapeHtml(range)}</p>
        <p class="recap-kicker" data-testid="diary-kicker">${escapeHtml(kicker)}</p>
        ${intro}
        <div data-testid="diary-days">${cards}</div>
        ${actions}
      </div>`;
    if (readonly) {
      main.querySelector('[data-testid="diary-new-draft"]')?.addEventListener("click", () => {
        void startNewDraft(row);
      });
      return;
    }
    main.querySelectorAll('[data-testid="diary-edit"]').forEach((button) => {
      button.addEventListener("click", () => {
        const date = button.dataset.date;
        const current = (row.content?.days || []).find((day) => day.date === date);
        openEditor(row, date, current?.text || "");
      });
    });
    const form = main.querySelector('[data-testid="diary-feedback-form"]');
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = form.querySelector('[data-testid="diary-feedback-input"]');
      const text = input?.value || "";
      if (!text.trim()) return;
      const send = form.querySelector('[data-testid="diary-feedback-send"]');
      if (send) send.disabled = true;
      try {
        const updated = await appendRecapFeedback(row, text);
        if (updated) Object.assign(row, updated);
        if (input) input.value = "";
        showToast("Wunsch gespeichert");
      } catch (err) {
        showWarnToast(diaryFailure(err, "Der Wunsch konnte nicht gespeichert werden."));
      } finally {
        if (send) send.disabled = false;
      }
    });
    main.querySelector('[data-testid="diary-discard"]')?.addEventListener("click", async () => {
      const ok = await openConfirmDialog({
        title: "Entwurf verwerfen?",
        message: "Nur dieser Entwurf wird gelöscht. Eine freigegebene Fassung bleibt.",
        confirmLabel: "Verwerfen",
        cancelLabel: "Abbrechen",
        danger: true,
        testId: "diary-discard-confirm",
      });
      if (!ok || !alive()) return;
      try {
        await discardRecapDraft(row.id);
        showToast("Entwurf verworfen");
        navigate({ name: "urlaub-detail", id: tripId });
      } catch (err) {
        showWarnToast(diaryFailure(err, "Der Entwurf konnte nicht verworfen werden."));
      }
    });
    main.querySelector('[data-testid="diary-adopt"]')?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await adoptRecapDraft(row);
        showToast("Tagebuch übernommen");
        if (!alive()) return;
        await renderDiary(appEl, tripId);
      } catch (err) {
        button.disabled = false;
        showWarnToast(diaryFailure(err, "Das Tagebuch konnte nicht übernommen werden."));
      }
    });
  }

  async function startNewDraft(sourceRow) {
    paintShell(vacation);
    const main = appEl.querySelector('[data-testid="diary-main"]');
    if (main) {
      main.innerHTML = `<div class="trip-empty" aria-busy="true"><p class="trip-empty__title" data-testid="diary-working">in Bearbeitung</p></div>`;
    }
    try {
      const dates = vacationDays(vacation);
      const content = refreshDiaryContent(sourceRow?.content, material, dates.length ? dates : (sourceRow?.content?.days || []).map((day) => day.date));
      const created = await createDiaryDraft(tripId, {
        version: (Number(sourceRow?.version) || 1) + 1,
        basedOn: sourceRow?.id || null,
        content,
      });
      if (!alive()) return;
      await paintDraft(created, { readonly: false });
    } catch (err) {
      if (!alive()) return;
      const message = diaryFailure(err, "Der Entwurf konnte nicht gespeichert werden.");
      showWarnToast(message);
      paintUnavailable(message);
    }
  }

  function openEditor(row, date, text) {
    const overlay = document.getElementById("overlay-root");
    if (!overlay || !date) return;
    overlay.hidden = false;
    overlay.innerHTML = `
      <div class="sheet" data-testid="diary-edit-sheet" role="dialog" aria-modal="true" aria-label="Tag bearbeiten">
        <header class="sheet__header"><h2 class="sheet__title">${escapeHtml(cardTitle(date))}</h2></header>
        <textarea class="diary-source" data-testid="diary-edit-text" maxlength="${DIARY_TEXT_MAX}"></textarea>
        <button type="button" class="btn btn-emaille btn-emaille--block" data-testid="diary-edit-save">Speichern</button>
        <button type="button" class="btn btn-emaille btn-emaille--ghost btn-emaille--block" data-testid="diary-edit-cancel">Abbrechen</button>
      </div>`;
    const field = overlay.querySelector('[data-testid="diary-edit-text"]');
    if (field) field.value = text || "";
    const domClose = () => {
      closeSheet = null;
      overlay.hidden = true;
      overlay.innerHTML = "";
    };
    const active = bindOverlay(overlay, domClose);
    closeSheet = () => closeOverlayHistory(active);
    overlay.querySelector('[data-testid="diary-edit-cancel"]')?.addEventListener("click", () => closeSheet?.());
    overlay.querySelector('[data-testid="diary-edit-save"]')?.addEventListener("click", async () => {
      const nextText = field?.value ?? "";
      const days = (row.content?.days || []).map((day) => (day.date === date ? { ...day, text: nextText } : day));
      const content = { ...row.content, days };
      const save = overlay.querySelector('[data-testid="diary-edit-save"]');
      if (save) save.disabled = true;
      try {
        const updated = await updateRecapContent(row, content);
        if (updated) Object.assign(row, updated);
        else row.content = content;
        closeSheet?.();
        if (!alive()) return;
        showToast("Tag gespeichert");
        await paintDraft(row, { readonly: false });
      } catch (err) {
        if (save) save.disabled = false;
        showWarnToast(diaryFailure(err, "Der Tag konnte nicht gespeichert werden."));
      }
    });
  }

  function pickDay(model) {
    return new Promise((resolve) => {
      const overlay = document.getElementById("overlay-root");
      if (!overlay) {
        resolve("");
        return;
      }
      const options = (model.days || [])
        .map((day) => {
          const role = dayRoleLabel(dayIndexInTrip(vacation, day.date), vacationDays(vacation).length || model.days.length);
          return `<button type="button" class="settings-link-row" data-testid="diary-day-option" data-date="${escapeHtml(day.date)}">${escapeHtml(`${dayStamp(day.date)} · ${role}`)}</button>`;
        })
        .join("");
      overlay.hidden = false;
      overlay.innerHTML = `
        <div class="sheet diary-picker" data-testid="diary-day-picker" role="dialog" aria-modal="true" aria-label="Tag wählen">
          <header class="sheet__header"><h2 class="sheet__title">Tag wählen</h2></header>
          <div class="settings-card settings-card--links">${options}</div>
          <button type="button" class="btn btn-emaille btn-emaille--ghost btn-emaille--block" data-testid="diary-day-picker-cancel">Abbrechen</button>
        </div>`;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value || "");
      };
      const domClose = () => {
        closeSheet = null;
        overlay.hidden = true;
        overlay.innerHTML = "";
        finish("");
      };
      const active = bindOverlay(overlay, domClose);
      closeSheet = () => closeOverlayHistory(active);
      overlay.querySelector('[data-testid="diary-day-picker-cancel"]')?.addEventListener("click", () => closeSheet?.());
      overlay.querySelectorAll('[data-testid="diary-day-option"]').forEach((button) => {
        button.addEventListener("click", () => {
          const date = button.dataset.date || "";
          finish(date);
          closeSheet?.();
        });
      });
    });
  }
}
