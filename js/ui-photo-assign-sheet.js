import { dayChipDateLine } from "./days.js";
import { formatTimeFromTs } from "./geo.js";
import { bindOverlay, closeOverlayHistory } from "./overlay-stack.js";
import {
  fotoCountLabel,
  groupSubtitle,
  groupTitle,
  mergeAssignableGroups,
  otherDayLabel,
  otherDaySummary,
} from "./photo-assign.js";
import { openPhotoTargetSheet } from "./ui-photo-target-sheet.js";
import { escapeHtml } from "./utils.js";

function thumbStack(urls) {
  const shown = urls.slice(0, 3);
  return `<div class="assign-thumbs" aria-hidden="true">${shown
    .map((src, i) => `<img src="${escapeHtml(src)}" alt="" style="z-index:${shown.length - i}" />`)
    .join("")}</div>`;
}

/**
 * Sheet «N Fotos zuordnen». Löst mit { type: "upload", groups }, { type: "keep" } oder { type: "cancel" }.
 */
export function openPhotoAssignSheet({
  groups,
  filesByKey,
  activeDay,
  vacation,
  selectedPlace,
  dayPlaces,
  namesReady = null,
}) {
  const overlay = document.getElementById("overlay-root");
  if (!overlay) return Promise.resolve({ type: "cancel" });
  let current = mergeAssignableGroups(groups);
  const urls = [];
  const urlFor = (key) => {
    const file = filesByKey.get(key);
    if (!file) return "";
    const url = URL.createObjectURL(file);
    urls.push(url);
    return url;
  };
  const keyUrls = new Map();
  for (const key of filesByKey.keys()) keyUrls.set(key, urlFor(key));

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
      resolve(value);
    };

    overlay.hidden = false;
    overlay.classList.add("overlay-root--bleed");
    const count = current.reduce((sum, group) => sum + group.photoKeys.length, 0);
    const selectedName = selectedPlace?.name || "Ohne Ort";

    const closeDom = () => {
      overlay.classList.remove("overlay-root--bleed");
      overlay.hidden = true;
      overlay.innerHTML = "";
    };

    function optionsFor(group) {
      const options = [];
      const places = dayPlaces(group.day);
      if (group.suggested || group.kind === "new") {
        const suggested = group.suggested || {
          name: group.name,
          ts: group.ts || Date.now(),
          lat: group.lat,
          lng: group.lng,
        };
        options.push({
          key: "new",
          kind: "new",
          title: `Neue Karte «${suggested.name}»`,
          sub: `Name aus Standort · ${formatTimeFromTs(suggested.ts || group.ts || Date.now())}`,
          selected: group.kind === "new",
          suggested,
        });
      }
      for (const place of places) {
        const isSelected = place.id === selectedPlace?.id;
        options.push({
          key: place.id,
          kind: "place",
          place,
          title: place.name,
          sub: isSelected
            ? `ausgewählte Karte · ${formatTimeFromTs(place.ts)}`
            : formatTimeFromTs(place.ts),
          selected: group.kind === "place" && group.place?.id === place.id,
        });
      }
      if (selectedPlace && !places.some((p) => p.id === selectedPlace.id)) {
        options.push({
          key: selectedPlace.id,
          kind: "place",
          place: selectedPlace,
          title: selectedPlace.name,
          sub: `ausgewählte Karte · ${formatTimeFromTs(selectedPlace.ts)}`,
          selected: group.kind === "place" && group.place?.id === selectedPlace.id,
        });
      }
      options.push({
        key: "ohne",
        kind: "ohne",
        title: "Ohne Ort",
        sub: "keine Karte, nur der Tag",
        selected: group.kind === "ohne",
      });
      return options;
    }

    function applyChoice(group, choice) {
      if (!choice) return;
      if (choice.kind === "new") {
        const suggested = choice.suggested || group.suggested;
        group.kind = "new";
        group.place = null;
        group.name = suggested?.name || group.name;
        group.lat = suggested?.lat ?? group.lat;
        group.lng = suggested?.lng ?? group.lng;
        group.suggested = suggested;
        group.ohneGps = false;
      } else if (choice.kind === "ohne") {
        group.kind = "ohne";
        group.place = null;
        group.name = "Ohne Ort";
      } else if (choice.place) {
        group.kind = "place";
        group.place = choice.place;
        group.name = choice.place.name;
        group.day = choice.place.day || choice.place.dayDate || group.day;
      }
      current = mergeAssignableGroups(current);
    }

    function render() {
      const notes = otherDaySummary(current, activeDay);
      overlay.innerHTML = `
        <div class="sheet sheet--assign" data-testid="photo-assign-sheet" role="dialog" aria-modal="true">
          <div class="sheet-handle" aria-hidden="true"></div>
          <div class="sheet__header sheet__header--photo-upload">
            <h2 class="sheet__title">${escapeHtml(fotoCountLabel(count))} zuordnen</h2>
            <button type="button" class="sheet__close" data-action="close" aria-label="Schließen">×</button>
          </div>
          <p class="assign-sheet__lead">${escapeHtml(dayChipDateLine(activeDay))} · nach Standort der Fotos</p>
          ${
            notes.length
              ? `<p class="assign-sheet__daynote" data-testid="photo-assign-other-day">${escapeHtml(notes.join(" · "))}</p>`
              : ""
          }
          <div class="assign-sheet__list">
            ${current
              .map((group) => {
                const dayLine = otherDayLabel(vacation, group.day, activeDay);
                const thumbs = group.photoKeys.map((key) => keyUrls.get(key)).filter(Boolean);
                const neue = group.kind === "new";
                return `
                <article class="assign-group${neue ? " assign-group--new" : ""}" data-group-id="${escapeHtml(group.id)}" data-testid="photo-assign-group">
                  <div class="assign-group__main">
                    ${thumbStack(thumbs)}
                    <div class="assign-group__text">
                      <div class="assign-group__kicker">${escapeHtml(fotoCountLabel(group.photoKeys.length, { ohneGps: group.ohneGps && group.kind !== "new" }))} →</div>
                      <div class="assign-group__title">${escapeHtml(groupTitle(group))}</div>
                      <div class="assign-group__sub">${escapeHtml(groupSubtitle(group, { activeDay, selectedPlaceId: selectedPlace?.id }))}</div>
                      ${dayLine ? `<div class="assign-group__day">${escapeHtml(dayLine)}</div>` : ""}
                    </div>
                  </div>
                  <button type="button" class="assign-group__change" data-action="change" data-group-id="${escapeHtml(group.id)}">Ändern</button>
                </article>`;
              })
              .join("")}
          </div>
          <div class="assign-sheet__actions">
            <button type="button" class="btn btn-emaille btn-emaille--block" data-action="upload" data-testid="photo-assign-upload">${escapeHtml(fotoCountLabel(count))} hochladen</button>
            <button type="button" class="link-btn assign-sheet__keep" data-action="keep" data-testid="photo-assign-keep">Alle auf «${escapeHtml(selectedName)}» ablegen</button>
          </div>
        </div>`;
      bindActions();
    }

    let activeClose = null;
    function closeWithoutUpload() {
      const close = activeClose;
      activeClose = null;
      if (close) closeOverlayHistory(close);
      else closeDom();
      finish({ type: "cancel" });
    }
    function bindActions() {
      overlay.querySelector('[data-action="close"]')?.addEventListener("click", () => {
        closeWithoutUpload();
      });
      overlay.querySelector('[data-action="upload"]')?.addEventListener("click", () => {
        const close = activeClose;
        activeClose = null;
        if (close) closeOverlayHistory(close);
        else closeDom();
        finish({ type: "upload", groups: current });
      });
      overlay.querySelector('[data-action="keep"]')?.addEventListener("click", () => {
        const close = activeClose;
        activeClose = null;
        if (close) closeOverlayHistory(close);
        else closeDom();
        finish({ type: "keep" });
      });
      overlay.querySelectorAll('[data-action="change"]').forEach((btn) => {
        btn.addEventListener("click", async () => {
          const group = current.find((item) => item.id === btn.dataset.groupId);
          if (!group) return;
          const thumbs = group.photoKeys.map((key) => keyUrls.get(key)).filter(Boolean);
          const choice = await openPhotoTargetSheet({
            title: `Ziel für ${fotoCountLabel(group.photoKeys.length)}`,
            thumbs,
            options: optionsFor(group),
          });
          if (!choice || settled) return;
          applyChoice(group, choice);
          render();
        });
      });
    }

    render();
    if (namesReady) {
      void Promise.resolve(namesReady).then((updates) => {
        if (settled || !updates) return;
        let changed = false;
        for (const update of updates) {
          if (!update?.name) continue;
          for (const group of current) {
            if (group.id !== update.id) continue;
            group.name = update.name;
            if (group.suggested) group.suggested.name = update.name;
            changed = true;
          }
        }
        if (changed) render();
      });
    }
    activeClose = bindOverlay(overlay, closeDom, () => {
      closeWithoutUpload();
    });
  });
}

export function refreshAssignNames(groups, namesById) {
  for (const group of groups) {
    const name = namesById.get(group.id);
    if (!name) continue;
    group.name = name;
    if (group.suggested) group.suggested.name = name;
  }
}
