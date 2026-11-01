import {
  addPlaceErrorMessage,
  commitBackfilledPlace,
  groupAssignableContent,
  isOhneOrtPlace,
  loadAssignableContent,
  noteOwnedBy,
} from "./add-place-service.js";
import { DAY_PARTS, timestampForDayTime } from "./day-parts.js";
import { dayChipDateLine, dayRoleLabel, vacationDays } from "./days.js";
import { fallbackPlaceName, reverseGeocodeDetails } from "./geo.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import { bindSheetPull } from "./sheet-pull.js";
import { mediaOwnedBy } from "./photo-move.js";
import { showWarnToast } from "./toast.js";
import { resolveThumbUrlMap } from "./ui-place-list.js";
import { escapeHtml } from "./utils.js";

const NOTE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;

function dayLabel(vacation, day) {
  const days = vacationDays(vacation);
  const index = days.indexOf(day);
  const date = dayChipDateLine(day);
  if (index < 0) return date;
  return `${date} · ${dayRoleLabel(index + 1, days.length)}`;
}

function placeDay(place) {
  return place?.day || place?.dayDate || "";
}

function selectionLabel(photoCount, noteCount) {
  if (!photoCount && !noteCount) return "Nichts ausgewählt";
  const bits = [];
  if (photoCount) bits.push(`${photoCount} Foto${photoCount === 1 ? "" : "s"}`);
  if (noteCount) bits.push(`${noteCount} Notiz${noteCount === 1 ? "" : "en"}`);
  return `${bits.join(", ")} ausgewählt`;
}

/**
 * Sheet «Neuer Ort» und danach die Auswahl der Fotos und Notizen.
 * Löst mit { status: "cancel" } oder dem Speichergebnis.
 */
