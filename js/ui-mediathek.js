import { getMediaBySourceKey, getVacation } from "./db.js";
import { dayIndexInTrip, dayRoleLabel, vacationDays } from "./days.js";
import {
  createPhotoThumbFromFile,
  formatMediaDuration,
  processVideoFile,
} from "./media-process.js";
import {
  buildMediaSourceKey,
  formatAddedToast,
  formatBytesShort,
} from "./media-source.js";
import {
  clearMediathekSession,
  getMediathekSession,
  setMediathekPlace,
} from "./mediathek-session.js";
import { savePhotoForPlace, saveVideoForPlace } from "./media-service.js";
import {
  abandonOverlayHistory,
  closeOverlayHistory,
  openOverlayHistory,
} from "./overlay-stack.js";
import { navigate } from "./router.js";
import {
  getOrCreateOhneOrtPlace,
  resolveMediathekTarget,
} from "./target-place.js";
import { showToast } from "./toast.js";
import { openMediathekPlaceSheet } from "./ui-mediathek-place-sheet.js";
import { setTripSelection } from "./ui-urlaub-detail.js";

const PLAY_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
const PIN_RED = `<svg width="14" height="14" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 2.8c-5.8 0-10 4.3-10 9.7 0 6.9 10 15.7 10 15.7s10-8.8 10-15.7c0-5.4-4.2-9.7-10-9.7z" fill="#d4523e"/><circle cx="16" cy="12.6" r="3.8" fill="#fff"/></svg>`;

function placeBarLine(vacation, day, place, ohneOrtPending) {
  const total = vacationDays(vacation).length;
  const idx = dayIndexInTrip(vacation, day);
  const role = dayRoleLabel(idx, total);
  const name = ohneOrtPending || !place ? "Neuer Ort (Ohne Ort)" : place.name;
  return `${name} · ${role}`;
}

function addButtonLabel(count) {
  if (count <= 0) return "Fotos auswählen";
  return `+ ${count} hinzufügen`;
}