export function openAddPlaceFlow({ vacation, vacationId, day, lat, lng, userId }) {
  const overlay = document.getElementById("overlay-root");
  if (!overlay) return Promise.resolve({ status: "cancel" });

  return new Promise((resolve) => {
    let settled = false;
    let savedResult = null;
    let activeClose = null;
    const geocodeAbort = new AbortController();
    let nameValue = "";
    let nameDirty = false;
    let timeValue = "";
    let partId = "";
    let geocodeStatus = "loading";
    let suggestion = "";
    let bundle = null;
    let groups = [];
    let selectedPhotos = new Set();
    let selectedNotes = new Set();
    let selectionReady = false;
    let moreOpen = false;
    let saving = false;
    let step = 1;
    let contentLoadFailed = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      geocodeAbort.abort();
      resolve(value);
    };

    const domClose = () => {
      overlay.classList.remove("overlay-root--bleed");
      overlay.hidden = true;
      overlay.innerHTML = "";
      finish(savedResult || { status: "cancel" });
    };

    overlay.hidden = false;
    overlay.classList.add("overlay-root--bleed");
    overlay.innerHTML = `<div class="sheet sheet--add-place" role="dialog" aria-modal="true"></div>`;
    const sheet = overlay.querySelector(".sheet");

    function paint(html, testId, label) {
      sheet.dataset.testid = testId;
      sheet.setAttribute("aria-labelledby", `${testId}-title`);
      sheet.innerHTML = html;
      const title = sheet.querySelector(".sheet__title");
      if (title) title.id = `${testId}-title`;
      if (label) sheet.setAttribute("aria-label", label);
    }

    function closeFlow() {
      if (activeClose) closeOverlayHistory(activeClose);
      else domClose();
    }

    function syncTimeHint() {
      const hint = sheet.querySelector('[data-testid="add-place-time-hint"]');
      const next = sheet.querySelector('[data-testid="add-place-next"]');
      const only = sheet.querySelector('[data-testid="add-place-only"]');
      const ready = timestampForDayTime(day, timeValue) != null;
      if (hint) {
        hint.textContent = ready
          ? "Der Ort wird nach dieser Uhrzeit im Tag einsortiert."
          : "Tageszeit tippen oder genaue Uhrzeit wählen.";
      }
      if (next) next.disabled = !ready;
      if (only) only.disabled = !ready;
    }

    function applyNameDom() {
      const input = sheet.querySelector('[data-testid="add-place-name"]');
      const suggestionEl = sheet.querySelector('[data-testid="add-place-suggestion"]');
      if (!input) return;
      if (document.activeElement !== input) input.value = nameValue;
      input.placeholder = geocodeStatus === "loading" && !nameValue ? "Adresse wird gesucht…" : "Name des Ortes";
      input.dataset.geocode = geocodeStatus;
      const text = suggestion && suggestion !== nameValue.trim() ? `Vorschlag aus der Adresse: ${suggestion}` : "";
      if (suggestionEl) {
        suggestionEl.hidden = !text;
        suggestionEl.textContent = text;
      }
    }

    function paintStep1() {
      step = 1;
      paint(
        `
        <div class="sheet-handle" data-role="pick-handle" aria-hidden="true"></div>
        <h2 class="sheet__title">Neuer Ort</h2>
        <p class="add-place-day" data-testid="add-place-day">${escapeHtml(dayLabel(vacation, day))}</p>
        <label class="field">
          <span class="field__label">Name</span>
          <input type="text" maxlength="200" data-testid="add-place-name" value="${escapeHtml(nameValue)}" />
        </label>
        <p class="add-place-suggestion" data-testid="add-place-suggestion" hidden></p>
        <div class="field">
          <label class="field__label" for="add-place-time">Uhrzeit</label>
          <div class="add-place-time-row">
            <input id="add-place-time" type="time" step="60" data-testid="add-place-time" value="${escapeHtml(timeValue)}" />
            <p class="add-place-time-hint" data-testid="add-place-time-hint"></p>
          </div>
        </div>
        <div class="chip-row" data-testid="add-place-parts">
          ${DAY_PARTS.map(
            (part) =>
              `<button type="button" class="chip" data-part="${part.id}" data-testid="add-place-part" aria-pressed="${partId === part.id ? "true" : "false"}">${escapeHtml(part.label)}</button>`
          ).join("")}
        </div>
        <div class="sheet-actions">
          <button type="button" class="btn btn-emaille btn-emaille--block" data-testid="add-place-next" disabled>Weiter: Fotos hinzufügen</button>
          <button type="button" class="btn btn-emaille btn-emaille--ghost btn-emaille--block" data-testid="add-place-only" disabled>Nur Ort speichern</button>
          <button type="button" class="link-btn" data-testid="add-place-cancel">Abbrechen</button>
        </div>`,
        "add-place-sheet"
      );
      applyNameDom();
      syncTimeHint();
      const nameInput = sheet.querySelector('[data-testid="add-place-name"]');
      nameInput?.addEventListener("input", () => {
        nameDirty = true;
        nameValue = nameInput.value;
        applyNameDom();
      });
      const timeInput = sheet.querySelector('[data-testid="add-place-time"]');
      timeInput?.addEventListener("input", () => {
        timeValue = timeInput.value;
        syncTimeHint();
      });
      sheet.querySelectorAll("[data-part]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const part = DAY_PARTS.find((item) => item.id === btn.dataset.part);
          if (!part) return;
          partId = part.id;
          timeValue = part.time;
          if (timeInput) timeInput.value = part.time;
          sheet.querySelectorAll("[data-part]").forEach((other) => {
            other.setAttribute("aria-pressed", other === btn ? "true" : "false");
          });
          syncTimeHint();
        });
      });
      sheet.querySelector('[data-testid="add-place-next"]')?.addEventListener("click", () => {
        void goToPhotos();
      });
      sheet.querySelector('[data-testid="add-place-only"]')?.addEventListener("click", () => {
        void savePlaceOnly();
      });
      sheet.querySelector('[data-testid="add-place-cancel"]')?.addEventListener("click", closeFlow);
    }

    function renderPhoto(photo, url) {
      const own = mediaOwnedBy(photo, userId);
      const on = own && selectedPhotos.has(photo.id);
      return `<button type="button" class="tile${on ? " tile--selected" : ""}${own ? "" : " tile--locked"}" data-testid="add-media-photo" data-media-id="${escapeHtml(photo.id)}" aria-pressed="${on ? "true" : "false"}"${own ? "" : " disabled"}>
        ${url ? `<img class="tile__img" src="${escapeHtml(url)}" alt="" />` : ""}
        <span class="tile__mark" aria-hidden="true"></span>
      </button>`;
    }

    function renderNote(note) {
      const own = noteOwnedBy(note, userId);
      const on = own && selectedNotes.has(note.id);
      return `<button type="button" class="pick-note${on ? " pick-note--on" : ""}" data-testid="add-media-note" data-note-id="${escapeHtml(note.id)}" aria-pressed="${on ? "true" : "false"}"${own ? "" : " disabled"}>
        <span class="pick-note__icon">${NOTE_ICON}</span>
        <span class="pick-note__text">${escapeHtml(note.text || "")}</span>
        <span class="tile__mark" aria-hidden="true"></span>
      </button>`;
    }

    function renderGroup(group, thumbs) {
      const heading = `${group.place.name || "Ort"} · ${dayChipDateLine(placeDay(group.place))}`;
      const sub = isOhneOrtPlace(group.place) ? "ohne Standort, ohne Uhrzeit" : "";
      return `<section class="pick-group" data-testid="add-media-group" data-place-id="${escapeHtml(group.place.id)}">
        <header class="pick-group__head">
          <h3>${escapeHtml(heading)}</h3>
          ${sub ? `<p>${escapeHtml(sub)}</p>` : ""}
        </header>
        ${group.photos.length ? `<div class="tiles">${group.photos.map((photo) => renderPhoto(photo, thumbs[photo.id])).join("")}</div>` : ""}
        ${group.notes.length ? `<div class="pick-notes">${group.notes.map(renderNote).join("")}</div>` : ""}
      </section>`;
    }

    function paintStep2(thumbs) {
      step = 2;
      const ts = timestampForDayTime(day, timeValue);
      const displayName = nameValue.trim() || fallbackPlaceName(ts || Date.now());
      const here = groups.filter((group) => placeDay(group.place) === day);
      const elsewhere = groups.filter((group) => placeDay(group.place) !== day);
      const visible = moreOpen ? [...here, ...elsewhere] : here;
      const photoCount = selectedPhotos.size;
      const noteCount = selectedNotes.size;
      const hasForeign = visible.some(
        (group) =>
          group.photos.some((photo) => !mediaOwnedBy(photo, userId)) ||
          group.notes.some((note) => !noteOwnedBy(note, userId))
      );
      const saveLabel = photoCount || noteCount ? "Speichern" : "Ort ohne Fotos speichern";
      paint(
        `
        <div class="sheet-handle" data-role="pick-handle" aria-hidden="true"></div>
        <h2 class="sheet__title">Fotos und Notizen hinzufügen</h2>
        <p class="add-place-lead" data-testid="add-media-lead">${escapeHtml(`${displayName} · ${dayChipDateLine(day)} · ${timeValue}`)}</p>
        ${
          contentLoadFailed
            ? `<p class="add-place-load-hint" data-testid="add-place-load-hint">Fotos und Notizen konnten nicht geladen werden.</p>
        <button type="button" class="link-btn" data-testid="add-place-reload">Erneut laden</button>`
            : ""
        }
        <div class="pick-groups">
          ${visible.map((group) => renderGroup(group, thumbs)).join("") || `<p class="pick-empty">An diesem Tag liegt noch nichts ohne Ort.</p>`}
        </div>
        ${hasForeign ? `<p class="photo-select-hint" data-testid="add-media-foreign">Fremde Fotos und Notizen sind nicht wählbar.</p>` : ""}
        ${
          elsewhere.length && !moreOpen
            ? `<button type="button" class="notes-add" data-testid="add-media-more">+ Weitere Fotos aus der Mediathek</button>`
            : ""
        }
        <p class="add-place-count" data-testid="add-media-count">${escapeHtml(selectionLabel(photoCount, noteCount))}</p>
        <div class="sheet-actions">
          <button type="button" class="btn btn-emaille btn-emaille--block" data-testid="add-media-save">${escapeHtml(saveLabel)}</button>
          <button type="button" class="link-btn" data-testid="add-media-back">Zurück</button>
        </div>`,
        "add-media-sheet"
      );
      sheet.querySelector('[data-testid="add-media-more"]')?.addEventListener("click", () => {
        moreOpen = true;
        paintStep2(thumbs);
      });
      sheet.querySelectorAll('[data-testid="add-media-photo"]').forEach((btn) => {
        btn.addEventListener("click", () => {
          if (btn.disabled || saving) return;
          const id = btn.dataset.mediaId;
          if (selectedPhotos.has(id)) selectedPhotos.delete(id);
          else selectedPhotos.add(id);
          paintStep2(thumbs);
        });
      });
      sheet.querySelectorAll('[data-testid="add-media-note"]').forEach((btn) => {
        btn.addEventListener("click", () => {
          if (btn.disabled || saving) return;
          const id = btn.dataset.noteId;
          if (selectedNotes.has(id)) selectedNotes.delete(id);
          else selectedNotes.add(id);
          paintStep2(thumbs);
        });
      });
      sheet.querySelector('[data-testid="add-media-save"]')?.addEventListener("click", () => {
        void onSave();
      });
      sheet.querySelector('[data-testid="add-media-back"]')?.addEventListener("click", () => {
        if (saving) return;
        paintStep1();
      });
      sheet.querySelector('[data-testid="add-place-reload"]')?.addEventListener("click", () => {
        if (saving) return;
        bundle = null;
        contentLoadFailed = false;
        void goToPhotos();
      });
    }

    async function goToPhotos() {
      if (saving) return;
      if (timestampForDayTime(day, timeValue) == null) return;
      nameValue = sheet.querySelector('[data-testid="add-place-name"]')?.value ?? nameValue;
      paint(
        `<div class="sheet-handle" data-role="pick-handle" aria-hidden="true"></div><h2 class="sheet__title">Fotos und Notizen hinzufügen</h2><p class="add-place-lead">Wird geladen…</p>`,
        "add-media-sheet"
      );
      try {
        if (!bundle) bundle = await loadAssignableContent(vacationId);
        contentLoadFailed = Boolean(bundle.loadFailed);
        const grouped = groupAssignableContent({
          places: bundle.places,
          photos: bundle.photos,
          notes: bundle.notes,
          day,
          userId,
        });
        groups = grouped.groups;
        if (!selectionReady) {
          selectedPhotos = grouped.selectedPhotoIds;
          selectedNotes = grouped.selectedNoteIds;
          if (!contentLoadFailed) selectionReady = true;
        }
        const photos = groups.flatMap((group) => group.photos);
        let thumbs = {};
        try {
          thumbs = await resolveThumbUrlMap(photos, new Set(photos.map((photo) => photo.id)));
        } catch {
          thumbs = {};
        }
        if (settled) return;
        paintStep2(thumbs);
      } catch {
        if (settled) return;
        bundle = { places: [], photos: [], notes: [], loadFailed: true };
        contentLoadFailed = true;
        groups = [];
        paintStep2({});
      }
    }

    async function savePlaceOnly() {
      if (saving) return;
      const ts = timestampForDayTime(day, timeValue);
      if (ts == null) return;
      saving = true;
      nameValue = sheet.querySelector('[data-testid="add-place-name"]')?.value ?? nameValue;
      const button = sheet.querySelector('[data-testid="add-place-only"]');
      const next = sheet.querySelector('[data-testid="add-place-next"]');
      if (button) button.disabled = true;
      if (next) next.disabled = true;
      try {
        const result = await commitBackfilledPlace({
          vacationId,
          day,
          lat,
          lng,
          name: nameValue.trim(),
          ts,
          photos: [],
          notes: [],
        });
        if (settled) return;
        savedResult = { status: "saved", ...result };
        closeFlow();
      } catch (err) {
        saving = false;
        if (settled) return;
        syncTimeHint();
        showWarnToast(addPlaceErrorMessage(err));
      }
    }

    async function onSave() {
      if (saving) return;
      saving = true;
      const button = sheet.querySelector('[data-testid="add-media-save"]');
      if (button) button.disabled = true;
      const ts = timestampForDayTime(day, timeValue);
      try {
        const photos = [];
        const notes = [];
        for (const group of groups) {
          for (const photo of group.photos) {
            if (selectedPhotos.has(photo.id) && mediaOwnedBy(photo, userId)) photos.push(photo);
          }
          for (const note of group.notes) {
            if (selectedNotes.has(note.id) && noteOwnedBy(note, userId)) notes.push(note);
          }
        }
        const result = await commitBackfilledPlace({
          vacationId,
          day,
          lat,
          lng,
          name: nameValue.trim(),
          ts,
          photos,
          notes,
        });
        if (settled) return;
        savedResult = { status: "saved", ...result };
        closeFlow();
      } catch (err) {
        saving = false;
        if (settled) return;
        if (button?.isConnected) button.disabled = false;
        showWarnToast(addPlaceErrorMessage(err));
      }
    }

    paintStep1();
    activeClose = bindOverlay(overlay, domClose);
    bindSheetPull(sheet, { onClose: closeFlow, scrollEl: sheet });
    reverseGeocodeDetails(lat, lng, { signal: geocodeAbort.signal })
      .then((details) => {
        if (settled) return;
        suggestion = details?.suggestion || "";
        geocodeStatus = details?.name ? "ready" : "failed";
        if (!nameDirty && details?.name) nameValue = details.name;
        if (step === 1) applyNameDom();
      })
      .catch((err) => {
        if (settled || err?.name === "AbortError") return;
        geocodeStatus = "failed";
        if (step === 1) applyNameDom();
      });
  });
}