export async function renderMediathekScreen(appEl, vacationId) {
  const session = getMediathekSession();
  if (!session || session.vacationId !== vacationId) {
    navigate({ name: "urlaub-detail", id: vacationId }, { replace: true });
    return;
  }

  const vacation = await getVacation(vacationId);
  if (!vacation) {
    clearMediathekSession();
    navigate({ name: "urlaube" }, { replace: true });
    return;
  }

  const target = await resolveMediathekTarget({
    vacationId,
    day: session.day,
    selectedPlaceId: session.selectedPlaceId,
  });
  if (target.place) {
    setMediathekPlace(target.place, { ohneOrtPending: false });
  } else {
    setMediathekPlace(null, { ohneOrtPending: true });
  }

  appEl.className = "screen screen--mediathek";
  appEl.dataset.testid = "mediathek-screen";

  const closeWithoutSave = () => {
    if (!getMediathekSession()) return;
    clearMediathekSession();
    navigate({ name: "urlaub-detail", id: vacationId }, { replace: true });
  };

  openOverlayHistory(closeWithoutSave);

  function render() {
    const s = getMediathekSession();
    if (!s) return;

    const selectedItems = s.selectedIds
      .map((id) => s.items.find((i) => i.id === id))
      .filter(Boolean);
    const totalBytes = selectedItems.reduce((sum, i) => sum + (i.file.size || 0), 0);
    const progress = s.progressLabel || "";

    appEl.innerHTML = `
      <header class="mediathek-header">
        <button type="button" class="mediathek-header__cancel" data-action="cancel">Abbrechen</button>
        <h1 class="mediathek-header__title">Mediathek</h1>
        <span class="mediathek-header__spacer" aria-hidden="true"></span>
      </header>
      <div class="mediathek-grid" data-role="grid"></div>
      <footer class="mediathek-bar">
        <p class="mediathek-bar__meta" data-role="meta"></p>
        <div class="mediathek-bar__place">
          <span class="mediathek-bar__pin">${PIN_RED}</span>
          <span class="mediathek-bar__place-text" data-role="place-line"></span>
          <button type="button" class="mediathek-bar__change" data-action="change-place">Ändern</button>
        </div>
        <button type="button" class="btn btn-emaille btn-emaille--block mediathek-bar__add" data-action="add" ${
          selectedItems.length === 0 || s.saving ? "disabled" : ""
        }>${progress || addButtonLabel(selectedItems.length)}</button>
      </footer>
    `;

    const grid = appEl.querySelector('[data-role="grid"]');
    grid.innerHTML = s.items
      .map((item) => {
        const selIdx = s.selectedIds.indexOf(item.id);
        const selected = selIdx >= 0;
        const bg = item.thumbUrl ? `style="background-image:url('${item.thumbUrl}')"` : "";
        const video =
          item.type === "video"
            ? `<span class="mediathek-tile__play">${PLAY_SVG}</span><span class="mediathek-tile__dur">${item.durationLabel || ""}</span>`
            : "";
        const badge = selected
          ? `<span class="mediathek-tile__badge mediathek-tile__badge--on">${selIdx + 1}</span>`
          : `<span class="mediathek-tile__badge"></span>`;
        return `<button type="button" class="mediathek-tile${selected ? " mediathek-tile--selected" : ""}" data-item-id="${item.id}" ${bg} aria-pressed="${selected}">${badge}${video}</button>`;
      })
      .join("");

    const meta = appEl.querySelector('[data-role="meta"]');
    if (selectedItems.length) {
      meta.textContent = `${selectedItems.length} AUSGEWÄHLT · ${formatBytesShort(totalBytes)}`;
    } else {
      meta.textContent = "0 AUSGEWÄHLT";
    }

    appEl.querySelector('[data-role="place-line"]').textContent = placeBarLine(
      vacation,
      s.day,
      s.place,
      s.ohneOrtPending
    );

    appEl.querySelector('[data-action="cancel"]').onclick = () =>
      closeOverlayHistory(closeWithoutSave);
    appEl.querySelector('[data-action="change-place"]').onclick = () => {
      openMediathekPlaceSheet({
        vacationId,
        day: s.day,
        onSelect: ({ place, ohneOrtPending }) => {
          setMediathekPlace(place, { ohneOrtPending });
          render();
        },
      });
    };

    grid.querySelectorAll("[data-item-id]").forEach((btn) => {
      btn.addEventListener("click", () => toggleSelection(btn.dataset.itemId));
    });

    appEl.querySelector('[data-action="add"]').onclick = () => saveSelected();
  }

  function toggleSelection(itemId) {
    const s = getMediathekSession();
    if (!s || s.saving) return;
    const idx = s.selectedIds.indexOf(itemId);
    if (idx >= 0) s.selectedIds.splice(idx, 1);
    else s.selectedIds.push(itemId);
    render();
  }

  async function saveSelected() {
    const s = getMediathekSession();
    if (!s || s.saving) return;
    const selected = s.selectedIds
      .map((id) => s.items.find((i) => i.id === id))
      .filter(Boolean);
    if (!selected.length) return;

    s.saving = true;
    let place = s.place;
    if (s.ohneOrtPending || !place) {
      const created = await getOrCreateOhneOrtPlace({
        vacationId,
        day: s.day,
        showToastOnCreate: true,
      });
      place = created.place;
    }

    let skipped = 0;
    let photos = 0;
    let videos = 0;
    let quotaHit = false;

    for (let i = 0; i < selected.length; i++) {
      s.progressLabel = `Wird gespeichert… ${i + 1}/${selected.length}`;
      render();
      const item = selected[i];
      const sourceKey = buildMediaSourceKey(item.file);
      if (await getMediaBySourceKey(vacationId, sourceKey)) {
        skipped += 1;
        continue;
      }
      const ts = item.file.lastModified || Date.now();
      try {
        if (item.type === "video") {
          await saveVideoForPlace({
            file: item.file,
            place,
            vacationId,
            day: s.day,
            ts,
            sourceKey,
          });
          videos += 1;
        } else {
          await savePhotoForPlace({
            file: item.file,
            place,
            vacationId,
            day: s.day,
            ts,
            sourceKey,
          });
          photos += 1;
        }
      } catch (err) {
        if (err?.quota) {
          quotaHit = true;
          showToast("Speicher voll – nichts gespeichert");
          break;
        }
        throw err;
      }
      await new Promise((r) => setTimeout(r, 0));
    }

    s.saving = false;
    s.progressLabel = "";
    if (quotaHit) {
      render();
      return;
    }

    const day = s.day;
    clearMediathekSession();
    abandonOverlayHistory();
    setTripSelection(vacationId, day, place.id);
    navigate({ name: "urlaub-detail", id: vacationId }, { replace: true });

    const toastParts = [];
    if (photos || videos) toastParts.push(formatAddedToast({ photos, videos }));
    if (skipped > 0) {
      toastParts.push(`${skipped} schon vorhanden übersprungen`);
    }
    if (toastParts.length) showToast(toastParts.join(" · "));
    window.dispatchEvent(new CustomEvent("vacrecap:data-changed"));
  }

  render();
  void prepareThumbs(session, () => render());

}

async function prepareThumbs(session, onUpdate) {
  for (const item of session.items) {
    try {
      if (item.type === "video") {
        const v = await processVideoFile(item.file);
        item.thumbUrl = URL.createObjectURL(v.thumbBlob);
        item.durationLabel = v.durationLabel || formatMediaDuration(v.duration);
      } else {
        const thumbBlob = await createPhotoThumbFromFile(item.file);
        item.thumbUrl = URL.createObjectURL(thumbBlob);
      }
      item.ready = true;
      onUpdate();
    } catch {
      item.ready = true;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}
